import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakeWorldPort,
  createGatewayHarness,
  formatNumber,
  isValidCallsign,
  RoleScopedGateway,
} from "../../src/gateway/index.ts";

const INJECTIONS = [
  'reactor") end os.execute("id") --',
  "reactor'); print(1); --",
  'reactor\\" .. os.time() .. \\"',
  "../../reactor",
  "REACTOR",
  "reactor ",
  "",
];

test("an injection attempt in a system name makes zero scripts", async () => {
  const demo = createGatewayHarness();
  for (const system of INJECTIONS) {
    for (const intent of ["system_power_request", "system_coolant_request"] as const) {
      const result = await demo.gateway.submit(
        demo.envelope({ role: "engineering", intent, args: { system, level: 1 } }),
      );
      assert.equal(result.outcome, "refused");
      if (result.outcome !== "refused") throw new Error("expected refused");
      assert.equal(result.code, "OUT_OF_RANGE");
    }
  }
  assert.equal(demo.port.scriptCount, 0);
});

test("NaN and Infinity values make zero scripts", async () => {
  const demo = createGatewayHarness();
  const values = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "0.5",
    null,
    undefined,
    {},
  ];
  for (const value of values) {
    const impulse = await demo.gateway.submit(
      demo.envelope({ args: { impulse_fraction: value } }),
    );
    assert.equal(impulse.outcome, "refused");
    const heading = await demo.gateway.submit(
      demo.envelope({ intent: "heading_degrees", args: { heading_degrees: value } }),
    );
    assert.equal(heading.outcome, "refused");
    const power = await demo.gateway.submit(
      demo.envelope({
        role: "engineering",
        intent: "system_power_request",
        args: { system: "reactor", level: value },
      }),
    );
    assert.equal(power.outcome, "refused");
    if (power.outcome !== "refused") throw new Error("expected refused");
    assert.equal(power.code, "OUT_OF_RANGE");
  }
  assert.equal(demo.port.scriptCount, 0);
});

test("formatNumber refuses non finite input instead of interpolating it", () => {
  assert.throws(() => formatNumber(Number.NaN, 3), RangeError);
  assert.throws(() => formatNumber(Number.POSITIVE_INFINITY, 3), RangeError);
  assert.throws(() => formatNumber(Number.NEGATIVE_INFINITY, 2), RangeError);
  assert.equal(formatNumber(-0, 3), "0.000");
  assert.equal(formatNumber(0.5, 3), "0.500");
  assert.equal(formatNumber(-1, 1), "-1.0");
});

test("a rendered script contains only the callsign, allowlisted stations and numbers", async () => {
  const demo = createGatewayHarness();
  const result = await demo.gateway.submit(
    demo.envelope({
      role: "engineering",
      intent: "system_power_request",
      args: { system: "missilesystem", level: 2.5 },
    }),
  );
  assert.equal(result.outcome, "accepted");

  const script = demo.port.lastScript();
  const quoted = [...script.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(quoted, [
    "HORIZON",
    "SHIP_MISMATCH",
    "engineering",
    "engineering+",
    "powermanagement",
    "damagecontrol",
    "singlepilot",
    "OCCUPIED",
    "missilesystem",
  ]);
  assert.equal(script.includes("os."), false);
  assert.equal(script.includes("--"), false);
  assert.equal(script.includes("2.5"), true);
});

test("a callsign that could break out of the lua string is rejected at startup", () => {
  const hostile = [
    'HORIZON" .. os.time() .. "',
    "HORIZON\\",
    "HORIZON'",
    "HORIZON\n",
    "HORIZON;",
    "HORIZON}}",
  ];
  for (const ship of hostile) {
    assert.throws(
      () => new RoleScopedGateway({ ship, epoch: 7 }, createFakeWorldPort()),
      TypeError,
    );
  }
  assert.equal(isValidCallsign("HORIZON"), true);
  assert.equal(isValidCallsign('HORIZON" .. os.time()'), false);
});