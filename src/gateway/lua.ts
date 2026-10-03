import type { ValidatedIntent } from "./intents.ts";
import { STATION_COVERAGE } from "./intents.ts";
import { CALLSIGN_PATTERN, isValidCallsign } from "./types.ts";
import type { SeatRole } from "./types.ts";

export { CALLSIGN_PATTERN, isValidCallsign };

const NUMERIC_LITERAL = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/;

function escapeLuaString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'");
  return `"${escaped}"`;
}

export function formatNumber(value: number, digits: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`refusing to interpolate non-finite number: ${value}`);
  }
  const normalized = value === 0 ? 0 : value;
  const rendered = normalized.toFixed(digits);
  if (!NUMERIC_LITERAL.test(rendered)) {
    throw new RangeError(`unexpected numeric rendering: ${rendered}`);
  }
  return rendered;
}

export function luaString(value: string): string {
  const safeForLongBracket =
    !value.includes("]") && !value.includes("\n") && !value.includes("\r");
  if (safeForLongBracket) {
    return `[==[${value}]==]`;
  }
  return escapeLuaString(value);
}

export function shipLookup(callsign: string): string[] {
  if (!isValidCallsign(callsign)) {
    throw new TypeError(`invalid callsign: ${String(callsign)}`);
  }
  const wanted = luaString(callsign);
  return [
    "local s = nil",
    "for _, candidate in ipairs(getActivePlayerShips()) do",
    `  if candidate:getCallSign() == ${wanted} then s = candidate break end`,
    "end",
    'if s == nil then return toJSON({error="SHIP_NOT_FOUND"}) end',
  ];
}

export function occupancyGuard(callsign: string, role: SeatRole): string[] {
  const stations = STATION_COVERAGE[role];
  const checks = stations
    .map((position) => `hasPlayerCrewAtPosition(s, ${luaString(position)})`)
    .join(" or ");
  return [
    ...shipLookup(callsign),
    `if s:getCallSign() ~= ${luaString(callsign)} then return toJSON({error="SHIP_MISMATCH"}) end`,
    `if ${checks} then return toJSON({refused="OCCUPIED"}) end`,
  ];
}

export function enemyShipLookup(enemyCallsign: string): string[] {
  if (!isValidCallsign(enemyCallsign)) {
    throw new TypeError(`invalid target callsign: ${String(enemyCallsign)}`);
  }
  const wanted = luaString(enemyCallsign);
  return [
    "local enemy = nil",
    "for _, candidate in ipairs(getActivePlayerShips()) do",
    `  if candidate:getCallSign() == ${wanted} then enemy = candidate break end`,
    "end",
    'if enemy == nil then return toJSON({error="TARGET_NOT_FOUND"}) end',
    "if enemy:getFaction() == s:getFaction() then",
    '  return toJSON({error="TARGET_SAME_FACTION"})',
    "end",
    "local long_range = s:getLongRangeRadarRange()",
    "local short_range = s:getShortRangeRadarRange()",
    "local ox, oy = s:getPosition()",
    "local ex, ey = enemy:getPosition()",
    "local enemy_distance = math.sqrt((ex - ox) * (ex - ox) + (ey - oy) * (ey - oy))",
    "local visible = enemy_distance <= long_range",
    "if visible and s:isRadarBlockedFrom({x=ox, y=oy}, enemy, short_range) then visible = false end",
    'if not visible then return toJSON({refused="NOT_VISIBLE"}) end',
  ];
}

export function formatTubeIndex(value: number): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`refusing to interpolate a non-integer index: ${String(value)}`);
  }
  return String(value);
}

function commandLine(intent: ValidatedIntent): string {
  switch (intent.intent) {
    case "heading_degrees":
      return `s:commandTargetRotation(${formatNumber(intent.target_rotation_degrees, 2)})`;
    case "impulse_fraction":
      return `s:commandImpulse(${formatNumber(intent.impulse_fraction, 3)})`;
    case "system_power_request":
      return `s:commandSetSystemPowerRequest(${luaString(intent.system)}, ${formatNumber(intent.level, 1)})`;
    case "system_coolant_request":
      return `s:commandSetSystemCoolantRequest(${luaString(intent.system)}, ${formatNumber(intent.level, 1)})`;
    case "target_ship":
      return [...enemyShipLookup(intent.callsign), "s:commandSetTarget(enemy)"].join("\n");
    case "load_tube":
      return `s:commandLoadTube(${formatTubeIndex(intent.tube)}, ${luaString(intent.weapon)})`;
    case "fire_tube":
      return [
        ...enemyShipLookup(intent.callsign),
        `s:commandFireTubeAtTarget(${formatTubeIndex(intent.tube)}, enemy)`,
      ].join("\n");
    case "set_shields":
      return `s:commandSetShields(${intent.active ? "true" : "false"})`;
    case "set_beam_frequency":
      return `s:commandSetBeamFrequency(${formatTubeIndex(intent.frequency)})`;
  }
}

export type LuaRenderInput = {
  callsign: string;
  role: SeatRole;
  intent: ValidatedIntent;
};

export function renderLua(input: LuaRenderInput): string {
  if (!isValidCallsign(input.callsign)) {
    throw new TypeError(`invalid callsign: ${String(input.callsign)}`);
  }
  return [
    ...occupancyGuard(input.callsign, input.role),
    commandLine(input.intent),
    "return toJSON({ok=true})",
  ].join("\n");
}