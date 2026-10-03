# multihax: LLM bridge crew for EmptyEpsilon

Cooperating LLM role agents (helms and engineering) crew a ship in the unmodified
open-source game EmptyEpsilon through our bounded, typed command API. Built at The
Multiplayer Coding Hackathon (Coshell), 2026-10-03.

## What is ours vs. upstream

**Upstream, unchanged:** EmptyEpsilon (`daid/EmptyEpsilon`, GPL-2.0, official
release `EE-2026.09.22PR`), run headless on a separate VM. We ship no engine patch.

**Ours, in the demo path:**

* `src/vmapi` — typed bearer-token API that observes and commands the ship and
  generates all Lua itself from fixed templates.
* `src/real` — the drive loop, `VmApiPort`, the spectator page and the external
  role-agent intent endpoint.
* `src/gateway` — the bounded command gateway: intent allowlist and bounds, seat
  leases and generations, and the fixed Lua templates.

**Present but not in the demo path:** `src/companion` (crew status and orders
companion app) and `scenarios/` (the custom rescue scenario).

## Demo scene

The stock Basic scenario with `Enemies=Empty` and `Time=Unlimited` and an Atlantis
player ship, so nothing unattended starts shooting. The spectator page shows live
telemetry and agent decisions; it is **not** a browser rendering of the game.

## Agents vs. controllers

LLM role agents act only by POSTing to `/api/intent` on the drive's loopback
command listener. The in-process rule-based loops are deterministic controllers,
not LLM, and are switched off with `RULE_CONTROLLERS=off` for the demo so the LLM
role agents own both seats.

## Status

No automated test suite, typecheck or code review is claimed for the current
revision. Observed live on 2026-10-03 (22:22 to 22:23 UTC): with the rule-based
controllers off, the helms and engineering LLM role agents turned the ship to
heading 90, set impulse and system power and coolant, flew it east from the origin
at about 75 units/s and stopped it at x of about 3429 (speed 0), as shown by the
read-only spectator telemetry.

## Architecture

Agent-only demo: a VM-side JSON API in front of the real headless EmptyEpsilon
engine, and a drive-side loop that observes the ship and relays bounded intents.
The engine's `/exec.lua` is loopback-only and never exposed; the drive never
builds Lua.

Node runs the TypeScript sources directly with type stripping, so every run
command uses `--experimental-transform-types`.

## VM (runs next to EmptyEpsilon)

`src/vmapi/server.ts` serves `GET /v1/health`, `GET /v1/observe` and
`POST /v1/command` on `127.0.0.1:8790`, each request gated by
`Authorization: Bearer <VMAPI_TOKEN>`.

```
VMAPI_TOKEN=<at least 16 characters> \
VMAPI_HOST=127.0.0.1 \
VMAPI_PORT=8790 \
EE_HTTP=http://127.0.0.1:8080 \
node --experimental-transform-types src/vmapi/server.ts
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `VMAPI_TOKEN` | required | Bearer token; startup is refused without it |
| `VMAPI_HOST` | `127.0.0.1` | Raise only behind a tunnel or private NIC |
| `VMAPI_PORT` | `8790` | Listen port |
| `EE_HTTP` | `http://127.0.0.1:8080` | Engine httpserver; loopback only |
| `SHIP_CALLSIGN` | unset | Fixed binding; unset binds the first observation |
| `BIND_RETRIES` / `BIND_RETRY_MS` | `30` / `1000` | Bind retries, then exit code 1 |
| `EPOCH` | `1` | Gateway epoch |
| `EE_TIMEOUT_MS` | `3000` | `/exec.lua` timeout |

`node --experimental-transform-types src/vmapi/server.ts --print-scripts` prints
the fixed observation Lua and one example per command type without touching the
engine.

## Drive (this machine)

`src/real/main.ts` observes through `VmApiPort`, runs the bounded deterministic
controllers (rule-based, not LLM) and serves two listeners:

* `127.0.0.1:3000` — the operator/role-agent listener: `GET /`, `GET /state` and
  `POST /api/intent`. It must stay on loopback; a non-loopback `SPECTATOR_HOST`
  is refused at startup.
* `0.0.0.0:3001` — the public read-only spectator (behind the Freestyle TLS
  route `multihax-bridge-20261003.style.dev` → drive port 3001): `GET /` and
  `GET /state` only. Any other method is 405, any other path 404, and there is
  no `/api/intent`. Its `/state` is scrubbed of the token, the token file path,
  `EE_API_URL` and anything else secret.

```
RULE_CONTROLLERS=off \
EE_API_URL=https://multihax-ee-20261003.style.dev \
EE_API_TOKEN_FILE=/home/ubuntu/.multihax/vmapi.token \
PUBLIC_PORT=3001 PUBLIC_HOST=0.0.0.0 \
node --experimental-transform-types src/real/main.ts
```

`EE_API_URL` above is the public HTTPS route to the VM API.
`http://127.0.0.1:8790` applies only when the VM API is reached through a tunnel.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EE_API_URL` | `http://127.0.0.1:8790` | `https` required unless host is loopback |
| `EE_API_TOKEN_FILE` | unset | Secret file; read once, trimmed, ≥16 characters; wins over `EE_API_TOKEN` |
| `EE_API_TOKEN` | unset | Bearer token when no file is given |
| `EE_API_TIMEOUT_MS` | `3000` | API request timeout |
| `RULE_CONTROLLERS` | `helms,engineering` | Comma list of `helms`/`engineering`, or `off` |
| `PORT` / `SPECTATOR_HOST` | `3000` / `127.0.0.1` | Command listener bind; loopback only |
| `PUBLIC_PORT` / `PUBLIC_HOST` | `3001` / `0.0.0.0` | Read-only public spectator bind |
| `TICK_MS` | `2000` | Loop period |
| `WAYPOINT_X` / `WAYPOINT_Y` | unset | Optional helm waypoint |
| `HEADING_DEG` | `90` | Held heading when no waypoint is set |

With `RULE_CONTROLLERS=off` both roles report `owner: "external role agent"` in
`/state`; role agents then drive the ship only through `POST /api/intent`
(`{role, intent, args, agent_label?, request_id?}`, allowlisted intents, 10 per
minute per role) and read their own last 20 outcomes from
`/state` → `roles.<role>.decisions`.