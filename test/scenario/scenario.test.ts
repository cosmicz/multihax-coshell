import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scenarioPath = fileURLToPath(
  new URL("../../scenarios/scenario_90_multihax_rescue.lua", import.meta.url),
);
const lua = readFileSync(scenarioPath, "utf8");

/** Returns the body of a top-level `function name(...)` block, up to the next top-level function. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
  if (start < 0) return "";
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^function \w+\(/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const initBody = functionBody(lua, "init");
const updateBody = functionBody(lua, "update");

test("scenario header declares name, description and type", () => {
  assert.match(lua, /^--\s*Name:\s*\S/m);
  assert.match(lua, /^--\s*Description:\s*\S/m);
  assert.match(lua, /^--\s*Type:\s*\S/m);
});

test("scenario defines init() and update(delta)", () => {
  assert.match(lua, /^function init\(\)/m);
  assert.match(lua, /^function update\(delta\)/m);
  assert.ok(initBody.length > 0, "init() body not found");
  assert.ok(updateBody.length > 0, "update() body not found");
});

test("both mission callsigns are present", () => {
  assert.match(lua, /MULTIHAX-1/);
  assert.match(lua, /DISTRESS-7/);
  assert.match(initBody, /setCallSign\("MULTIHAX-1"\)/);
  assert.match(initBody, /setCallSign\("DISTRESS-7"\)/);
});

test('update() can declare victory("Human Navy")', () => {
  assert.match(updateBody, /victory\("Human Navy"\)/);
});

test("mission-state bridge marker is present", () => {
  assert.match(lua, /multihax:v1/);
  assert.match(lua, /"%s;phase=%s;hold=%\.1f;status=%s"/);
});

test("update() never looks the ship up with getPlayerShip(-1)", () => {
  assert.doesNotMatch(updateBody, /getPlayerShip/);
});

test("update() never repairs a system with setSystemHealth", () => {
  assert.doesNotMatch(updateBody, /setSystemHealth\s*\([^)]*1\.0\s*\)/);
  assert.doesNotMatch(updateBody, /setSystemHealth/);
});

test("scenario never reaches out to an outside HTTP script", () => {
  assert.doesNotMatch(lua, /exec/i);
});

test("the hold conditions match the mission brief", () => {
  assert.match(lua, /HOLD_RANGE\s*=\s*1500\.0/);
  assert.match(lua, /HOLD_REQUIRED\s*=\s*20\.0/);
  assert.match(lua, /HOLD_SPEED_LIMIT\s*=\s*10\.0/);
  assert.match(lua, /MISSION_TIME_LIMIT\s*=\s*360\.0/);
  assert.match(updateBody, /hold_time\s*=\s*hold_time\s*\+\s*delta/);
  assert.match(updateBody, /hold_time\s*=\s*0\.0/);
  assert.match(updateBody, /hold_time\s*>=\s*HOLD_REQUIRED/);
});