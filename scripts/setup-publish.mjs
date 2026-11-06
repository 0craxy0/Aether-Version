#!/usr/bin/env node
// One-time setup for publishing announcements.
//
//   node scripts/setup-publish.mjs            create the KV namespace, set the secret
//   node scripts/setup-publish.mjs --rotate   mint a new publish token
//   node scripts/setup-publish.mjs --dry-run  show what would happen, change nothing
//
// What it does, in order:
//   1. confirms wrangler is logged in
//   2. finds or creates the ANNOUNCEMENTS KV namespace and writes its id into
//      wrangler.toml (idempotent - running twice does not make two namespaces)
//   3. mints a strong publish token, stores it in .aether-publish-token (gitignored)
//      and uploads it as the PUBLISH_TOKEN secret
//
// It never prints the token to the log; read the file when you need it.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOML = path.join(root, "wrangler.toml");
const TOKEN_FILE = path.join(root, ".aether-publish-token");
const BINDING = "ANNOUNCEMENTS";

const argv = new Set(process.argv.slice(2));
const DRY = argv.has("--dry-run");
const ROTATE = argv.has("--rotate");

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const say = (msg) => console.log(msg);
const die = (msg) => {
	console.error(`\n  ${msg}\n`);
	process.exit(1);
};

function wrangler(args, { input } = {}) {
	if (DRY) {
		say(`  [dry run] wrangler ${args.join(" ")}`);
		return { status: 0, stdout: "", stderr: "" };
	}
	const r = spawnSync(npx, ["wrangler", ...args], {
		cwd: root,
		encoding: "utf8",
		input,
		env: { ...process.env, CI: "1" }, // keep wrangler from waiting on prompts
	});
	return { status: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// ── 1. auth ──────────────────────────────────────────────────────
say("\n› checking wrangler");
{
	const r = wrangler(["whoami"]);
	if (!DRY && r.status !== 0) {
		die("wrangler is not logged in. Run `npx wrangler login`, then this again.");
	}
}

// ── 2. namespace ─────────────────────────────────────────────────
say("› looking for the KV namespace");
function listNamespaces() {
	const r = wrangler(["kv", "namespace", "list", "--json"]);
	if (r.status !== 0) return null;
	try {
		const parsed = JSON.parse(r.stdout);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null; // older wrangler: fall through to create-and-parse
	}
}

function findNamespace(list) {
	if (!list) return null;
	return list.find((ns) => String(ns.title || "").toUpperCase().includes(BINDING)) || null;
}

let ns = null;
if (!DRY) {
	ns = findNamespace(listNamespaces());
	if (!ns) {
		say("  none yet, creating one");
		const created = wrangler(["kv", "namespace", "create", BINDING]);
		if (created.status !== 0) die(`could not create the namespace:\n${created.stderr || created.stdout}`);
		ns = findNamespace(listNamespaces());
		if (!ns) {
			// last resort: the create command prints the id in a toml snippet
			const m = created.stdout.match(/"?id"?\s*[:=]\s*"?([0-9a-f]{32})"?/i);
			if (m) ns = { id: m[1], title: BINDING };
		}
		if (!ns) die("created the namespace but could not read its id. Run `npx wrangler kv namespace list` and paste it into wrangler.toml yourself.");
	}
	say(`  using ${ns.title} (${ns.id})`);
} else {
	ns = { id: "<dry-run-id>", title: BINDING };
}

// ── 3. wrangler.toml ─────────────────────────────────────────────
function upsertBinding(text, id) {
	const lines = text.split(/\r?\n/);
	const uncommented = lines.map((line) => {
		// the template ships these commented out; a real binding replaces them
		if (/^#\s*\[\[kv_namespaces\]\]\s*$/.test(line)) return null;
		if (/^#\s*binding\s*=\s*"ANNOUNCEMENTS"\s*$/.test(line)) return null;
		if (/^#\s*id\s*=\s*"<namespace id>"\s*$/.test(line)) return null;
		return line;
	}).filter((line) => line !== null);

	const block = `[[kv_namespaces]]\nbinding = "${BINDING}"\nid = "${id}"`;
	const at = uncommented.findIndex((line) => /^\[\[kv_namespaces\]\]\s*$/.test(line));
	if (at === -1) return `${uncommented.join("\n").trimEnd()}\n\n${block}\n`;

	// existing block: replace its id, leave everything else alone
	let end = at + 1;
	while (end < uncommented.length && !/^\s*\[/.test(uncommented[end])) end++;
	const body = uncommented.slice(at, end).map((line) => (/^\s*id\s*=/.test(line) ? `id = "${id}"` : line));
	return [...uncommented.slice(0, at), ...body, ...uncommented.slice(end)].join("\n");
}

{
	const before = readFileSync(TOML, "utf8");
	const after = upsertBinding(before, ns.id);
	if (after !== before) {
		if (!DRY) writeFileSync(TOML, after);
		say(`  wrangler.toml ${DRY ? "would be" : ""} updated with the binding`);
	} else {
		say("  wrangler.toml already has the binding");
	}
}

// ── 4. publish token ─────────────────────────────────────────────
say("› publish token");
let token = null;
if (!ROTATE && existsSync(TOKEN_FILE)) {
	token = readFileSync(TOKEN_FILE, "utf8").trim();
	say("  reusing the one in .aether-publish-token (pass --rotate to mint a new one)");
} else {
	token = randomBytes(32).toString("base64url");
	if (!DRY) {
		writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
		say(`  written to ${path.relative(root, TOKEN_FILE)} (gitignored)`);
	}
}

{
	const r = wrangler(["secret", "put", "PUBLISH_TOKEN"], { input: `${token}\n` });
	if (!DRY && r.status !== 0) {
		die(`could not set the secret:\n${r.stderr || r.stdout}\n\nThe token is in ${path.relative(root, TOKEN_FILE)}; you can set it by hand with:\n  npx wrangler secret put PUBLISH_TOKEN`);
	}
	say(`  PUBLISH_TOKEN ${DRY ? "would be" : ""} set`);
}

// ── 5. what next ─────────────────────────────────────────────────
const host = "<subdomain>.workers.dev";
say(`
done. next:

  npm run deploy

then publish a note from any machine that can read the token file:

  bash:
    TOKEN=$(cat .aether-publish-token)
    curl -X POST https://aether-version.${host}/announce \\
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
      -d '{"text":"Double XP this weekend.","kind":"good"}'

  powershell:
    $t = Get-Content .aether-publish-token
    Invoke-RestMethod -Method Post -Uri "https://aether-version.${host}/announce" \`
      -Headers @{ Authorization = "Bearer $t" } -ContentType "application/json" \`
      -Body '{"text":"Double XP this weekend.","kind":"good"}'

clear the list with {"clear":true}. clients pick it up within 15s.
`);
