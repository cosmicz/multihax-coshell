# Thin real EmptyEpsilon adapter

**Status:** draft

Bead: multihax-xbi (coordinator arc-bhgx). Agent-only first demo: stock scenario, fixed ship and station bindings, no human seats. EmptyEpsilon headless with httpserver on 127.0.0.1:8080 is pending OC approval (bead multihax-runtime). Never substitute a fake world.

- [x] Loopback-only WorldPort posting fixed Lua to /exec.lua, with a 3 s timeout and HTTP 200 plus ERROR treated as failure (src/real/eeport.ts)
  verify: node src/real/main.ts --print-scripts
- [x] Fixed observation Lua (callsign, position, heading = rotation + 90, velocity, impulse, energy, and reactor, impulse and maneuver power, coolant, health and heat) plus a validating parser (src/real/observe.ts)
  verify: node src/real/main.ts --print-scripts
- [x] Bind the ship callsign from the first observation and claim helms and engineering for agent-helm and agent-eng through the gateway
- [x] Bounded rule agents: helm holds a heading or waypoint with impulse 0.5, stopping within 500 units; engineering keeps impulse power at 1.2, coolant at 2 or more, and backs off above 0.8 heat; 2 s tick and 10 intents per minute each (src/real/agents.ts)
- [x] Loop of observe, then agents, then gateway, with a spectator on 127.0.0.1:3000: GET /state JSON and GET / polling page (src/real/main.ts)
  verify: node src/real/main.ts --print-scripts
- [ ] Live run against headless EmptyEpsilon after OC approval: telemetry changes in response to agent heading, impulse and power commands
  verify: curl -s http://127.0.0.1:3000/state
- [x] VM-side bounded JSON API with bearer token in front of loopback /exec.lua (src/vmapi/server.ts)
- [x] Drive agents and spectator use VmApiPort over HTTPS; external role agents can POST /api/intent
- [x] RULE_CONTROLLERS switch so real role agents own helms and engineering via POST /api/intent
- [x] EE_API_TOKEN_FILE secret-file support