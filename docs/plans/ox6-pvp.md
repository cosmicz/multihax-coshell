# PvP per-ship routing

**Status:** draft

Bead: multihax-ox6 (coordinator arc-bhgx, OC approved). Upstream
`scripts/scenario_81_pvp.lua` is UNCHANGED: it spawns two Atlantis player ships,
`HNS Gallipoli` (Human Navy, line 73) and `Crusader Naa'Tvek` (Kraylor, line
74), and respawns them as `HNS Heinlein` / `Crusader Elak'raan` (lines 155, 165).
Every instance therefore has to address its own ship by callsign instead of
`getPlayerShip(-1)`, and the apostrophe in `Naa'Tvek` has to survive the trip
into Lua. Never substitute a fake world.

All engine names are verified against
`raw.githubusercontent.com/daid/EmptyEpsilon/310bebd12f14d82239070445ad190d13680f124b/`.

- [x] 1. Callsign safety: allowlist of letters, digits, space, underscore, hyphen and apostrophe, 1 to 40 characters, and a single Lua quoting function (long bracket, else escaped) — no raw splicing
- [x] 2. Per-ship lookup loop `for i = 1, 32` over `getPlayerShip(i)` in the observation and in the command templates, with `SHIP_NOT_FOUND` and the existing `SHIP_MISMATCH` guard
- [x] 3. `src/vmapi/server.ts`: `SHIP_CALLSIGN` required, no first-observation binding, several instances side by side (ports 8790/8791, own tokens), weapons seat claimed for `agent-weapons`
- [x] 4. Weapons role with `target_ship {callsign}`: enemy player ship resolved by the same loop, faction must differ, `s:commandSetTarget(enemy)`; allowlist, actor, VM route and drive `/api/intent` extended; observation gains hull, shield and the other player ship
- [x] 5. Drive: `TEAM` label on `/state` and the page header, `RULE_CONTROLLERS` also accepts `weapons`
- [x] 6. README "PvP mode" section with two vmapi instances and two drive instances

## Verified engine surface

| Name | Kind | Source |
| --- | --- | --- |
| `getPlayerShip(i)` | global, 1-based index over `PlayerControl` entities | `src/script.cpp` `static sp::ecs::Entity luaGetPlayerShip(int index)` |
| `Entity:getCallSign()` | string | `scripts/api/entity/spaceobject.lua` |
| `Entity:getFaction()` | faction name string | `scripts/api/entity/spaceobject.lua` `return f.entity.components.faction_info.name` |
| `Entity:getPosition()` | `x, y` numbers | `scripts/api/entity/spaceobject.lua` `return table.unpack(...)` |
| `Entity:getVelocity()` | `vx, vy` numbers | `scripts/api/entity/spaceobject.lua` `return table.unpack(...)` |
| `Entity:getRotation()`, `Entity:getHeading()` | numbers | `scripts/api/entity/spaceobject.lua` |
| `Entity:getEnergyLevel()`, `Entity:getEnergyLevelMax()` | numbers | `scripts/api/entity/playerspaceship.lua` (max at line 231) |
| `Entity:getSystemPower/Coolant/Health/Heat(name)` | numbers | `scripts/api/entity/spaceship.lua` via `__getSystemByName` |
| `impulse_engine.request`, `impulse_engine.actual` | component members | `src/script/components.cpp` `ComponentHandler<ImpulseEngine>::name("impulse_engine")`, `BIND_MEMBER(ImpulseEngine, request)`, `BIND_MEMBER(ImpulseEngine, actual)` |
| `hull.current`, `hull.max` | component members | `src/script/components.cpp` `ComponentHandler<Hull>::name("hull")` |
| `shields.entries[0..n-1].level` / `.max` | component array, 0-based | `src/script/components.cpp` `BIND_ARRAY(Shields, entries)` + `BIND_ARRAY_MEMBER(Shields, entries, level/max)` |
| `Entity:commandSetTarget(target)` | command | `scripts/api/entity/playerspaceship.lua`, C++ `luaCommandSetTarget` in `src/script.cpp` (writes `Target::entity`) |
| `Entity:commandTargetRotation/commandImpulse/commandSetSystemPowerRequest/commandSetSystemCoolantRequest` | commands | `scripts/api/entity/playerspaceship.lua` |
| `hasPlayerCrewAtPosition(s, station)` | global | `scripts/api/entity/playerspaceship.lua` `Entity:hasPlayerAtPosition` |
| `toJSON` | global | `src/script.cpp` `static int luaToJSON(lua_State* L)` |

Not in the pinned source, therefore never used: `getSpeed`, `getImpulseLevel`,
`getEnergyMax`, `getHull`, `getShields`, `getImpulse`.