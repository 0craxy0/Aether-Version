// Announcements: one-way notes from the owner to every running client.
//
//   GET  /announcements  -> { items: [{ id, text, kind? }] }   public
//   POST /announce       -> publish or clear                     owner only
//
// The client only ever *reads text*. There is no command, no target id and no
// action in the payload, so a note cannot make a client do anything. That is why
// this half can be public while the version gate needs a puzzle.
//
// Two storage backends, picked by which binding exists, so neither has to be
// provisioned before the endpoint works:
//
//   ANNOUNCEMENTS (KV)     preferred. Publishing is a single write and is visible
//                          to every client on its next poll.
//   GITHUB_TOKEN (secret)  fallback. Publishing commits announcements.json, so
//                          there is a history and the raw file the client falls
//                          back to is always the same bytes this endpoint serves.
//
// With neither, GET still works by proxying the raw file: an unconfigured
// deployment is a working read-only endpoint, not a broken one.

const REPO = "0craxy0/Aether";
const BRANCH = "main";
const PATH = "announcements.json";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${PATH}`;
const CONTENTS = `https://api.github.com/repos/${REPO}/contents/${PATH}`;
const KV_KEY = "announcements";

const MAX_TEXT = 220; // a notice, not an essay
const MAX_ITEMS = 5; // and not a wall of them
const MAX_BODY = 4096;
const EDGE_TTL = 10; // seconds; lets clients poll quickly without hitting GitHub
const PUBLISH_GAP_MS = 3000;

let lastPublishAt = 0; // per isolate, best effort - a human publishes, a bot would not get far

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(obj, status = 200, extra = {}) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"access-control-allow-origin": "*",
			...extra,
		},
	});
}

// Length-independent compare: a plain === leaks the shared prefix length through
// timing to anyone who can measure the response.
function safeEqual(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function b64(text) {
	const bytes = encoder.encode(text);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	}
	return btoa(bin);
}

function fromB64(text) {
	const bin = atob(String(text).replace(/\s/g, ""));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return decoder.decode(bytes);
}

// Rich text is rendered by the client's toast, so tags are stripped here rather
// than trusted to arrive well-formed.
function cleanText(value) {
	let text = String(value ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
	if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1) + "…";
	return text;
}

function normalize(item) {
	if (!item || typeof item !== "object") return null;
	const text = cleanText(item.text);
	if (!text) return null;
	const out = { id: typeof item.id === "string" ? item.id.slice(0, 64) : "", text };
	if (item.kind === "good" || item.kind === "bad") out.kind = item.kind;
	return out;
}

function normalizeList(value) {
	return Array.isArray(value) ? value.map(normalize).filter(Boolean).slice(-MAX_ITEMS) : [];
}

// ── GitHub backend ────────────────────────────────────────────────
async function readGithub(token) {
	const res = await fetch(CONTENTS, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"user-agent": "aether-announce",
		},
		cache: "no-store",
	});
	if (res.status === 404) return { items: [], sha: null };
	if (!res.ok) throw new Error(`github ${res.status}`);
	const data = await res.json();
	let items = [];
	try {
		items = normalizeList(JSON.parse(fromB64(data.content || "")).items);
	} catch {
		// a malformed file gets replaced, not treated as fatal
	}
	return { items, sha: data.sha || null };
}

async function writeGithub(token, items, message) {
	const current = await readGithub(token);
	const body = {
		message,
		content: b64(JSON.stringify({ items }, null, 2) + "\n"),
		branch: BRANCH,
	};
	if (current.sha) body.sha = current.sha;
	const res = await fetch(CONTENTS, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"content-type": "application/json",
			"user-agent": "aether-announce",
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`github ${res.status}`);
}

// ── storage ───────────────────────────────────────────────────────
function backend(env) {
	if (env.ANNOUNCEMENTS) return "kv";
	if (env.GITHUB_TOKEN) return "github";
	return null;
}

async function readStore(env) {
	const kind = backend(env);
	if (kind === "kv") {
		const raw = await env.ANNOUNCEMENTS.get(KV_KEY);
		if (!raw) return [];
		try {
			return normalizeList(JSON.parse(raw).items);
		} catch {
			return [];
		}
	}
	if (kind === "github") return (await readGithub(env.GITHUB_TOKEN)).items;
	return null;
}

async function writeStore(env, items, message) {
	const kind = backend(env);
	if (kind === "kv") {
		await env.ANNOUNCEMENTS.put(KV_KEY, JSON.stringify({ items }));
		return;
	}
	if (kind === "github") {
		await writeGithub(env.GITHUB_TOKEN, items, message);
		return;
	}
	throw new Error("no storage binding");
}

// ── GET /announcements ────────────────────────────────────────────
export async function handleAnnouncements(env = {}) {
	try {
		const items = await readStore(env);
		if (items) return json({ items }, 200, { "cache-control": "public, max-age=10" });

		// unconfigured: serve the committed file so the endpoint is still useful
		const res = await fetch(RAW, { cf: { cacheTtl: EDGE_TTL, cacheEverything: true } });
		if (!res.ok) return json({ items: [] });
		const data = await res.json();
		return json({ items: normalizeList(data?.items) }, 200, { "cache-control": "public, max-age=10" });
	} catch {
		// an empty list reads as "nothing to say", never as a broken client
		return json({ items: [] });
	}
}

// ── POST /announce ────────────────────────────────────────────────
export async function handlePublish(request, env = {}) {
	const secret = env.PUBLISH_TOKEN;
	if (!secret) return json({ error: "publishing not configured" }, 501);
	if (!backend(env)) return json({ error: "no storage configured (ANNOUNCEMENTS or GITHUB_TOKEN)" }, 501);

	const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
	if (!safeEqual(given, secret)) return json({ error: "unauthorized" }, 401);

	if (Number(request.headers.get("content-length") || 0) > MAX_BODY) {
		return json({ error: "body too large" }, 413);
	}

	const now = Date.now();
	const gap = Number(env.PUBLISH_GAP_MS ?? PUBLISH_GAP_MS);
	if (Number.isFinite(gap) && now - lastPublishAt < gap) return json({ error: "slow down" }, 429);
	lastPublishAt = now;

	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400);

	let items;
	if (body.clear === true) {
		items = [];
	} else if (Array.isArray(body.items)) {
		items = normalizeList(body.items);
		if (!items.length) return json({ error: "nothing to publish" }, 400);
	} else {
		const item = normalize({ id: body.id, text: body.text, kind: body.kind });
		if (!item) return json({ error: `text required (1-${MAX_TEXT} chars)` }, 400);
		let current;
		try {
			current = (await readStore(env)) || [];
		} catch (e) {
			return json({ error: String(e?.message || e) }, 502);
		}
		if (!item.id) item.id = new Date(now).toISOString();
		const kept = current.filter((old) => old.id !== item.id); // republishing an id replaces it
		items = kept.concat([item]).slice(-MAX_ITEMS);
	}

	const message = items.length ? `announce: ${items[items.length - 1].text.slice(0, 60)}` : "announce: clear";
	try {
		await writeStore(env, items, message);
	} catch (e) {
		return json({ error: String(e?.message || e) }, 502);
	}

	return json({ ok: true, items });
}
