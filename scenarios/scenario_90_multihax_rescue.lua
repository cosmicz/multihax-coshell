-- Name: Low Power Rescue
-- Description: The reactor bus of MULTIHAX-1 failed during a debris strike: the impulse drive is offline, energy reserves are near empty, coolant capacity is halved and automatic repair is switched off. A stranded Human Navy courier, DISTRESS-7, is broadcasting a distress call 8U east of you. Engineering has to bring the impulse drive back by hand and balance power and coolant, then the crew has to hold station next to the wreck for 20 seconds to complete the rescue.
-- Type: Scripted
--- A single-ship, no-hostile demonstration scenario. Difficulty comes from damage, power and coolant management, not from enemies.
--- Objective: stay within 1500 units of DISTRESS-7, below 10 units per second, for 20 continuous seconds.
--- Failure: the player ship is lost, DISTRESS-7 is destroyed, or 6 minutes run out.

-- Mission constants. Everything else is scenario state, kept in file-local variables on purpose:
-- these values are NOT reachable from any other Lua environment (see docs/plans/jpj-mission.md).
local HOLD_REQUIRED = 20.0       -- seconds of continuous hold needed for the rescue
local HOLD_RANGE = 1500.0       -- units; maximum distance to DISTRESS-7 while holding
local HOLD_SPEED_LIMIT = 10.0   -- units per second; maximum speed while holding
local MISSION_TIME_LIMIT = 360.0 -- seconds; the 6 minute time limit
local TARGET_POSITION_X = 8000.0 -- DISTRESS-7 sits 8000 units east of the origin
local TARGET_POSITION_Y = 0.0
local STATE_PREFIX = "multihax:v1" -- marker that identifies the mission-state bridge payload

local player                    -- the one PlayerSpaceship, callsign MULTIHAX-1
local target                    -- the stranded ship, callsign DISTRESS-7
local hold_time = 0.0
local mission_time = MISSION_TIME_LIMIT
local published_state = nil    -- last payload written to the target, to avoid rewriting it every frame

--- Builds the compact mission-state payload.
-- The payload is deliberately made of key=value pairs separated by ";" so that a reader only has
-- to split the string. Format: multihax:v1;phase=<phase>;hold=<seconds>;status=<status>
local function buildState(phase, hold, status)
    return string.format("%s;phase=%s;hold=%.1f;status=%s", STATE_PREFIX, phase, hold, status)
end

--- Publishes the mission state on the DISTRESS-7 entity, which is the only object both the scenario
--- environment and any outside HTTP script environment can reach.
-- UNVERIFIED at runtime: see docs/plans/jpj-mission.md, "Mission-state bridge".
-- scripts/api/entity/spaceobject.lua: setDescriptions(unscanned, scanned) writes all four scan-state
-- descriptions in one call, so getDescription() returns the same payload for every scan state.
local function publishState(phase, hold, status)
    if target == nil or not target:isValid() then return end
    local payload = buildState(phase, hold, status)
    if payload ~= published_state then
        published_state = payload
        target:setDescriptions(payload, payload)
    end
end

--- Distance in units between two entities, using their map coordinates.
-- scripts/api/entity/spaceobject.lua: Entity:getPosition() returns x, y in game units.
local function distanceBetween(a, b)
    local ax, ay = a:getPosition()
    local bx, by = b:getPosition()
    local dx, dy = ax - bx, ay - by
    return math.sqrt(dx * dx + dy * dy)
end

--- Speed of an entity in units per second.
-- scripts/api/entity/spaceobject.lua: Entity:getVelocity() returns the 2D velocity vector.
local function speedOf(obj)
    local vx, vy = obj:getVelocity()
    if vx == nil or vy == nil then return 0.0 end
    return math.sqrt(vx * vx + vy * vy)
end

