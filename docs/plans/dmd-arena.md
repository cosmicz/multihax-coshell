# multihax-dmd: simple PvP arena

Bead: multihax-dmd. One planet, one moon, one nebula, two player ships, no stations, no CPU ships.

- [x] 1. Write scenarios/scenario_91_multihax_arena.lua with only upstream-attested API calls (sources cited in its header)
- [x] 2. Planet "Kessel" at (9000, -2000) r3000; moon "Vesta" (r600) static at (9000, 23000), 6 km north of the ships' line; nebula at the ships' midpoint (9000, 10000)
- [x] 3. HNS Gallipoli (Human Navy, Atlantis) at (4000, 17000) and Crusader Naa'Tvek (Kraylor, Crucible) at (14000, 17000), 10 km apart with a clear line of sight 2 km north of the nebula edge, inside each other's 30 km long-range radar Navy faces east (setRotation 0) and Kraylor faces west (180), nose to nose.
- [ ] 4. VM switch to this scenario (arc-g26g) and live check that both ships and the three bodies appear