// Drives the real fetch handler end to end with a stubbed GitHub response.
import worker from "../src/index.js";
import { checkWork } from "../src/pow.js";
import { sha256Hex } from "../src/token.js";

let pass = 0, fail = 0;
const ok = (c, n) => c ? (pass++, console.log("  ok  ", n)) : (fail++, console.log("  FAIL", n));

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
	if (String(url).includes("version.json")) {
		return new Response(JSON.stringify({ rev: 10, build: "t", minRev: 0, rollout: 100 }), { status: 200 });
	}
	return realFetch(url);
};

const env = { HMAC_SECRET: "test-secret" }; // no LIMITER: exercises the fail-open path
const post = (body, ip = "1.2.3.4", headers = {}) =>
	worker.fetch(new Request("https://x/", {
		method: "POST",
		headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
		body: JSON.stringify(body),
	}), env);

console.log("method and shape");
ok((await worker.fetch(new Request("https://x/"), env)).status === 405, "GET rejected with 405");
ok((await worker.fetch(new Request("https://x/", { method: "OPTIONS" }), env)).status === 204, "OPTIONS preflight");
ok((await post({}, "1.2.3.4", { "content-length": "99999" })).status === 413, "oversize body rejected");
{
	const r = await worker.fetch(new Request("https://x/", { method: "POST", headers: { "cf-connecting-ip": "1.2.3.4" }, body: "{bad" }), env);
	ok(r.status === 400, "malformed json rejected");
}

console.log("challenge flow");
{
	const r1 = await post({ rev: 9, device: "abc" });
	const b1 = await r1.json();
	ok(r1.status === 401, "no token and no work -> 401");
	ok(typeof b1.seed === "string" && typeof b1.bits === "number", "returns a seed and difficulty");

	// solve it
	let nonce = null;
	for (let n = 0; n < 5_000_000; n++) {
		if (await checkWork(sha256Hex, b1.seed, n, b1.bits)) { nonce = n; break; }
	}
	ok(nonce !== null, `solved challenge (nonce=${nonce})`);

	const r2 = await post({ rev: 9, device: "abc", seed: b1.seed, nonce, bits: b1.bits });
	const b2 = await r2.json();
	ok(r2.status === 200, "solved challenge -> 200");
	ok(b2.update === true, "reports the update (9 -> 10)");
	ok(typeof b2.token === "string", "hands back a token");

	// reuse the token: no puzzle
	const r3 = await post({ rev: 9, device: "abc", token: b2.token });
	const b3 = await r3.json();
	ok(r3.status === 200, "reused token -> 200 without solving");

	// stolen token from another IP
	const r4 = await post({ rev: 9, device: "abc", token: b2.token }, "9.9.9.9");
	ok(r4.status === 401, "token rejected from a different IP");

	// wrong nonce
	const r5 = await post({ rev: 9, device: "abc", seed: b1.seed, nonce: (nonce + 1), bits: b1.bits });
	ok(r5.status === 401, "wrong nonce rejected");

	// valid work against the wrong seed
	const r6 = await post({ rev: 9, device: "abc", seed: "some-other-seed", nonce, bits: b1.bits });
	ok(r6.status === 401, "work bound to the wrong seed rejected");

	// up to date
	const r7 = await post({ rev: 10, device: "abc", token: b2.token });
	ok((await r7.json()).update === false, "rev 10 client sees no update");
}

console.log("device spoofing is irrelevant to identity");
{
	// two different device strings from the same IP, solving once, share the token
	const a = await post({ rev: 9, device: "device-a" });
	const ch = await a.json();
	let nonce = null;
	for (let n = 0; n < 5_000_000; n++) if (await checkWork(sha256Hex, ch.seed, n, ch.bits)) { nonce = n; break; }
	const first = await (await post({ rev: 9, device: "device-a", seed: ch.seed, nonce, bits: ch.bits })).json();
	const second = await post({ rev: 9, device: "totally-different-device", token: first.token });
	ok(second.status === 200, "rotating the device string does not buy a bypass");
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
