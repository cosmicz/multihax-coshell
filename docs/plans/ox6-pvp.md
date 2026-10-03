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
- [x] 2. Per-ship lookup by callsign over `getActivePlayerShips()` (compact list; `getPlayerShip(i)` has holes at `src/script.cpp:1374` and `getPlayerShip(-1)` is never used) in the observation and in the command templates, with `SHIP_NOT_FOUND` / `TARGET_NOT_FOUND` and the existing `SHIP_MISMATCH` guard
- [x] 3. `src/vmapi/server.ts`: `SHIP_CALLSIGN` required, no first-observation binding, several instances side by side (ports 8790/8791, own tokens), weapons seat claimed for `agent-weapons`
- [x] 4. Weapons role with `target_ship {callsign}`: enemy player ship resolved by the same lookup, faction must differ, `s:commandSetTarget(enemy)`; allowlist, actor, VM route and drive `/api/intent` extended; observation gains hull, shield and the other player ship
- [x] 5. Drive: `TEAM` label on `/state` and the page header, `RULE_CONTROLLERS` also accepts `weapons`
- [x] 6. README "PvP mode" section with two vmapi instances and two drive instances
- [x] 7. `load_tube {tube, weapon}` → `s:commandLoadTube(tube, weapon)`, tube 0..15 and weapon in Homing/Nuke/Mine/EMP/HVLI
- [x] 8. `fire_tube {tube, callsign}` → enemy resolved by the hole-safe lookup and a differing faction, then `s:commandFireTubeAtTarget(tube, enemy)`; never a free-form entity
- [x] 9. `set_shields {active}` → `s:commandSetShields(active)`
- [x] 10. `set_beam_frequency {frequency 0..20}` → `s:commandSetBeamFrequency(frequency)`
- [x] 11. Observation weapons fields: missile stock per type, tube count and per-tube load type, beam and shield frequency, enemy shield frequency
- [x] 12. Engine-backed visibility: an enemy player ship is reported only when `distance <= s:getLongRangeRadarRange()` and `not s:isRadarBlockedFrom({ox, oy}, enemy, s:getShortRangeRadarRange())` (positional `{ox, oy}` table, as in the native source example at `src/script.cpp:1738` — not `{x=…, y=…}`); otherwise `other_ship` is nil and no enemy-derived field is emitted. The same predicate runs inside the `target_ship` and `fire_tube` templates and refuses with `NOT_VISIBLE`, which the gateway maps to refusal code `NOT_VISIBLE`

## Verified engine surface

