// Every tunable in one place. A real client polls every 15s, which is 4/minute;
// the per-IP limits are set well above that so a user cannot trip them by
// reloading the script a few times.
export const LIMITS = {
	ipPerMinute: 30,
	ipPerHour: 300,
	// free tier is 100k invocations/day. This ceiling keeps a flood from consuming
	// the whole budget in minutes, and the retry-after tells honest clients to wait.
	globalPerMinute: 3000,
};

// Cloudflare sets cf-connecting-ip; the others are fallbacks for `wrangler dev`.
export function clientIp(request) {
	return (
		request.headers.get("cf-connecting-ip") ||
		request.headers.get("x-real-ip") ||
		(request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
		"0.0.0.0"
	);
}
