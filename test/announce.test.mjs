// Drives the real announce handlers through the worker's fetch.
import worker from "../src/index.js";

let pass = 0, fail = 0;
const ok = (c, n) => (c ? (pass++, console.log("  ok  ", n)) : (fail++, console.log("  FAIL", n)));

// A stand-in for the KV namespace: the same async get/put surface the binding has.
function fakeKV(initial) {
	const store = new Map(initial ? [["announcements", JSON.stringify(initial)]] : []);
	return {
		store,
		async get(key) { return store.has(key) ? store.get(key) : null; },
		async put(key, value) { store.set(key, value); },
	};
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
	if (String(url).includes("announcements.json")) {
		return new Response(JSON.stringify({ items: [{ id: "file-1", text: "from the file" }] }), { status: 200 });
	}
	return realFetch(url);
};

const TOKEN = "publish-secret";
const get = (env) => worker.fetch(new Request("https://x/announcements"), env);
const post = (body, env, headers = {}) =>
	worker.fetch(new Request("https://x/announce", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	}), env);

console.log("routing");
{
	const r = await worker.fetch(new Request("https://x/"), {});
	ok(r.status === 405, "GET / is still rejected (version gate unchanged)");
	ok((await worker.fetch(new Request("https://x/announcements", { method: "POST" }), {})).status === 405, "POST /announcements -> 405");
	ok((await worker.fetch(new Request("https://x/announce"), {})).status === 405, "GET /announce -> 405");
}

console.log("reading");
{
	const kv = fakeKV({ items: [{ id: "a", text: "hello", kind: "good" }] });
	const b = await (await get({ ANNOUNCEMENTS: kv })).json();
	ok(b.items.length === 1 && b.items[0].text === "hello", "KV item served");

	const file = await (await get({})).json();
	ok(file.items[0]?.text === "from the file", "no binding falls back to the committed file");

	const empty = await (await get({ ANNOUNCEMENTS: fakeKV() })).json();
	ok(Array.isArray(empty.items) && empty.items.length === 0, "empty KV yields an empty list, not null");
}

console.log("publishing");
{
	const kv = fakeKV();
	const env = { ANNOUNCEMENTS: kv, PUBLISH_TOKEN: TOKEN, PUBLISH_GAP_MS: "0" };

	ok((await post({ text: "hi" }, { ...env, PUBLISH_TOKEN: undefined })).status === 501, "no secret configured -> 501");
	ok((await post({ text: "hi" }, env, { authorization: "Bearer wrong" })).status === 401, "wrong token -> 401");
	ok((await post({ text: "hi" }, env, { authorization: "" })).status === 401, "missing token -> 401");
	ok((await post("{bad", env)).status === 400, "malformed json -> 400");
	ok((await post({ kind: "good" }, env)).status === 400, "no text -> 400");

	const good = await post({ text: "Double XP this weekend", kind: "good" }, env);
	const goodBody = await good.json();
	ok(good.status === 200 && goodBody.ok === true, "publish succeeds");
	ok(goodBody.items[0].kind === "good", "kind survives");
	ok(typeof goodBody.items[0].id === "string" && goodBody.items[0].id.length > 0, "server mints an id");

	const readBack = await (await get(env)).json();
	ok(readBack.items[0].text === "Double XP this weekend", "publish is visible on the next read");

	// tags are stripped and length is capped, because the client renders this
	const messy = await post({ text: `<b>${"x".repeat(400)}</b>` }, env);
	const messyBody = await messy.json();
	ok(!messyBody.items[0].text.includes("<"), "markup stripped");
	ok(messyBody.items[0].text.length <= 220, "text capped at 220");

	// the list is capped, oldest dropped
	for (let i = 0; i < 8; i++) await post({ text: `note ${i}` }, env);
	const many = await (await get(env)).json();
	ok(many.items.length === 5, "list capped at 5");
	ok(many.items[many.items.length - 1].text === "note 7", "newest kept");

	const cleared = await (await post({ clear: true }, env)).json();
	ok(cleared.items.length === 0, "clear empties the list");
}

console.log("publishing refuses without storage");
{
	const env = { PUBLISH_TOKEN: TOKEN, PUBLISH_GAP_MS: "0" };
	ok((await post({ text: "hi" }, env)).status === 501, "token but no backend -> 501");
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
