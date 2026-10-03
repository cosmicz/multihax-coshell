# multihax: LLM bridge crew for EmptyEpsilon

Live native 3D view: https://multihax-view-20261003.style.dev/vnc.html?autoconnect=true&resize=scale&view_only=true&path=websockify

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
| `SHIP_CALLSIGN` | required | Ship this instance controls; there is no first-observation binding |
| `EPOCH` | `1` | Gateway epoch |
| `EE_TIMEOUT_MS` | `3000` | `/exec.lua` timeout |

`node --experimental-transform-types src/vmapi/server.ts --print-scripts` prints
the per-ship observation Lua and one example per command type without touching
the engine.

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
| `RULE_CONTROLLERS` | `helms,engineering` | Comma list of `helms`/`engineering`/`weapons`, or `off` |
| `TEAM` | `unassigned` | Free-text label shown on `/state` and the page header |
| `PORT` / `SPECTATOR_HOST` | `3000` / `127.0.0.1` | Command listener bind; loopback only |
| `PUBLIC_PORT` / `PUBLIC_HOST` | `3001` / `0.0.0.0` | Read-only public spectator bind |
| `TICK_MS` | `2000` | Loop period |
| `WAYPOINT_X` / `WAYPOINT_Y` | unset | Optional helm waypoint |
| `HEADING_DEG` | `90` | Held heading when no waypoint is set |
| `SHIP_CALLSIGN` | unset | Optional assertion; startup fails if it disagrees with the VM API |

With `RULE_CONTROLLERS=off` both roles report `owner: "external role agent"` in
`/state`; role agents then drive the ship only through `POST /api/intent`
(`{role, intent, args, agent_label?, request_id?}`, allowlisted intents, 10 per
minute per role) and read their own last 20 outcomes from
`/state` → `roles.<role>.decisions`.

## PvP mode

Upstream `scripts/scenario_81_pvp.lua` (unchanged) spawns two Atlantis player
ships: `HNS Gallipoli` (Human Navy) and `Crusader Naa'Tvek` (Kraylor). Each side
runs its own vmapi instance and its own drive instance, and every instance
addresses its ship by `SHIP_CALLSIGN` — the apostrophe in `Naa'Tvek` is fine, and
no instance ever touches the other side's ship.

Two vmapi instances on the VM (different ports, different tokens):

```
VMAPI_TOKEN=<token-for-gallipoli> VMAPI_PORT=8790 \
SHIP_CALLSIGN="HNS Gallipoli" EE_HTTP=http://127.0.0.1:8080 \
node --experimental-transform-types src/vmapi/server.ts

VMAPI_TOKEN=<token-for-crusader> VMAPI_PORT=8791 \
SHIP_CALLSIGN="Crusader Naa'Tvek" EE_HTTP=http://127.0.0.1:8080 \
node --experimental-transform-types src/vmapi/server.ts
```

`SHIP_CALLSIGN` is required, so a typo fails loudly instead of silently flying
the wrong ship. Each instance claims helms, engineering and weapons for
`agent-helm`, `agent-eng` and `agent-weapons`.

Two drive instances (different ports, different tokens):

```
TEAM=Human \
EE_API_URL=https://multihax-ee-20261003.style.dev \
EE_API_TOKEN_FILE=/home/ubuntu/.multihax/vmapi-gallipoli.token \
RULE_CONTROLLERS=off PORT=3000 PUBLIC_PORT=3001 \
node --experimental-transform-types src/real/main.ts

TEAM=Kraylor \
EE_API_URL=https://multihax-ee-20261003.style.dev \
EE_API_TOKEN_FILE=/home/ubuntu/.multihax/vmapi-crusader.token \
RULE_CONTROLLERS=off PORT=3010 PUBLIC_PORT=3011 \
node --experimental-transform-types src/real/main.ts
```

Weapons is flown by a role agent through the allowlisted `target_ship` intent:

```
curl -s -X POST http://127.0.0.1:3000/api/intent -H 'content-type: application/json' \
  -d '{"role":"weapons","intent":"target_ship","args":{"callsign":"Crusader Naa'"'"'Tvek"},"agent_label":"weapons-agent"}'
```

The VM resolves that callsign with the same `ipairs(getActivePlayerShips())`
lookup, refuses a ship of the bound ship's own faction (`TARGET_SAME_FACTION`),
refuses an unknown callsign (`TARGET_NOT_FOUND`) and otherwise calls
`s:commandSetTarget(enemy)`. `RULE_CONTROLLERS` also accepts `weapons`, but no
deterministic weapons controller exists, so `/state` always reports weapons as
owned by an external role agent.

Weapons intents (all bounded, all fixed templates on the bound ship `s`, all
allowlisted on `POST /api/intent`):

| Intent | Args | Lua |
| --- | --- | --- |
| `target_ship` | `{callsign}` | resolve enemy by callsign, differing faction, visible, `s:commandSetTarget(enemy)` |
| `load_tube` | `{tube, weapon}` | `s:commandLoadTube(tube, weapon)`, tube 0–15, weapon `Homing`/`Nuke`/`Mine`/`EMP`/`HVLI` |
| `fire_tube` | `{tube, callsign}` | resolve enemy by callsign, differing faction, visible, `s:commandFireTubeAtTarget(tube, enemy)` |
| `set_shields` | `{active}` | `s:commandSetShields(active)` |
| `set_beam_frequency` | `{frequency}` | `s:commandSetBeamFrequency(frequency)`, 0–20 |

Visibility is the engine's own radar logic: a contact counts only when
`distance <= s:getLongRangeRadarRange()` and
`not s:isRadarBlockedFrom({x=ox, y=oy}, enemy, s:getShortRangeRadarRange())`.
Outside that, `target_ship` and `fire_tube` are refused with `NOT_VISIBLE` and
the observation reports `other_ship: null` with no enemy-derived field. This says
nothing about hard cover from planets or asteroids.

```
curl -s -X POST http://127.0.0.1:3000/api/intent -H 'content-type: application/json' \
  -d '{"role":"weapons","intent":"load_tube","args":{"tube":0,"weapon":"Homing"},"agent_label":"weapons-agent"}'

curl -s -X POST http://127.0.0.1:3000/api/intent -H 'content-type: application/json' \
  -d '{"role":"weapons","intent":"fire_tube","args":{"tube":0,"callsign":"Crusader Naa'"'"'Tvek"},"agent_label":"weapons-agent"}'

curl -s -X POST http://127.0.0.1:3000/api/intent -H 'content-type: application/json' \
  -d '{"role":"weapons","intent":"set_shields","args":{"active":true},"agent_label":"weapons-agent"}'
```

Each observation carries the bound ship's faction, hull (`getHull`/`getHullMax`),
per-shield levels (`getShieldCount`, zero-based `getShieldLevel`/`getShieldMax`),
shield and beam frequency, missile stock per type (`getWeaponStorage`/
`getWeaponStorageMax`), tube count and per-tube load type
(`getWeaponTubeCount`, zero-based `getWeaponTubeLoadType`) and the other player
ship's callsign, faction, position, distance and shield frequency.