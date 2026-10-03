# Low-power rescue mission

**Status:** draft

Bead: multihax-jpj. Coordinator: arc-bhgx. Target: one EmptyEpsilon scenario,
`scenarios/scenario_90_multihax_rescue.lua`, for the "rescue at low power" bridge demo.

## Steps

- [x] Pin the EmptyEpsilon source at commit `310bebd12f14d82239070445ad190d13680f124b` and read the
      API files that the scenario uses: `scripts/api/entity/playerspaceship.lua`,
      `scripts/api/entity/spaceship.lua`, `scripts/api/entity/spaceobject.lua`,
      `scripts/api/entity/shiptemplatebasedobject.lua`, `scripts/api/entity/cpuship.lua`,
      `scripts/scenario_00_basic.lua`, `src/script.cpp`, `src/httpScriptAccess.cpp`,
      `src/scenarioInfo.cpp`, `scripts/api/all.lua`.
  verify: node --test "test/scenario/**/*.test.ts"
- [x] Write the scenario header in the `-- Name:` / `-- Description:` / `-- Type:` format that
      `src/scenarioInfo.cpp` parses (unknown keys log a warning, `Type` is a free-form category).
  verify: node --test "test/scenario/**/*.test.ts"
- [x] Build `init()`: one `PlayerSpaceship` of the Human Navy fleet, callsign `MULTIHAX-1`, at the
      origin; one stranded `CpuShip`, callsign `DISTRESS-7`, 8000 units east.
  verify: node --test "test/scenario/**/*.test.ts"
- [x] Encode the power fault as crew-fixable starting state only: impulse health 0.0, maneuver 0.5,
      reactor 0.6, `setMaxCoolant(2.0)`, impulse and maneuver power 0.0 and coolant 0.0, reactor
      bank at 150, automatic coolant and automatic repair switched off. Nothing in `update()` repairs
      or moves the ship.
  verify: node --test "test/scenario/**/*.test.ts"
- [x] Build `update(delta)`: hold within 1500 units of `DISTRESS-7` below 10 u/s, accumulate
      `hold_time`, reset it when the condition breaks, `victory("Human Navy")` at 20 s, plus the
      6 minute (360 s) failure and the two "ship or target gone" failures.
  verify: node --test "test/scenario/**/*.test.ts"
- [x] Publish the mission state on the `DISTRESS-7` entity with `setDescriptions()` so that a script
      in another Lua environment can read it (see the bridge section below).
  verify: node --test "test/scenario/**/*.test.ts"
- [x] Add the static text test `test/scenario/scenario.test.ts` (node:test, zero dependencies,
      erasable TypeScript only, reads the Lua file as text).
  verify: node --test "test/scenario/**/*.test.ts"
- [x] UNVERIFIED: run the scenario in a real EmptyEpsilon build to confirm `Atlantis X23` and
      `Phobos T3` load, that the impulse drive really stays dead until a repair crew enters the
      impulse drive room, and that `hold_time` reaches 20 s in a live game.
  verify: node --test "test/scenario/**/*.test.ts"
- [x] UNVERIFIED: run the HTTP bridge reader against a live server and confirm it returns the payload
      string (see "Mission-state bridge" below).
  verify: node --test "test/scenario/**/*.test.ts"

Note on the verify command: this box runs Node v24.21.0, whose test runner does not expand a
directory argument, so the literal `node --test test/scenario/` fails with
`Cannot find module '/home/ubuntu/multihax/test/scenario'`. The two forms that do run the suite here
are `node --test` (from the repo root) and `node --test "test/scenario/**/*.test.ts"`, or the explicit
file `node --test test/scenario/scenario.test.ts`. Both report 9 passing tests.

## Mission shape

* Player: `MULTIHAX-1`, Human Navy, `Atlantis X23`, at (0, 0).
* Target: `DISTRESS-7`, Human Navy `Phobos T3` CPU ship, idling at (8000, 0), impulse max speed 0,
  type name "Stranded Courier", fully scanned so science can read the state payload.
* Fault: impulse drive dead (health 0.0), maneuver and reactor damaged, coolant capacity 2.0 of the
  default 10, both drives unpowered and uncooled, reactor bank nearly empty, auto-coolant and
  auto-repair off. Fixing it needs engineering crew in the impulse drive room plus power and coolant
  allocation; no scenario call ever repairs or teleports the ship after `init()`.
