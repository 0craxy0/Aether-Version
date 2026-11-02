// Fixed-window counters in a Durable Object.
//
// One instance per IP plus one shared `global` instance. Exact across every
// Cloudflare location, unlike the Rate Limiting binding, which is per-colo and
// would let a distributed attacker multiply their allowance by the number of
// colos they happen to hit.
//
// SQLite-backed so this runs on the Workers Free plan.

export class Limiter {
	constructor(state) {
		this.state = state;
		this.sql = state.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS hits (
			key TEXT PRIMARY KEY,
			window INTEGER NOT NULL,
			count INTEGER NOT NULL
		)`);
	}

	hit(key, windowSec, limit, now) {
		const window = Math.floor(now / 1000 / windowSec);
		const row = [...this.sql.exec("SELECT window, count FROM hits WHERE key = ?", key)][0];
		const reset = (window + 1) * windowSec * 1000;

		if (!row || row.window !== window) {
			this.sql.exec(
				"INSERT INTO hits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window = excluded.window, count = 1",
				key, window,
			);
			// anything from two windows back can never be read again
			this.sql.exec("DELETE FROM hits WHERE window < ?", window - 2);
			return { allowed: limit >= 1, count: 1, reset };
		}

		const count = row.count + 1;
		this.sql.exec("UPDATE hits SET count = ? WHERE key = ?", count, key);
		return { allowed: count <= limit, count, reset };
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname !== "/hit" || request.method !== "POST") {
			return new Response("not found", { status: 404 });
		}
		const body = await request.json();
		const out = this.hit(
			String(body.key).slice(0, 128),
			Number(body.window) || 60,
			Number(body.limit) || 60,
			Number(body.now) || Date.now(),
		);
		return Response.json(out);
	}
}
