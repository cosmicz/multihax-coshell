# multihax — real EmptyEpsilon adapter

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
EE_API_URL=http://127.0.0.1:8790 \
EE_API_TOKEN_FILE=/home/ubuntu/.multihax/vmapi.token \
PUBLIC_PORT=3001 PUBLIC_HOST=0.0.0.0 \
node --experimental-transform-types src/real/main.ts
```

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