--- Initializes the scenario.
function init()
    -- The player ship. scripts/api/entity/playerspaceship.lua: PlayerSpaceship() creates the ship,
    -- setFaction() comes from scripts/api/entity/spaceobject.lua and setTemplate() from
    -- scripts/api/entity/shiptemplatebasedobject.lua. "Atlantis X23" is a stock player ship template,
    -- see scripts/scenario_00_basic.lua (pinned 310bebd).
    player = PlayerSpaceship():setFaction("Human Navy"):setTemplate("Atlantis X23")
    player:setCallSign("MULTIHAX-1")
    -- scripts/api/entity/spaceobject.lua: Entity:setPosition(x, y)
    player:setPosition(0, 0)
    player:setRotation(0)

    -- The power fault the crew has to fix. Every value below is a one-shot starting condition that
    -- the update loop never touches, so nothing here heals or moves the ship by itself.
    -- scripts/api/entity/spaceship.lua: Entity:setImpulseMaxSpeed(forward, reverse)
    player:setImpulseMaxSpeed(250, 250)
    -- scripts/api/entity/spaceship.lua: Entity:setSystemHealth(system, amount). Health below 0.0
    -- disables the system, so 0.0 leaves the impulse drive dead until a repair crew works on it.
    player:setSystemHealth("impulse", 0.0)
    player:setSystemHealth("maneuver", 0.5)
    player:setSystemHealth("reactor", 0.6)
    -- scripts/api/entity/playerspaceship.lua: Entity:setMaxCoolant(amount). The default is 10, so
    -- 2.0 means engineering can never give the impulse drive full coolant.
    player:setMaxCoolant(2.0)
    -- scripts/api/entity/spaceship.lua: Entity:setSystemPower(system, level) and
    -- Entity:setSystemCoolant(system, amount). Both drives start dark and cold, so the reactor has
    -- headroom but the crew still has to raise impulse power by hand on the engineering screen.
    player:setSystemPower("reactor", 1.0)
    player:setSystemPower("impulse", 0.0)
    player:setSystemPower("maneuver", 0.0)
    player:setSystemCoolant("impulse", 0.0)
    player:setSystemCoolant("maneuver", 0.0)
    -- scripts/api/entity/playerspaceship.lua: Entity:setEnergyLevel(amount) drains the reactor bank.
    player:setEnergyLevel(150)
    -- scripts/api/entity/playerspaceship.lua: Entity:setAutoCoolant(enabled) and
    -- Entity:commandSetAutoRepair(enabled). Automatic coolant and automatic repair are switched off
    -- so the only way to fix the impulse drive is engineering crew in the impulse drive room.
    player:setAutoCoolant(false)
    player:commandSetAutoRepair(false)

    -- The stranded ship. scripts/api/entity/cpuship.lua: CpuShip() creates an AI ship whose default
    -- order is "roaming"; scripts/api/entity/shiptemplatebasedobject.lua: setTemplate() applies
    -- "Phobos T3", which scripts/scenario_00_basic.lua also uses.
    target = CpuShip():setTemplate("Phobos T3"):setFaction("Human Navy")
    target:setCallSign("DISTRESS-7")
    -- scripts/api/entity/spaceobject.lua: Entity:setPosition(x, y)
    target:setPosition(TARGET_POSITION_X, TARGET_POSITION_Y)
    target:setRotation(180)
    -- scripts/api/entity/shiptemplatebasedobject.lua: Entity:setTypeName(name)
    target:setTypeName("Stranded Courier")
    -- scripts/api/entity/cpuship.lua: Entity:orderIdle() keeps the ship parked where it is and stops
    -- it from acquiring targets.
    target:orderIdle()
    -- scripts/api/entity/spaceship.lua: Entity:setImpulseMaxSpeed(0, 0). The wreck has no thrust.
    target:setImpulseMaxSpeed(0, 0)
    -- scripts/api/entity/spaceobject.lua: Entity:setScanned(true) so science can read the payload.
    target:setScanned(true)

    hold_time = 0.0
    mission_time = MISSION_TIME_LIMIT
    published_state = nil
    publishState("search", 0.0, "running")

    -- scripts/api/entity/spaceobject.lua: Entity:sendCommsMessage(target, message) hails the player.
    target:sendCommsMessage(player, "Hail MULTIHAX-1. DISTRESS-7 is dead in the water. Reactor is cold, "
        .. "we cannot move. Please hold station next to us while we run our restart, stay off warp.")

    -- scripts/scenario_00_basic.lua (pinned 310bebd): globalMessage(text) shows on all main screens.
    globalMessage("MULTIHAX-1, the impulse drive is offline. Get engineering on the repair, then hold "
        .. "station within 1.5U of DISTRESS-7 for 20 seconds.")
end

--- Update.
--
-- @tparam number delta the time delta (in seconds)
function update(delta)
    -- A player ship that is gone can no longer hold station.
    if player == nil or not player:isValid() then
        publishState("lost", hold_time, "failure")
        -- scripts/scenario_00_basic.lua (pinned 310bebd): victory(faction) ends the scenario.
        victory("Kraylor")
        globalMessage("Mission: FAILED (MULTIHAX-1 was destroyed)")
        return
    end

    if target == nil or not target:isValid() then
        publishState("lost", hold_time, "failure")
        victory("Kraylor")
        globalMessage("Mission: FAILED (DISTRESS-7 no longer exists)")
        return
    end

    mission_time = mission_time - delta
    if mission_time <= 0 then
        publishState("search", hold_time, "failure")
        victory("Kraylor")
        globalMessage("Mission: FAILED (time has run out)")
        return
    end

    -- The hold condition: close to the wreck and essentially stationary.
    local in_range = distanceBetween(player, target) <= HOLD_RANGE
    local slow_enough = speedOf(player) <= HOLD_SPEED_LIMIT
    if in_range and slow_enough then
        hold_time = hold_time + delta
    else
        hold_time = 0.0
    end

    if hold_time >= HOLD_REQUIRED then
        publishState("complete", hold_time, "victory")
        victory("Human Navy")
        globalMessage("Mission: SUCCESS (DISTRESS-7 is under tow)")
        return
    end

    local phase = "holding"
    if not in_range then
        phase = "search"
    elseif not slow_enough then
        phase = "too_fast"
    end
    publishState(phase, hold_time, "running")

    -- scripts/scenario_00_basic.lua (pinned 310bebd): setBanner(text) drives the spectator banner.
    setBanner(string.format("MULTIHAX-1 -> DISTRESS-7   hold %.1f/%.0fs   time %d:%02d",
        hold_time, HOLD_REQUIRED, math.floor(mission_time / 60), math.floor(mission_time % 60)))
end