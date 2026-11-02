// IP-bound identity tokens.
//
// The device field a client sends is attacker-controlled, so it can never anchor a
// rate limit: rotating it is free. This module issues something the client cannot
// forge - an HMAC over (hashed IP, issue time, nonce) - and verifies it again on the
// next request. A stolen token is useless from another address, so a botnet's IPs
// each have to obtain their own.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_LEN = 512;
const IP_HASH_LEN = 24;

// Cached per isolate. The secret never leaves the Worker.
const keyCache = new Map();

async function hmacKey(secret) {
	let k = keyCache.get(secret);
	if (!k) {
		k = await crypto.subtle.importKey(
			"raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
		);
		keyCache.set(secret, k);
	}
	return k;
}

// Chunked, because String.fromCharCode(...bytes) overflows the call stack for
// anything larger than a few thousand bytes.
export function b64url(buf) {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	}
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(str) {
	const p = str.replace(/-/g, "+").replace(/_/g, "/");
	const padded = p.padEnd(p.length + ((4 - (p.length % 4)) % 4), "=");
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function sha256Hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ipTag(ip) {
	return (await sha256Hex(ip)).slice(0, IP_HASH_LEN);
}

export async function mintToken(secret, ip, now) {
	const payload = JSON.stringify({
		ip: await ipTag(ip),
		t: now,
		n: crypto.getRandomValues(new Uint32Array(1))[0],
	});
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
	return `${b64url(encoder.encode(payload))}.${b64url(sig)}`;
}

export async function verifyToken(secret, token, ip, now) {
	if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LEN) return false;
	const dot = token.indexOf(".");
	if (dot < 1 || dot === token.length - 1) return false;

	let payload, data;
	try {
		payload = decoder.decode(unb64url(token.slice(0, dot)));
		const ok = await crypto.subtle.verify(
			"HMAC", await hmacKey(secret), unb64url(token.slice(dot + 1)), encoder.encode(payload),
		);
		if (!ok) return false;
		data = JSON.parse(payload);
	} catch {
		return false;
	}

	if (typeof data?.t !== "number" || typeof data?.ip !== "string") return false;
	if (now - data.t > TOKEN_TTL_MS) return false;
	// a token from the future means a clock problem or a forged timestamp
	if (data.t - now > 60_000) return false;
	return data.ip === (await ipTag(ip));
}
