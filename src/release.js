// Release notes: the wording of the update prompt, published from the owner's UI.
//
//   GET  /release  -> { release: { id, title, notes, rev?, build?, at } | null }
//   POST /release  -> publish or clear                          bearer PUBLISH_TOKEN
//
// version.json is still the only thing that can move `rev`: a rev without a
// matching commit would tell clients to restart into code that does not exist,
// and they would loop on the dialog forever. So this endpoint never touches
// rev - it decorates it. Two shapes:
//
//   rev == the latest rev   -> the update prompt for that build uses this title
//                             and these notes instead of version.json's.
//   no rev                  -> a standalone note. Clients already past that rev
//                             still see it once, as a card, rather than being
//                             told to update to what they are already running.
//
// Same storage as announcements (the ANNOUNCEMENTS namespace, one key), so a
// deploy that can publish announcements can publish this with no new binding.

const KV_KEY = "release";

const MAX_TITLE = 60;
const MAX_NOTES = 400;
const MAX_BODY = 2048;
const PUBLISH_GAP_MS = 3000;

let lastPublishAt = 0; // per isolate, best effort

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

function safeEqual(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// The dialog renders this as plain text, so tags are stripped here rather than
// trusted to survive the trip.
function clean(value, max) {
	const text = String(value ?? "")
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return "";
	return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function normalize(raw) {
	if (!raw || typeof raw !== "object") return null;
	const notes = clean(raw.notes, MAX_NOTES);
	if (!notes) return null;

	const at = clean(raw.at, 40) || new Date().toISOString();
	const out = {
		id: clean(raw.id, 64) || at,
		title: clean(raw.title, MAX_TITLE) || "Aether release",
		notes,
		at,
	};

	const rev = Number(raw.rev);
	if (Number.isFinite(rev) && rev > 0) out.rev = Math.floor(rev);

	const build = clean(raw.build, 40);
	if (build) out.build = build;

	return out;
}

export async function readRelease(env = {}) {
	if (!env.ANNOUNCEMENTS) return null;
	try {
		const raw = await env.ANNOUNCEMENTS.get(KV_KEY);
		if (!raw) return null;
		return normalize(JSON.parse(raw));
	} catch {
		return null;
	}
}

export async function handleRelease(env = {}) {
	return json({ release: await readRelease(env) });
}

export async function handleReleasePublish(request, env = {}) {
	const secret = env.PUBLISH_TOKEN;
	if (!secret) return json({ error: "publishing not configured" }, 501);
	if (!env.ANNOUNCEMENTS) return json({ error: "no storage configured (ANNOUNCEMENTS)" }, 501);

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

	if (body.clear === true) {
		await env.ANNOUNCEMENTS.delete(KV_KEY);
		return json({ ok: true, release: null });
	}

	const record = normalize(body);
	if (!record) return json({ error: `notes required (1-${MAX_NOTES} chars)` }, 400);

	try {
		await env.ANNOUNCEMENTS.put(KV_KEY, JSON.stringify(record));
	} catch (e) {
		return json({ error: String(e?.message || e) }, 502);
	}

	return json({ ok: true, release: record });
}
