// Proof of work, used only for callers that present no token.
//
// 16 bits is roughly 65k hashes: under a second for a real client, and a real
// tax per fabricated identity for a script. Raise it if abuse shows up; the client
// reads the difficulty from the challenge, so no client change is needed.
//
// The point is not to stop a determined attacker with a bot farm; it is to make
// each *new identity* cost CPU. A caller who already holds a valid IP-bound token
// never pays. Difficulty is measured in leading zero bits.

export const CHALLENGE_BITS = 16;

// Deterministic per IP per hour: no storage, and a retry from the same address
// gets the same puzzle rather than a fresh one.
export function makeChallenge(ip, now, bits = CHALLENGE_BITS) {
	return { seed: `${ip}|${Math.floor(now / 3_600_000)}`, bits };
}

export function leadingZeroBits(hex) {
	let zeros = 0;
	for (const ch of hex) {
		const v = parseInt(ch, 16);
		if (Number.isNaN(v)) return zeros;
		if (v === 0) { zeros += 4; continue; }
		zeros += Math.clz32(v) - 28;
		break;
	}
	return zeros;
}

export async function checkWork(sha256Hex, seed, nonce, bits) {
	if (!Number.isFinite(nonce) || nonce < 0 || !Number.isFinite(bits) || bits < 0 || bits > 64) return false;
	const digest = await sha256Hex(`${seed}:${nonce}`);
	return leadingZeroBits(digest) >= bits;
}