| Name | Kind | Source |
| --- | --- | --- |
| `getActivePlayerShips()` | global, compact 1..n table of `PlayerControl` entities — **the only ship enumeration used** | `src/script.cpp:1379` registration; `static int luaGetActivePlayerShips(lua_State* L)` builds a fresh table with `lua_rawseti(L, -2, index++)` |
| `getPlayerShip(i)` | global, 1-based, **has holes and is never used here**; `getPlayerShip(-1)` also unused | `src/script.cpp:1374`, `static sp::ecs::Entity luaGetPlayerShip(int index)` |
| `Entity:getCallSign()` | string | `scripts/api/entity/spaceobject.lua` |
| `Entity:getFaction()` | faction name string | `scripts/api/entity/spaceobject.lua` `return f.entity.components.faction_info.name` |
| `Entity:getPosition()` | `x, y` numbers | `scripts/api/entity/spaceobject.lua` `return table.unpack(...)` |
| `Entity:getVelocity()` | `vx, vy` numbers | `scripts/api/entity/spaceobject.lua` `return table.unpack(...)` |
| `Entity:getRotation()`, `Entity:getHeading()` | numbers | `scripts/api/entity/spaceobject.lua` |
| `Entity:getEnergyLevel()`, `Entity:getEnergyLevelMax()` | numbers | `scripts/api/entity/playerspaceship.lua` (max at line 231) |
| `Entity:getSystemPower/Coolant/Health/Heat(name)` | numbers | `scripts/api/entity/spaceship.lua` via `__getSystemByName` |
| `impulse_engine.request`, `impulse_engine.actual` | component members (the only component access kept, live-confirmed) | `src/script/components.cpp` `ComponentHandler<ImpulseEngine>::name("impulse_engine")`, `BIND_MEMBER(ImpulseEngine, request)`, `BIND_MEMBER(ImpulseEngine, actual)` |
| `Entity:getHull()`, `Entity:getHullMax()` | hull values | live-confirmed on the running build (arc-g26g); not in `spaceobject.lua`, `spaceship.lua`, `playerspaceship.lua` at the pinned commit, and `scripts/api/entity/shipTemplateBasedObject.lua` 404s there |
| `Entity:getShieldCount()`, `Entity:getShieldLevel(i)`, `Entity:getShieldMax(i)` | shields, **0-based** over `getShieldCount()` | live-confirmed on the running build (arc-g26g), same caveat |
| `Entity:getWeaponTubeCount()` | number of tubes | `spaceship.lua` `function Entity:getWeaponTubeCount() if self.components.missile_tubes then return #self.components.missile_tubes end return 0 end` |
| `Entity:getWeaponTubeLoadType(index)` | string or nil, **0-based** (`index >= 0 and index < #tubes`), nil when none loaded | `spaceship.lua` `function Entity:getWeaponTubeLoadType(index) … if missile_type == "none" then return nil end return missile_type end` |
| `Entity:getWeaponStorage(type)` / `Entity:getWeaponStorageMax(type)` | numbers; `string.lower(type)` matched against homing/nuke/mine/emp/hvli | `spaceship.lua` |
| `Entity:getBeamFrequency()` | beam frequency index, `components.beam_weapons.frequency`, 0 without beams | `spaceship.lua` `function Entity:getBeamFrequency() if self.components.beam_weapons then return self.components.beam_weapons.frequency end return 0 end` |
| `Entity:getShieldsFrequency()` | shield frequency index, readable on any entity, 0 without shields; also used for the enemy ship | `spaceship.lua` `function Entity:getShieldsFrequency() if self.components.shields then return self.components.shields.frequency end return 0 end` |
| `Entity:getLongRangeRadarRange()` / `Entity:getShortRangeRadarRange()` | own radar ranges, 50000 / 5000 defaults | `playerspaceship.lua:894` and `playerspaceship.lua:901` (live-confirmed by arc-g26g) |
| `Entity:isRadarBlockedFrom(from_position, other, short_range)` | true when the engine blocks the contact; the visibility predicate. `from_position` is a **positional** `{x, y}` table | `src/script.cpp:1738` (live-confirmed by arc-g26g); not in the three entity Lua files at the pinned commit |
| `Entity:commandSetTarget(target)` | command | `scripts/api/entity/playerspaceship.lua`, C++ `luaCommandSetTarget` in `src/script.cpp` (writes `Target::entity`) |
| `Entity:commandLoadTube(tube_nr, missile_type)` | weapons command | `playerspaceship.lua` `function Entity:commandLoadTube(tube_nr, missile_type) commandLoadTube(self, tube_nr, missile_type) …`, doc example `ship:commandLoadTube(0, "HVLI")` |
| `Entity:commandFireTubeAtTarget(index, target)` | weapons command | `playerspaceship.lua` `function Entity:commandFireTubeAtTarget(index, target) commandFireTubeAtTarget(self, index, target) …`, doc example `ship:commandFireTubeAtTarget(0, enemy)` |
| `Entity:commandSetShields(enabled)` | weapons command | `playerspaceship.lua` `function Entity:commandSetShields(enabled) commandSetShields(self, enabled) …`, doc example `ship:commandSetShields(true)` |
| `Entity:commandSetBeamFrequency(frequency)` | weapons command, "Valid values are 0 to 20" | `playerspaceship.lua` `function Entity:commandSetBeamFrequency(frequency) commandSetBeamFrequency(self, frequency) …` |
| `Entity:commandTargetRotation/commandImpulse/commandSetSystemPowerRequest/commandSetSystemCoolantRequest` | commands | `scripts/api/entity/playerspaceship.lua` |
| `hasPlayerCrewAtPosition(s, station)` | global | `scripts/api/entity/playerspaceship.lua` `Entity:hasPlayerAtPosition` |
| `toJSON` | global | `src/script.cpp` `static int luaToJSON(lua_State* L)` |

Never used because they fail or do not exist: `getSpeed`, `getImpulseLevel`,
`getEnergyMax`, `getImpulse`, and every component-table access other than
`impulse_engine.actual`/`.request` (`hull.current`, `shields.entries`, … are
native userdata, not Lua tables — they made `/v1/observe` fail live with
`attempt to index` errors). Ship enumeration is always
`ipairs(getActivePlayerShips())`, never an index scan that can stop at a nil or at
a non-nil handle without methods.

The visibility gate is the engine's own radar logic and nothing more. It makes no
claim about hard cover from planets, asteroids or debris.