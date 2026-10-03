-- Name: multihax arena
-- Description: Two LLM-crewed Atlantis ships duel around one planet, one moon and one nebula. No stations, no CPU ships.
-- Type: PvP
-- API sources, all from daid/EmptyEpsilon at 310bebd12f14d82239070445ad190d13680f124b:
--   scripts/scenario_81_pvp.lua: PlayerSpaceship setters, isValid, victory
--   scripts/scenario_88_chaos.lua choosePlanet: Planet setters and setOrbit
--   scripts/scenario_00_basic.lua: Nebula():setPosition

function init()
    planet = Planet():setPosition(9000, -2000):setPlanetRadius(3000):setDistanceFromMovementPlane(-2000):setCallSign("Kessel")
    planet:setPlanetSurfaceTexture("planets/planet-1.png")
    planet:setPlanetCloudTexture("planets/clouds-1.png")
    planet:setPlanetAtmosphereTexture("planets/atmosphere.png")
    planet:setPlanetAtmosphereColor(0.2, 0.2, 1.0)
    planet:setAxialRotationTime(400)

    moon = Planet():setPosition(9000, -7500):setPlanetRadius(300):setDistanceFromMovementPlane(-150):setCallSign("Vesta")
    moon:setPlanetSurfaceTexture("planets/moon-1.png")
    moon:setAxialRotationTime(80)
    moon:setOrbit(planet, 300)

    Nebula():setPosition(9000, 10000)

    gallipoli = PlayerSpaceship():setFaction("Human Navy"):setTemplate("Atlantis"):setPosition(7000, 10000):setCallSign("HNS Gallipoli"):setScannedByFaction("Kraylor", false)
    crusader = PlayerSpaceship():setFaction("Kraylor"):setTemplate("Atlantis"):setPosition(11000, 10000):setCallSign("Crusader Naa'Tvek"):setScannedByFaction("Human Navy", false)
end

function update(delta)
    if not gallipoli:isValid() then
        victory("Kraylor")
    elseif not crusader:isValid() then
        victory("Human Navy")
    end
end