// Version gate for the Aether Lua hub.
//
// POST { rev, build, device } -> { update, rev, build, notes, loader, forced }
//
// The device never decides whether an update exists; it only reports the rev it
// is running. This Worker reads version.json straight off the Aether repo,
// compares the two, and answers. Keeping the comparison server-side means a
// broken build can be pulled without editing anything the client already cached.

const REPO = "0craxy0/Aether";
const BRANCH = "main";
const VERSION_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/version.json`;

// How long an edge colo may reuse the GitHub response. Without this, every ping
// from every device hits raw.githubusercontent. With it, GitHub is read at most
// once per minute per colo, which is what keeps this inside the free tier.
const EDGE_TTL = 60;

export default {
	async fetch(request) {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}
		if (request.method !== "POST") {
			return json({ error: "POST required" }, 405);
		}

		let body = {};
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}

		const clientRev = Number(body.rev) || 0;
		const device = String(body.device || "").slice(0, 64);

		let ver;
		try {
			const res = await fetch(VERSION_URL, {
				cf: { cacheTtl: EDGE_TTL, cacheEverything: true },
			});
			if (!res.ok) return json({ error: `upstream ${res.status}` }, 502);
			ver = await res.json();
		} catch {
			return json({ error: "upstream unreachable" }, 502);
		}

		const latest = Number(ver.rev) || 0;
		if (!latest) return json({ error: "bad version.json" }, 500);

		// Never downgrade, never re-offer a rev the client already has.
		if (clientRev >= latest) {
			return json({ update: false, rev: latest, build: ver.build });
		}

		// Kill switch. A build below minRev is force-updated and the client is
		// not allowed to dismiss the prompt, for when a push is actively broken.
		const minRev = Number(ver.minRev) || 0;
		const forced = clientRev < minRev;

		// Graduated rollout. Same device always lands in the same wave for a given
		// rev, so a half-verified change only reaches a slice of installs.
		const rollout = Number.isFinite(Number(ver.rollout)) ? Number(ver.rollout) : 100;
		if (!forced && hash(device) % 100 >= rollout) {
			return json({
				update: false,
				rev: latest,
				build: ver.build,
				wave: hash(device) % 100,
			});
		}

		return json({
			update: true,
			rev: latest,
			build: ver.build,
			notes: String(ver.notes || "").slice(0, 300),
			loader: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/main.lua`,
			forced,
			cooldown: 300,
		});
	},
};

// FNV-1a. Stable across deploys and cheap enough for a 10ms CPU budget.
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
		"access-control-allow-methods": "POST, OPTIONS",
		"access-control-allow-headers": "content-type",
	};
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: {
			"content-type": "application/json",
			// never let a device or an intermediary cache a decision
			"cache-control": "no-store",
			...corsHeaders(),
		},
	});
}
