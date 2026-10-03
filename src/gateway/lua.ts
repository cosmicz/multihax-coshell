import type { ValidatedIntent } from "./intents.ts";
import { STATION_COVERAGE } from "./intents.ts";
import type { SeatRole } from "./types.ts";

export const CALLSIGN_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;

const NUMERIC_LITERAL = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/;

export function isValidCallsign(value: unknown): value is string {
  return typeof value === "string" && CALLSIGN_PATTERN.test(value);
}

function luaString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

export function occupancyGuard(callsign: string, role: SeatRole): string[] {
  const stations = STATION_COVERAGE[role];
  const checks = stations
    .map((position) => `hasPlayerCrewAtPosition(s, ${luaString(position)})`)
    .join(" or ");
  return [
    "local s = getPlayerShip(-1)",
    `if s == nil or s:getCallSign() ~= ${luaString(callsign)} then return toJSON({error="SHIP_MISMATCH"}) end`,
    `if ${checks} then return toJSON({refused="OCCUPIED"}) end`,
  ];
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