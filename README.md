# Aether-Version

The update-check endpoint for [Aether](https://github.com/0craxy0/Aether). A device
POSTs the build it is running; this Worker compares it with `version.json` in the
Aether repo and answers.

The device never decides whether an update exists. It reports a rev and takes orders,
so a bad build can be recalled without editing anything a client already cached.

## Why there is a guard at all

One hostile caller could otherwise burn the free tier's 100,000 daily invocations and
take every user offline. The obvious defence — a limit per `device` — does not work:
the device string is attacker-chosen, and rotating it costs nothing.

So every limit keys on something the caller **cannot** choose:

| Layer | Keys on | Beaten by |
|---|---|---|
| Shape check | HTTP method, body size | nothing (free) |
| Per-IP counters | `CF-Connecting-IP` | a botnet with many IPs |
| Global breaker | one shared Durable Object | nothing (bounds total spend) |
| HMAC token | IP + issue time + nonce | stealing the secret |
| Proof of work | IP-hour-bound puzzle, per new identity | real CPU per IP |

The order matters. An attacker costs one invocation the instant they arrive, so the
checks run cheapest-first and reject before any crypto or storage work happens.

### The token

The Worker mints an HMAC over `(sha256(ip)[:24], issuedAt, nonce)`. It is not secret —
it is unforgeable. A token lifted from another user is useless from your address, so a
botnet has to obtain one per IP, and obtaining one costs a puzzle.

Tokens live 7 days. A client that holds one never solves another puzzle: a real user
pays the cost once, ever.

### Proof of work

16 bits ≈ 65k hashes, about 0.8 s even in a slow single-threaded solver. A challenge is
bound to the IP and the current hour, is deterministic (so a retry resumes rather than
restarting), and is issued *before* any real work is done. Raise `CHALLENGE_BITS` if
abuse appears — clients read the difficulty from the challenge, so no client change is
needed.

This does not defeat a large botnet. Nothing at this layer does. It makes each fabricated
identity cost real time, which is the only thing that raises an attacker's price without
raising yours.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler secret put HMAC_SECRET     # any long random string

# announcements, optional but recommended - see below
npx wrangler kv namespace create ANNOUNCEMENTS   # paste the id into wrangler.toml
npx wrangler secret put PUBLISH_TOKEN            # the bearer token you publish with

npm run deploy
```

Then put the printed `https://aether-version.<subdomain>.workers.dev` into `U.api` in
Aether's `tail/updater.lua` and `N.api` in `tail/announcements.lua`.

`npm test` runs 68 assertions across the token, the puzzle, the announcements
endpoints and the full request flow.

## Request

```http
POST /
Content-Type: application/json

{ "rev": 9, "build": "2026-11-01.9", "device": "123456789" }
```

First call from a new IP returns `401` with a puzzle:

```json
{ "error": "challenge required", "seed": "203.0.113.7|495123", "bits": 16 }
```

Solve it — find `nonce` such that `sha256("<seed>:<nonce>")` has 16 leading zero bits —
and send it back with `seed`, `nonce` and `bits`. The answer includes a `token`; store it
and send it on every later request instead of the puzzle.

Response:

```json
{
  "token": "eyJpcCI6...",
  "update": true,
  "rev": 10,
  "build": "2026-11-02.1",
  "notes": "…",
  "loader": "https://raw.githubusercontent.com/0craxy0/Aether/main/main.lua",
  "forced": false,
  "cooldown": 300
}
```

| Field | Meaning |
|---|---|
| `rev` | Monotonic integer. The only field that decides anything. |
| `minRev` | Revs below this are force-updated, for pulling a broken push. |
| `rollout` | Percent of devices offered the update. `100` = everyone. |

Bump `REV` in `main.lua` and `rev` in `version.json` **together**, or nobody is offered
the next build.

## Announcements

A note the owner sends to everyone running the hub, without editing GitHub.

```http
GET /announcements          -> { "items": [{ "id": "...", "text": "...", "kind": "good" }] }

POST /announce              Authorization: Bearer <PUBLISH_TOKEN>
{ "text": "Double XP this weekend.", "kind": "good" }
{ "items": [ ... ] }        replace the list
{ "clear": true }           empty it
```

Publishing takes one request from anywhere:

```bash
curl -X POST https://aether-version.<subdomain>.workers.dev/announce \
  -H "Authorization: Bearer $AETHER_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Double XP this weekend.","kind":"good"}'
```

Clients poll `GET /announcements` every 15 seconds, so a note is live without a
commit. Storage is picked by which binding exists:

| binding | publish does | needs |
|---|---|---|
| `ANNOUNCEMENTS` (KV) | one write, visible immediately | a namespace |
| `GITHUB_TOKEN` | commits `announcements.json` | a token with `contents:write` |
| neither | `501` on publish, GET still proxies the committed file | nothing |

**Text only.** The payload carries no command, no target id and no action - a note
cannot make a client do anything. That is why this half is public while the version
gate needs a puzzle.

`PUBLISH_TOKEN` is a secret and must never enter the Lua: it would be readable by
anyone who opens the script, and then writable by them too. It is compared in
constant time and publishes are throttled to one every three seconds per isolate.
Text is capped at 220 characters, markup is stripped, and the list keeps the newest
five.

## Notes

- `cache-control: no-store` everywhere. A cached "you're up to date" is worse than no
  endpoint.
- The limiter **fails open**. An update check that stops working strands every user on an
  old build, which is worse than briefly losing the guard.
- The Worker returns a descriptor, never code. The client saves its own config, tears down
  its own UI and re-downloads its own loader.
