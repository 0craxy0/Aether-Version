import { makeChallenge, checkWork, leadingZeroBits, CHALLENGE_BITS } from "../src/pow.js";
import { sha256Hex } from "../src/token.js";

let pass = 0, fail = 0;
const ok = (cond, name) => cond ? (pass++, console.log("  ok  ", name)) : (fail++, console.log("  FAIL", name));

console.log("leadingZeroBits");
ok(leadingZeroBits("00ff") === 8, "counts whole zero nibbles");
ok(leadingZeroBits("0f00") === 4, "stops after the first non-zero nibble");
ok(leadingZeroBits("8f00") === 0, "high bit first means zero");
ok(leadingZeroBits("01") === 7, "0x01 is seven leading zero bits");

console.log("challenge");
const now = Date.now();
const ch = makeChallenge("1.2.3.4", now);
ok(ch.bits === CHALLENGE_BITS, "default difficulty");
ok(makeChallenge("1.2.3.4", now).seed === ch.seed, "deterministic within the hour");
ok(makeChallenge("1.2.3.4", now + 3_600_000).seed !== ch.seed, "changes across hours");
ok(makeChallenge("1.2.3.5", now).seed !== ch.seed, "changes across IPs");

console.log("solve at the real difficulty");
let solution = null;
const t0 = process.hrtime.bigint();
for (let n = 0; n < 5_000_000; n++) {
	if (await checkWork(sha256Hex, ch.seed, n, ch.bits)) { solution = n; break; }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
ok(solution !== null, `solveable (nonce=${solution}, ${ms.toFixed(0)}ms)`);
ok(await checkWork(sha256Hex, ch.seed, solution, ch.bits), "accepts the solved nonce");
ok(!(await checkWork(sha256Hex, ch.seed, solution + 1, ch.bits)), "rejects a wrong nonce");
ok(!(await checkWork(sha256Hex, "other-seed", solution, ch.bits)), "nonce is bound to its seed");
ok(!(await checkWork(sha256Hex, ch.seed, -1, ch.bits)), "rejects negative nonces");
ok(!(await checkWork(sha256Hex, ch.seed, solution, 999)), "rejects an absurd difficulty");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
