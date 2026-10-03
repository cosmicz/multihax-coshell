# Role-scoped ship command gateway
**Status:** draft

- [x] Model the WorldPort seam (`execLua(script) -> {status, body}`) and the seat registry (`epoch:ship:role`, mode, generation, leaseholder) in `src/gateway/types.ts` and `src/gateway/seats.ts`.
verify: node --test "test/gateway/**/*.test.ts"
- [x] Add the fake world port in `src/gateway/fake_port.ts` that records every script and can answer a receipt, an error body, a hang or a held call.
verify: node --test "test/gateway/**/*.test.ts"
- [x] Enforce the seat control plane: `claimAgent` refuses a HUMAN latched seat, `markHumanOccupied` bumps the generation, `resume` needs a vacant native seat, `pause` parks the seat.
verify: node --test "test/gateway/**/*.test.ts"
- [x] Allowlist intents per role and per system in `src/gateway/intents.ts` (helms heading/impulse, engineering power/coolant) and validate ranges before anything reaches the port.
verify: node --test "test/gateway/**/*.test.ts"
- [x] Render the fixed Lua templates in `src/gateway/lua.ts`: callsign guard, in-script occupancy guard over every covering station, then the command, then `toJSON({ok=true})`.
verify: node --test "test/gateway/**/*.test.ts"
- [x] Refuse with the single refusal enum before any port IO: UNKNOWN_INTENT, WRONG_ROLE, NOT_LEASEHOLDER, STALE_GENERATION, EPOCH_MISMATCH, STALE_OBSERVATION, SEAT_NOT_AGENT, OUT_OF_RANGE, DUPLICATE_MISMATCH, OCCUPIED.
verify: node --test "test/gateway/**/*.test.ts"
- [x] Add request_id idempotency in `src/gateway/gateway.ts`: identical payload replays the prior result with no new IO, a different payload is DUPLICATE_MISMATCH.
verify: node --test "test/gateway/**/*.test.ts"
- [x] Classify port answers as accepted/upstream_receipt, refused(OCCUPIED), failed or timeout, latch HUMAN on an OCCUPIED receipt and never retry a timeout.
verify: node --test "test/gateway/**/*.test.ts"
- [x] Serialize writes per ship and discard queued and in-flight results whose generation moved on.
verify: node --test "test/gateway/**/*.test.ts"
- [x] Keep the suite deterministic in `test/gateway/`: one script per accepted write, zero scripts per refusal, and coverage of the occupancy guard for every covering station.
verify: node --test "test/gateway/**/*.test.ts"

## Notes

- Node v24 treats a positional argument to `--test` as a glob, so the runnable form of the verify line is `node --test test/gateway/*.test.ts`; a bare `node --test` from the repository root runs this suite together with the companion and scenario suites.
- `src/gateway/harness.ts` ships the shared test harness (fake port plus envelope builder) next to the fake port, following the `src/companion/fake.ts` precedent, so no helper file sits under `test/`.
- The rendered calls are emitted as the bridge globals named in the design (`commandImpulse`, `commandTargetRotation`, `commandSetSystemPowerRequest`, `commandSetSystemCoolantRequest`); if the real EmptyEpsilon bridge exposes them as `setCommand*`, only `commandLine` in `src/gateway/lua.ts` changes.