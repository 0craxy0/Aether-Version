# Aether-Version

The update-check endpoint for [Aether](https://github.com/0craxy0/Aether). A device POSTs
the build it is running; this Worker reads `version.json` from the Aether repo, compares
the two, and answers with the decision.

The device never decides whether an update exists. It reports a rev and takes orders.
That is deliberate: it means a bad build can be recalled without editing anything a
client has already cached.

## Deploy

```bash
npm install
npx wrangler login
npm run deploy
```

Wrangler prints the URL, normally `https://aether-version.<subdomain>.workers.dev`.
Put that in `U.api` in Aether's `tail/updater.lua`.

## Request

```http
POST /
Content-Type: application/json

{ "rev": 9, "build": "2026-11-01.9", "device": "123456789" }
```

- `rev` — integer, the `REV` the loader was built with. Source of truth.
- `build` — the date string, used only for logging. Never compared.
- `device` — optional, any stable per-user string. Hashed to place the device in a
  rollout wave. `UserId` is enough; nothing identifies the user server-side.

## Response

Nothing to do:

```json
{ "update": false, "rev": 10, "build": "2026-11-01.10" }
```

Update available:

```json
{
  "update": true,
  "rev": 10,
  "build": "2026-11-01.10",
  "notes": "Aim step, shadow and corner fixes.",
  "loader": "https://raw.githubusercontent.com/0craxy0/Aether/main/main.lua",
  "forced": false,
  "cooldown": 300
}
```

`forced: true` means the running build is below `minRev`. The client should still ask,
but must not accept "later" as an answer.

## version.json

Read from `0craxy0/Aether@main/version.json` on every request (edge-cached for 60s):

```json
{
  "rev": 10,
  "build": "2026-11-01.10",
  "notes": "Aim step, shadow and corner fixes.",
  "loader": "main.lua",
  "minRev": 0,
  "rollout": 100
}
```

| Field | Meaning |
|---|---|
| `rev` | Monotonic integer. The only field that decides anything. |
| `build` | Human-readable date stamp, shown in the prompt. |
| `notes` | One line of changelog, max 300 chars in the response. |
| `minRev` | Revs below this are force-updated. Use to unstick a broken push. |
| `rollout` | Percent of devices offered the update. `100` = everyone. |

Bump `REV` in `main.lua` and `rev` in `version.json` **together**. If they drift,
the loader warns that `version.json` is behind and nobody gets offered the next build.

## Cost

The free tier is 100,000 requests/day, and the client pings every 15 seconds:

| Poll interval | Requests/device/day | Devices on free tier |
|---|---|---|
| 5 s | 17,280 | 5 |
| 15 s | 5,760 | 17 |
| 30 s | 2,880 | 34 |
| 60 s | 1,440 | 69 |

If that ceiling matters, poll `version.json` directly on the shown interval — it is
CDN-served and unmetered — and only POST here when the rev changes, or once per
session. Same behaviour, roughly one request per device per session.

`EDGE_TTL` in `src/index.js` is the other half: it caps how often GitHub is actually
read, regardless of how many devices are pinging.

## Notes

- `cache-control: no-store` on every response. A cached "you're up to date" is worse
  than no endpoint at all.
- The Worker never returns code, only a descriptor. The client saves its own config,
  tears down its own UI, and re-downloads its own loader. Handing back a script to
  execute would mean executing whatever the endpoint served, with no error handling
  and no way to keep the config when it fails halfway.