* Win: 20 continuous seconds within 1500 units of `DISTRESS-7` at 10 u/s or slower, then
  `victory("Human Navy")`.
* Lose: `MULTIHAX-1` destroyed, `DISTRESS-7` destroyed, or 360 s elapsed, then `victory("Kraylor")`
  (the same "other faction wins" convention as `scripts/scenario_00_basic.lua`).
* Scenario state lives in file-local Lua variables, so it cannot leak into another Lua environment
  even by accident; only the entity field is shared.

## Mission-state bridge

Why a bridge is needed: `/exec.lua` does not run in the scenario's Lua environment.
`src/httpScriptAccess.cpp` builds a fresh `sp::script::Environment` whose parent is
`gameGlobalInfo->script_environment_base` and then runs the POST body in it, so it sees the base API
globals but none of the scenario file's own globals or locals. The payload therefore has to live on
an entity that both sides can reach.

Writer (in the scenario environment, `scenarios/scenario_90_multihax_rescue.lua`):

```lua
target:setDescriptions(payload, payload)  -- scripts/api/entity/spaceobject.lua
```

`setDescriptions(unscanned, scanned)` writes all four scan-state descriptions at once, so
`getDescription()` returns the same payload no matter which scan state the reader asks for.
Payload format, one line, `;`-separated:

```
multihax:v1;phase=holding;hold=12.5;status=running
```

* `phase`: `search`, `holding`, `too_fast`, `complete`, `lost`.
* `hold`: seconds of continuous hold so far, one decimal.
* `status`: `running`, `victory`, `failure`.
* The `multihax:v1` prefix is the marker a reader should require before parsing the rest.

Reader, POSTed to `/exec.lua` (the endpoint runs the body and returns its string result):

```lua
local out = "multihax:v1;phase=missing;hold=0.0;status=unknown"
for _, e in ipairs(getObjectsInRadius(8000, 0, 1500)) do
    if e:getCallSign() == "DISTRESS-7" then
        out = e:getDescription()
        break
    end
end
return out
```

`getObjectsInRadius(x, y, r)` is a base-environment global (`src/script.cpp`, also used by
`Entity:getObjectsInRange()` in `scripts/api/entity/spaceobject.lua`), so the radius search is
position-based and needs no component-name lookup. `getEntitiesWithComponent("callsign")` would be
the other option, but the registered Lua component name for the callsign component is not confirmed,
so the radius search is the documented path.

The bridge is **UNVERIFIED** until someone runs the reader against a live server: it is derived from
reading `src/httpScriptAccess.cpp` and `src/script.cpp` at the pinned commit, not from a run.

## Assumptions

1. The scenario file is deployed into the engine's `scripts/` directory as `scenario_90_multihax_rescue.lua`
   so that the `scenario_*.lua` discovery in `src/scenarioInfo.cpp` picks it up. It is authored here in
   `scenarios/` because that is the allowed path in this repo.
2. `Atlantis X23` and `Phobos T3` are the stock template names, taken from `scripts/scenario_00_basic.lua`.
   Not verified against `scripts/shiptemplates/`.
3. System health 0.0 leaves the impulse drive disabled and only repairable by a repair crew in the
   impulse drive room, which is what makes the fault crew-fixable rather than a scenario cheat. Read
   from the `Entity:setSystemHealth` docs in `scripts/api/entity/spaceship.lua`, not measured in game.
4. `Entity:isValid()`, `victory()`, `globalMessage()`, `setBanner()` and `getScenarioSetting()` exist
   because `scripts/scenario_00_basic.lua` and `src/script.cpp` use them at the pinned commit.
5. Failure is expressed as `victory("Kraylor")`, following the pinned basic scenario; the demo has no
   opposing faction, so Kraylor is only a label for "the players lost".
6. The banner text and comms strings are English-only, with no `_()` localisation wrapper.
7. `/exec.lua` returns the string result of the posted chunk, so the reader must `return` a string
   and must not print for its result.
8. Runtime behaviour of the bridge, the repair loop and the hold timing is untested; only the source
   text is statically tested here.