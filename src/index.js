// Version gate for the Aether Lua hub.
//
// POST { rev, build, device, token?, seed?, nonce?, bits? }
//   -> { update, rev, build, notes, loader, forced, token }
//
// The device never decides whether an update exists; it reports the rev it runs.
// This Worker reads version.json from the Aether repo, compares, and answers.
//
// Ordering note: an attacker costs one invocation the moment they arrive, so the
// guards run cheapest-first and reject before any crypto or storage work. See
// src/token.js for why a device-scoped limit cannot work - the device string is
// attacker-chosen and rotating it is free.

import { LIMITS, clientIp } from "./limits.js";
import { mintToken, verifyToken, sha256Hex } from "./token.js";
import { makeChallenge, checkWork } from "./pow.js";
import { handleAnnouncements, handlePublish } from "./announce.js";
import { handleRelease, handleReleasePublish, readRelease } from "./release.js";

const REPO = "0craxy0/Aether";
const BRANCH = "main";
const VERSION_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/version.json`;
const EDGE_TTL = 60;
const MAX_BODY = 2048;

export default {
	async fetch(request, env) {
		const now = Date.now();

		// ── layer 0: shape. no bindings, no crypto ──
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

		// Announcements are a public read and a token-authenticated write, and they
		// share this deployment so there is one origin to trust instead of two.
		const path = new URL(request.url).pathname;
		if (path === "/announcements") {
			if (request.method !== "GET") return json({ error: "GET required" }, 405);
			return handleAnnouncements(env);
		}
		if (path === "/announce") {
			if (request.method !== "POST") return json({ error: "POST required" }, 405);
			return handlePublish(request, env);
		}
		if (path === "/release") {
			if (request.method === "GET") return handleRelease(env);
			if (request.method === "POST") return handleReleasePublish(request, env);
			return json({ error: "GET or POST required" }, 405);
		}

		if (request.method !== "POST") return json({ error: "POST required" }, 405);
		if (Number(request.headers.get("content-length") || 0) > MAX_BODY) {
			return json({ error: "body too large" }, 413);
		}

		const ip = clientIp(request);

		// ── layer 1: counters ──
		const gate = await rateCheck(env, ip, now);
		if (!gate.ok) return json({ error: "slow down", retry: gate.retry }, 429, { "retry-after": String(gate.retry) });

		// ── layer 2: payload ──
		let body;
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (body === null || typeof body !== "object") return json({ error: "invalid json" }, 400);

		// ── layer 3: identity ──
		// A valid token means this IP has proven itself before and skips the puzzle.
		const secret = env.HMAC_SECRET;
		const trusted = typeof body.token === "string" && (await verifyToken(secret, body.token, ip, now));
		if (!trusted) {
			const solved = await checkWork(sha256Hex, String(body.seed ?? ""), Number(body.nonce), Number(body.bits));
			const expected = makeChallenge(ip, now);
			// the caller must solve *this* IP's current challenge, not any old one
			const rightSeed = body.seed === expected.seed;
			if (!solved || !rightSeed) {
				return json({ error: "challenge required", seed: expected.seed, bits: expected.bits }, 401);
			}
		}

		// ── the actual work ──
		let ver;
		try {
			const res = await fetch(VERSION_URL, { cf: { cacheTtl: EDGE_TTL, cacheEverything: true } });
			if (!res.ok) return json({ error: `upstream ${res.status}` }, 502);
			ver = await res.json();
		} catch {
			return json({ error: "upstream unreachable" }, 502);
		}

		const latest = Number(ver.rev) || 0;
		if (!latest) return json({ error: "bad version.json" }, 500);

		const token = await mintToken(secret, ip, now);
		const clientRev = Number(body.rev) || 0;

		if (clientRev >= latest) {
			return json({ token, update: false, rev: latest, build: ver.build });
		}

		const forced = clientRev < (Number(ver.minRev) || 0);
		const rollout = Number.isFinite(Number(ver.rollout)) ? Number(ver.rollout) : 100;
		const device = String(body.device ?? "").slice(0, 64);

		if (!forced && hash(device) % 100 >= rollout) {
			return json({ token, update: false, rev: latest, build: ver.build, wave: hash(device) % 100 });
		}

		// The wording of the prompt can come from the owner's panel; the rev never
		// can. A rev is a promise that fetching main.lua returns that build, and only
		// a commit can make that true - so a published record decorates the prompt
		// here, and is ignored unless it is tagged with the rev actually being served.
		const release = await readRelease(env);
		const decorate = Boolean(release && (!release.rev || release.rev === latest));

		return json({
			token,
			update: true,
			rev: latest,
			build: ver.build,
			title: decorate ? release.title : "Update available",
			notes: decorate ? release.notes : String(ver.notes ?? "").slice(0, 300),
			loader: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/main.lua`,
			forced,
			cooldown: 300,
		});
	},
};

// Fails open on purpose: an update check that stops working strands every user on
// an old build, which is worse than briefly losing the guard.
async function rateCheck(env, ip, now) {
	if (!env.LIMITER) return { ok: true };
	try {
		const perIp = env.LIMITER.get(env.LIMITER.idFromName("ip:" + ip));

		for (const [key, window, limit] of [
			["m", 60, LIMITS.ipPerMinute],
			["h", 3600, LIMITS.ipPerHour],
		]) {
			const r = await perIp
				.fetch("https://do/hit", { method: "POST", body: JSON.stringify({ key, window, limit, now }) })
				.then((x) => x.json());
			if (!r.allowed) return { ok: false, retry: Math.max(1, Math.ceil((r.reset - now) / 1000)) };
		}

		const global = env.LIMITER.get(env.LIMITER.idFromName("global"));
		const g = await global
			.fetch("https://do/hit", { method: "POST", body: JSON.stringify({ key: "m", window: 60, limit: LIMITS.globalPerMinute, now }) })
			.then((x) => x.json());
		if (!g.allowed) return { ok: false, retry: Math.max(1, Math.ceil((g.reset - now) / 1000)) };

		return { ok: true };
	} catch {
		return { ok: true };
	}
}

function hash(input) {
	let h = 2166136261;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function corsHeaders() {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "content-type, authorization",
	};
}

function json(obj, status = 200, extra = {}) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(), ...extra },
	});
}

export { Limiter } from "./limiter.js";
