import assert from "node:assert/strict";
import test from "node:test";
import {
  createGatewayHarness,
  renderLua,
  STATION_COVERAGE,
  type SeatRole,
  type ValidatedIntent,
} from "../../src/gateway/index.ts";

const GOLDEN_HELMS_IMPULSE = [
  "local s = getPlayerShip(-1)",
  'if s == nil or s:getCallSign() ~= "HORIZON" then return toJSON({error="SHIP_MISMATCH"}) end',
  'if hasPlayerCrewAtPosition(s, "helms") or hasPlayerCrewAtPosition(s, "tactical") or hasPlayerCrewAtPosition(s, "singlepilot") then return toJSON({refused="OCCUPIED"}) end',
  "commandImpulse(0.500)",
  "return toJSON({ok=true})",
].join("\n");

test("the helms template is byte for byte the fixed design template", async () => {
  const demo = createGatewayHarness();
  await demo.gateway.submit(demo.envelope({ args: { impulse_fraction: 0.5 } }));

  assert.equal(demo.port.scriptCount, 1);
  assert.equal(demo.port.lastScript(), GOLDEN_HELMS_IMPULSE);
});

test("the script guards the callsign and every covering station before the command", () => {
  for (const role of ["helms", "engineering"] as SeatRole[]) {
    const script = renderLua({
      callsign: "HORIZON",
      role,
      intent: { intent: "impulse_fraction", impulse_fraction: 0 },
    });
    const lines = script.split("\n");
    assert.equal(lines[0], "local s = getPlayerShip(-1)");
    assert.equal(
      lines[1],
      'if s == nil or s:getCallSign() ~= "HORIZON" then return toJSON({error="SHIP_MISMATCH"}) end',
    );
    for (const position of STATION_COVERAGE[role]) {
      assert.equal(
        script.includes(`hasPlayerCrewAtPosition(s, "${position}")`),
        true,
        `${role} must check ${position}`,
      );
    }
    assert.equal(script.includes('toJSON({refused="OCCUPIED"})'), true);
    assert.equal(
      script.indexOf("hasPlayerCrewAtPosition") < script.indexOf("commandImpulse"),
      true,
    );
    assert.equal(lines[lines.length - 1], "return toJSON({ok=true})");
  }
});

test("a rendered script is exactly one call per covering station", () => {
  const script = renderLua({
    callsign: "HORIZON",
    role: "engineering",
    intent: { intent: "system_power_request", system: "warp", level: 1 },
  });
  const guards = script.match(/hasPlayerCrewAtPosition\(s, "[a-z+]+"\)/g) ?? [];
  assert.deepEqual(guards, [
    'hasPlayerCrewAtPosition(s, "engineering")',
    'hasPlayerCrewAtPosition(s, "engineering+")',
    'hasPlayerCrewAtPosition(s, "powermanagement")',
    'hasPlayerCrewAtPosition(s, "damagecontrol")',
    'hasPlayerCrewAtPosition(s, "singlepilot")',
  ]);
  assert.equal(guards.length, STATION_COVERAGE.engineering.length);
});

test("numbers are interpolated with a fixed precision", () => {
  const cases: Array<[ValidatedIntent, string]> = [
    [{ intent: "heading_degrees", target_rotation_degrees: 179.987 }, "commandTargetRotation(179.99)"],
    [{ intent: "impulse_fraction", impulse_fraction: 0.12345 }, "commandImpulse(0.123)"],
    [{ intent: "impulse_fraction", impulse_fraction: -0 }, "commandImpulse(0.000)"],
    [
      { intent: "system_power_request", system: "reactor", level: 0 },
      'commandSetSystemPowerRequest("reactor", 0.0)',
    ],
    [
      { intent: "system_coolant_request", system: "frontshield", level: 10 },
      'commandSetSystemCoolantRequest("frontshield", 10.0)',
    ],
  ];
  for (const [intent, expected] of cases) {
    const script = renderLua({ callsign: "HORIZON", role: "helms", intent });
    assert.equal(script.includes(expected), true, expected);
  }
});

test("the callsign is the only free text in the template and it is validated", () => {
  const script = renderLua({
    callsign: "HORIZON TWO",
    role: "helms",
    intent: { intent: "impulse_fraction", impulse_fraction: 0 },
  });
  assert.equal(script.includes('"HORIZON TWO"'), true);
  assert.throws(
    () =>
      renderLua({
        callsign: 'HORIZON" .. toJSON({ok=true}) .. "',
        role: "helms",
        intent: { intent: "impulse_fraction", impulse_fraction: 0 },
      }),
    TypeError,
  );
});

test("an occupancy guard is emitted for every station that covers the seat", async () => {
  const demo = createGatewayHarness();
  await demo.gateway.submit(
    demo.envelope({ role: "engineering", intent: "system_coolant_request", args: { system: "maneuver", level: 1 } }),
  );

  const script = demo.port.lastScript();
  for (const position of STATION_COVERAGE.engineering) {
    assert.equal(script.includes(`hasPlayerCrewAtPosition(s, "${position}")`), true, position);
  }
  assert.equal(script.includes('hasPlayerCrewAtPosition(s, "helms")'), false);
  assert.equal(script.includes('hasPlayerCrewAtPosition(s, "tactical")'), false);
});