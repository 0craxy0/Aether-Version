import { mintToken, verifyToken, b64url, unb64url, ipTag, TOKEN_TTL_MS } from "../src/token.js";

let pass = 0, fail = 0;
const ok = (cond, name) => cond ? (pass++, console.log("  ok  ", name)) : (fail++, console.log("  FAIL", name));

const SECRET = "unit-test-secret";
const now = Date.now();

console.log("token");
const tok = await mintToken(SECRET, "1.2.3.4", now);
ok(typeof tok === "string" && tok.includes("."), "mints payload.sig");

// this is the regression that blocked the branch: TextEncoder has no .decode(),
// so verify threw inside its own try/catch and always returned false
ok(await verifyToken(SECRET, tok, "1.2.3.4", now), "verifies from the same IP");

ok(!(await verifyToken(SECRET, tok, "9.9.9.9", now)), "rejects a different IP");
ok(!(await verifyToken("wrong-secret", tok, "1.2.3.4", now)), "rejects a wrong secret");
ok(!(await verifyToken(SECRET, tok, "1.2.3.4", now + TOKEN_TTL_MS + 1)), "rejects an expired token");
ok(!(await verifyToken(SECRET, tok, "1.2.3.4", now - 120_000)), "rejects a future-dated token");
ok(!(await verifyToken(SECRET, "", "1.2.3.4", now)), "rejects empty");
ok(!(await verifyToken(SECRET, null, "1.2.3.4", now)), "rejects non-string");
ok(!(await verifyToken(SECRET, "x".repeat(600), "1.2.3.4", now)), "rejects oversize");
ok(!(await verifyToken(SECRET, "nodot", "1.2.3.4", now)), "rejects missing separator");
ok(!(await verifyToken(SECRET, "a.", "1.2.3.4", now)), "rejects empty signature");

{
	const [p, s] = tok.split(".");
	const raw = unb64url(p);
	raw[0] ^= 1;
	ok(!(await verifyToken(SECRET, b64url(raw) + "." + s, "1.2.3.4", now)), "rejects a tampered payload");
}
{
	const [p, s] = tok.split(".");
	const raw = unb64url(s);
	raw[0] ^= 1;
	ok(!(await verifyToken(SECRET, p + "." + b64url(raw), "1.2.3.4", now)), "rejects a tampered signature");
}

console.log("encoding");
{
	let lossless = true;
	for (let i = 0; i < 500; i++) {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		const back = unb64url(b64url(bytes));
		if (back.length !== 32 || bytes.some((b, j) => b !== back[j])) lossless = false;
	}
	ok(lossless, "b64url round-trips 500 random buffers");
}
{
	// the second latent bug: spread-argument encoding overflows the stack
	const big = new Uint8Array(200_000);
	let okBig = true;
	try { b64url(big); } catch { okBig = false; }
	ok(okBig, "b64url survives a 200KB buffer");
}

console.log("ip hashing");
ok((await ipTag("1.2.3.4")) !== (await ipTag("1.2.3.5")), "distinct IPs hash differently");
ok((await ipTag("1.2.3.4")).length === 24, "tag is truncated to 24 chars");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
