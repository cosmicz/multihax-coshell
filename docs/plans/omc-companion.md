# Crew status and orders companion

**Status:** draft

- [x] Define the shared interfaces and constants in `src/companion/types.ts` (station roles `helms, engineering, weapons, science, relay` plus the app-level `captain` row, native occupancy, controller mode HUMAN/AGENT/PAUSED, mission status, order and timeline records, `STALE_AFTER_MS = 5000`, `ORDER_TEXT_MAX = 280`), erasable syntax only, explicit `.ts` import extensions.
  verify: node --test "test/companion/**/*.test.ts"
- [x] Implement `MemoryState` in `src/companion/state.ts`: `snapshot()` returns `{epoch, ship, seats, timeline, mission}`, every seat carries native occupancy, mode, generation, `observed_at`, `age_ms` and `stale` (`age_ms > 5000`), plus `validateOrderInput()` (known role, trimmed text of 1-280 characters), per-role inboxes and a bounded timeline.
  verify: node --test "test/companion/**/*.test.ts"
- [x] Implement the in-memory fake in `src/companion/fake.ts`: `MemoryController` (occupancy per seat, `pause` -> PAUSED, `resume` -> AGENT with a generation bump, HUMAN only while the native seat is reported occupied and PAUSED again once it is vacated, so an agent never resumes automatically, `OCCUPIED` refusals) and `createFakeCompanion()` seeding observations, occupancy and mission status.
  verify: node --test "test/companion/**/*.test.ts"
- [x] Render the single self-contained page in `src/companion/html.ts`: inline CSS and JS, seat table with native occupancy/mode/generation/age, orders timeline, captain order form, per-seat Pause and Resume buttons, the native EmptyEpsilon client notice, all user text HTML-escaped and never assigned through an HTML setter.
  verify: node --test "test/companion/**/*.test.ts"
- [x] Wire the routes in `src/companion/server.ts` with `createServer({state, controller})` over `node:http`: `GET /` (HTML), `GET /api/state` (JSON, seats older than 5 s marked stale), `POST /api/orders` (400 on bad role, empty or over-long text; 202 appends to the addressed inbox and timeline and actuates nothing), `POST /api/seats/:role/resume|pause` (409 with reason `OCCUPIED` when the controller reports the native seat occupied), 404/405 otherwise.
  verify: node --test "test/companion/**/*.test.ts"
- [x] Add the demo entry `src/companion/dev.ts` exporting `startDemoCompanion()` and listening on `PORT` (default 8080) when run directly, with a 2 s heartbeat that leaves one seat stale so the marker is visible.
  verify: node --test "test/companion/**/*.test.ts"
- [x] Cover it with `node:test` suites in `test/companion/`: state JSON shape, the exact role set, stale marking, order validation (400 for bad role, empty and 281-character text) with timeline append and no actuation, resume refused 409 when occupied and accepted when vacant (mode AGENT, generation bumped, HUMAN only while occupied), pause, page contains the native-client notice and no station control widgets, order text is escaped, mission "won" only when the scenario reports it, and the demo entry serves the page. Tests listen on port 0.
  verify: node --test "test/companion/**/*.test.ts"

Note: the verify command uses a glob because on Node v24.21.0 `node --test <directory>` resolves the directory as a module and fails with MODULE_NOT_FOUND.