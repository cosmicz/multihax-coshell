import { isValidCallsign, luaString } from "../gateway/lua.ts";
import type { EeExecResult, EeExecLuaPort } from "./eeport.ts";

export function buildObservationLua(callsign: string): string {
  if (!isValidCallsign(callsign)) {
    throw new TypeError(`invalid callsign: ${String(callsign)}`);
  }
  const wanted = luaString(callsign);
  return [
    "local s = nil",
    "local other = nil",
    "for _, candidate in ipairs(getActivePlayerShips()) do",
    `  if candidate:getCallSign() == ${wanted} then`,
    "    s = candidate",
    "  elseif other == nil then",
    "    other = candidate",
    "  end",
    "end",
    'if s == nil then return toJSON({error="SHIP_NOT_FOUND"}) end',
    "local x, y = s:getPosition()",
    "local vx, vy = s:getVelocity()",
    "local rot = s:getRotation()",
    "local heading = s:getHeading()",
    "local speed = math.sqrt(vx * vx + vy * vy)",
    "local impulse_level = 0.0",
    "local impulse_request = 0.0",
    "local drive = s.components.impulse_engine",
    "if drive ~= nil then",
    "  impulse_level = drive.actual",
    "  impulse_request = drive.request",
    "end",
    "local hull_level = s:getHull()",
    "local hull_max = s:getHullMax()",
    "local shield_count = s:getShieldCount()",
    "local shield_level = 0.0",
    "local shield_max = 0.0",
    "local shield_levels = {}",
    "local shield_maxes = {}",
    "for idx = 0, shield_count - 1 do",
    "  local level = s:getShieldLevel(idx)",
    "  local maximum = s:getShieldMax(idx)",
    "  shield_levels[idx] = level",
    "  shield_maxes[idx] = maximum",
    "  shield_level = shield_level + level",
    "  shield_max = shield_max + maximum",
    "end",
    "local other_callsign = false",
    "local other_faction = false",
    "local other_x = 0.0",
    "local other_y = 0.0",
    "local other_distance = 0.0",
    "local other_shield_frequency = 0",
    "if other ~= nil then",
    "  other_callsign = other:getCallSign()",
    "  local other_faction_name = other:getFaction()",
    "  if other_faction_name ~= nil then other_faction = other_faction_name end",
    "  local ox, oy = other:getPosition()",
    "  other_x = ox",
    "  other_y = oy",
    "  other_distance = math.sqrt((ox - x) * (ox - x) + (oy - y) * (oy - y))",
    "  other_shield_frequency = other:getShieldsFrequency()",
    "end",
    "local tube_count = s:getWeaponTubeCount()",
    "local tube_loads = {}",
    "for idx = 0, tube_count - 1 do",
    "  tube_loads[idx] = s:getWeaponTubeLoadType(idx)",
    "end",
    "return toJSON({",
    "  callsign = s:getCallSign(),",
    "  faction = s:getFaction(),",
    "  x = x,",
    "  y = y,",
    "  rotation = rot,",
    "  heading = heading,",
    "  velocity_x = vx,",
    "  velocity_y = vy,",
    "  speed = speed,",
    "  impulse_level = impulse_level,",
    "  impulse_request = impulse_request,",
    "  energy_level = s:getEnergyLevel(),",
    "  energy_max = s:getEnergyLevelMax(),",
    "  hull_level = hull_level,",
    "  hull_max = hull_max,",
    "  shield_count = shield_count,",
    "  shield_level = shield_level,",
    "  shield_max = shield_max,",
    "  shield_levels = shield_levels,",
    "  shield_maxes = shield_maxes,",
    "  shield_frequency = s:getShieldsFrequency(),",
    "  beam_frequency = s:getBeamFrequency(),",
    "  tube_count = tube_count,",
    "  tube_loads = tube_loads,",
    "  stock_homing = s:getWeaponStorage(\"Homing\"),",
    "  stock_homing_max = s:getWeaponStorageMax(\"Homing\"),",
    "  stock_nuke = s:getWeaponStorage(\"Nuke\"),",
    "  stock_nuke_max = s:getWeaponStorageMax(\"Nuke\"),",
    "  stock_mine = s:getWeaponStorage(\"Mine\"),",
    "  stock_mine_max = s:getWeaponStorageMax(\"Mine\"),",
    "  stock_emp = s:getWeaponStorage(\"EMP\"),",
    "  stock_emp_max = s:getWeaponStorageMax(\"EMP\"),",
    "  stock_hvli = s:getWeaponStorage(\"HVLI\"),",
    "  stock_hvli_max = s:getWeaponStorageMax(\"HVLI\"),",
    "  other_callsign = other_callsign,",
    "  other_faction = other_faction,",
    "  other_x = other_x,",
    "  other_y = other_y,",
    "  other_distance = other_distance,",
    "  other_shield_frequency = other_shield_frequency,",
    "  systems = {",
    '    reactor = { power = s:getSystemPower("reactor"), coolant = s:getSystemCoolant("reactor"),',
    '      health = s:getSystemHealth("reactor"), heat = s:getSystemHeat("reactor") },',
    '    impulse = { power = s:getSystemPower("impulse"), coolant = s:getSystemCoolant("impulse"),',
    '      health = s:getSystemHealth("impulse"), heat = s:getSystemHeat("impulse") },',
    '    maneuver = { power = s:getSystemPower("maneuver"), coolant = s:getSystemCoolant("maneuver"),',
    '      health = s:getSystemHealth("maneuver"), heat = s:getSystemHeat("maneuver") }',
    "  }",
    "})",
  ].join("\n");
}

export function observationLua(callsign: string): string {
  return buildObservationLua(callsign);
}

export const OBSERVED_SYSTEMS = ["reactor", "impulse", "maneuver"] as const;
export type ObservedSystem = (typeof OBSERVED_SYSTEMS)[number];

export type SystemReading = {
  power: number;
  coolant: number;
  health: number;
  heat: number;
};

export const MISSILE_SLOTS = ["homing", "nuke", "mine", "emp", "hvli"] as const;
export type MissileSlot = (typeof MISSILE_SLOTS)[number];

export type MissileStock = {
  stock: number;
  max: number;
};

export type OtherShip = {
  callsign: string;
  faction: string | null;
  position: { x: number; y: number };
  distance: number;
};

export type Observation = {
  callsign: string;
  faction: string | null;
  position: { x: number; y: number };
  rotation: number;
  heading: number;
  velocity: { x: number; y: number };
  speed: number;
  impulse_level: number;
  impulse_request: number;
  energy_level: number;
  energy_max: number;
  hull_level: number;
  hull_max: number;
  shield_count: number;
  shield_level: number;
  shield_max: number;
  shield_levels: number[];
  shield_maxes: number[];
  shield_frequency: number;
  beam_frequency: number;
  tube_count: number;
  tube_loads: (string | null)[];
  missiles: Record<MissileSlot, MissileStock>;
  other_ship: OtherShip | null;
  systems: Record<ObservedSystem, SystemReading>;
};

export type ObservationErrorCode =
  | "PORT_ERROR"
  | "HTTP_ERROR"
  | "LUA_ERROR"
  | "INVALID_JSON"
  | "NO_PLAYER_SHIP"
  | "SHIP_NOT_FOUND"
  | "INVALID_FIELD";

export type ObservationResult =
  | { ok: true; observation: Observation; raw: string }
  | {
      ok: false;
      code: ObservationErrorCode;
      detail: string;
      raw: string;
    };

export type ObservationTick = {
  at: number;
  result: ObservationResult;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readSystem(value: unknown, name: string): SystemReading | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${name}: not an object`;
  }
  const record = value as Record<string, unknown>;
  const power = finite(record["power"]);
  const coolant = finite(record["coolant"]);
  const health = finite(record["health"]);
  const heat = finite(record["heat"]);
  if (power === null || coolant === null || health === null || heat === null) {
    return `${name}: power/coolant/health/heat must all be finite numbers`;
  }
  return { power, coolant, health, heat };
}

export function parseObservationBody(body: string): ObservationResult {
  if (body.includes("ERROR")) {
    return {
      ok: false,
      code: "LUA_ERROR",
      detail: "engine reported a lua error for the observation body",
      raw: body,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      code: "INVALID_JSON",
      detail: "observation body is not valid json",
      raw: body,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "INVALID_JSON",
      detail: "observation body is not a json object",
      raw: body,
    };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record["error"] === "string") {
    const engineError = String(record["error"]);
    const code: ObservationErrorCode =
      engineError === "NO_PLAYER_SHIP"
        ? "NO_PLAYER_SHIP"
        : engineError === "SHIP_NOT_FOUND"
          ? "SHIP_NOT_FOUND"
          : "LUA_ERROR";
    return {
      ok: false,
      code,
      detail: `engine reported ${engineError}`,
      raw: body,
    };
  }
  const callsign = record["callsign"];
  if (typeof callsign !== "string" || callsign.length === 0) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: "callsign must be a non-empty string",
      raw: body,
    };
  }
  const numbers: Record<string, number> = {};
  const required = [
    "x",
    "y",
    "rotation",
    "heading",
    "velocity_x",
    "velocity_y",
    "speed",
    "impulse_level",
    "impulse_request",
    "energy_level",
    "energy_max",
    "hull_level",
    "hull_max",
    "shield_count",
    "shield_level",
    "shield_max",
    "shield_frequency",
    "beam_frequency",
    "tube_count",
  ] as const;
  for (const field of required) {
    const value = finite(record[field]);
    if (value === null) {
      return {
        ok: false,
        code: "INVALID_FIELD",
        detail: `${field} must be a finite number`,
        raw: body,
      };
    }
    numbers[field] = value;
  }
  const missiles = {} as Record<MissileSlot, MissileStock>;
  for (const slot of MISSILE_SLOTS) {
    const stock = finite(record[`stock_${slot}`]);
    const max = finite(record[`stock_${slot}_max`]);
    if (stock === null || max === null) {
      return {
        ok: false,
        code: "INVALID_FIELD",
        detail: `stock_${slot} and stock_${slot}_max must be finite numbers`,
        raw: body,
      };
    }
    missiles[slot] = { stock, max };
  }
  if (numbers["heading"] < -360 || numbers["heading"] > 720) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: `heading ${String(numbers["heading"])} is not an angle in degrees`,
      raw: body,
    };
  }
  const heading = normalizeDegrees(numbers["heading"]);
  const systemsValue = record["systems"];
  if (
    typeof systemsValue !== "object" ||
    systemsValue === null ||
    Array.isArray(systemsValue)
  ) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: "systems must be an object",
      raw: body,
    };
  }
  const systemsRaw = systemsValue as Record<string, unknown>;
  const systems = {} as Record<ObservedSystem, SystemReading>;
  for (const name of OBSERVED_SYSTEMS) {
    const reading = readSystem(systemsRaw[name], name);
    if (typeof reading === "string") {
      return {
        ok: false,
        code: "INVALID_FIELD",
        detail: reading,
        raw: body,
      };
    }
    systems[name] = reading;
  }
  const otherRaw = readOtherShip(record, body);
  if (typeof otherRaw !== "object" || otherRaw === null) {
    return otherRaw;
  }
  const observation: Observation = {
    callsign,
    faction: typeof record["faction"] === "string" ? record["faction"] : null,
    position: { x: numbers["x"], y: numbers["y"] },
    rotation: numbers["rotation"],
    heading,
    velocity: { x: numbers["velocity_x"], y: numbers["velocity_y"] },
    speed: numbers["speed"],
    impulse_level: numbers["impulse_level"],
    impulse_request: numbers["impulse_request"],
    energy_level: numbers["energy_level"],
    energy_max: numbers["energy_max"],
    hull_level: numbers["hull_level"],
    hull_max: numbers["hull_max"],
    shield_count: numbers["shield_count"],
    shield_level: numbers["shield_level"],
    shield_max: numbers["shield_max"],
    shield_levels: readIndexSeries(record["shield_levels"], "shield_levels", body),
    shield_maxes: readIndexSeries(record["shield_maxes"], "shield_maxes", body),
    shield_frequency: numbers["shield_frequency"],
    beam_frequency: numbers["beam_frequency"],
    tube_count: numbers["tube_count"],
    tube_loads: readStringIndexSeries(record["tube_loads"]),
    missiles,
    other_ship: otherRaw,
    systems,
  };
  return { ok: true, observation, raw: body };
}

function readIndexSeries(value: unknown, label: string, raw: string): number[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => /^[0-9]+$/.test(key));
  keys.sort((left, right) => Number(left) - Number(right));
  const out: number[] = [];
  for (const key of keys) {
    const entry = finite(record[key]);
    if (entry === null) {
      return [];
    }
    out.push(entry);
  }
  void label;
  void raw;
  return out;
}

function readStringIndexSeries(value: unknown): (string | null)[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => /^[0-9]+$/.test(key));
  keys.sort((left, right) => Number(left) - Number(right));
  const out: (string | null)[] = [];
  for (const key of keys) {
    const entry = record[key];
    out.push(typeof entry === "string" ? entry : null);
  }
  return out;
}

function readOtherShip(
  record: Record<string, unknown>,
  raw: string,
): OtherShip | ObservationResult {
  const callsign = record["other_callsign"];
  if (callsign === undefined || callsign === null || callsign === false) {
    return null;
  }
  if (typeof callsign !== "string" || callsign.length === 0) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: "other_callsign must be a non-empty string when present",
      raw,
    };
  }
  const x = finite(record["other_x"]);
  const y = finite(record["other_y"]);
  const distance = finite(record["other_distance"]);
  if (x === null || y === null || distance === null) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: "other_x, other_y and other_distance must be finite numbers",
      raw,
    };
  }
  return {
    callsign,
    faction: typeof record["other_faction"] === "string" ? record["other_faction"] : null,
    position: { x, y },
    distance,
  };
}

export function parseObservationResult(exec: EeExecResult): ObservationResult {
  if (!exec.ok) {
    return {
      ok: false,
      code: exec.code,
      detail: exec.detail,
      raw: exec.body,
    };
  }
  const error = exec.parsed["error"];
  if (error === "NO_PLAYER_SHIP") {
    return {
      ok: false,
      code: "NO_PLAYER_SHIP",
      detail: "no player ship exists yet; connect a client or wait for one",
      raw: exec.body,
    };
  }
  return parseObservationBody(exec.body);
}

function rawOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function nestedNumber(
  container: unknown,
  key: string,
  label: string,
  raw: string,
): number | ObservationResult {
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    return { ok: false, code: "INVALID_FIELD", detail: `${label} must be an object`, raw };
  }
  const value = finite((container as Record<string, unknown>)[key]);
  if (value === null) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: `${label}.${key} must be a finite number`,
      raw,
    };
  }
  return value;
}

export function parseObservationObject(value: unknown): ObservationResult {
  const raw = rawOf(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: "observation must be a json object",
      raw,
    };
  }
  const record = value as Record<string, unknown>;
  const callsign = record["callsign"];
  if (typeof callsign !== "string" || callsign.length === 0) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: "callsign must be a non-empty string",
      raw,
    };
  }
  const numbers: Record<string, number> = {};
  for (const field of [
    "rotation",
    "heading",
    "speed",
    "impulse_level",
    "impulse_request",
    "energy_level",
    "energy_max",
    "hull_level",
    "hull_max",
    "shield_count",
    "shield_level",
    "shield_max",
    "shield_frequency",
    "beam_frequency",
    "tube_count",
  ] as const) {
    const value2 = finite(record[field]);
    if (value2 === null) {
      return {
        ok: false,
        code: "INVALID_FIELD",
        detail: `${field} must be a finite number`,
        raw,
      };
    }
    numbers[field] = value2;
  }
  const missiles = {} as Record<MissileSlot, MissileStock>;
  const missilesValue = record["missiles"];
  if (
    typeof missilesValue !== "object" ||
    missilesValue === null ||
    Array.isArray(missilesValue)
  ) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: "missiles must be an object",
      raw,
    };
  }
  for (const slot of MISSILE_SLOTS) {
    const entry = (missilesValue as Record<string, unknown>)[slot];
    const stock = readStockNumber(entry, "stock", slot, raw);
    if (typeof stock !== "number") {
      return stock;
    }
    const max = readStockNumber(entry, "max", slot, raw);
    if (typeof max !== "number") {
      return max;
    }
    missiles[slot] = { stock, max };
  }
  const x = nestedNumber(record["position"], "x", "position", raw);
  if (typeof x !== "number") {
    return x;
  }
  const y = nestedNumber(record["position"], "y", "position", raw);
  if (typeof y !== "number") {
    return y;
  }
  const vx = nestedNumber(record["velocity"], "x", "velocity", raw);
  if (typeof vx !== "number") {
    return vx;
  }
  const vy = nestedNumber(record["velocity"], "y", "velocity", raw);
  if (typeof vy !== "number") {
    return vy;
  }
  if (numbers["heading"] < -360 || numbers["heading"] > 720) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: `heading ${String(numbers["heading"])} is not an angle in degrees`,
      raw,
    };
  }
  const systemsRaw = record["systems"];
  if (
    typeof systemsRaw !== "object" ||
    systemsRaw === null ||
    Array.isArray(systemsRaw)
  ) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: "systems must be an object",
      raw,
    };
  }
  const systems = {} as Record<ObservedSystem, SystemReading>;
  for (const name of OBSERVED_SYSTEMS) {
    const reading = readSystem((systemsRaw as Record<string, unknown>)[name], name);
    if (typeof reading === "string") {
      return { ok: false, code: "INVALID_FIELD", detail: reading, raw };
    }
    systems[name] = reading;
  }
  const other = readOtherShipObject(record["other_ship"], raw);
  if (typeof other !== "object" || other === null) {
    if (typeof other === "string") {
      return {
        ok: false,
        code: "INVALID_FIELD",
        detail: other,
        raw,
      };
    }
  }
  return {
    ok: true,
    raw,
    observation: {
      callsign,
      faction: typeof record["faction"] === "string" ? record["faction"] : null,
      position: { x, y },
      rotation: numbers["rotation"],
      heading: normalizeDegrees(numbers["heading"]),
      velocity: { x: vx, y: vy },
      speed: numbers["speed"],
      impulse_level: numbers["impulse_level"],
      impulse_request: numbers["impulse_request"],
      energy_level: numbers["energy_level"],
      energy_max: numbers["energy_max"],
      hull_level: numbers["hull_level"],
      hull_max: numbers["hull_max"],
      shield_count: numbers["shield_count"],
      shield_level: numbers["shield_level"],
      shield_max: numbers["shield_max"],
      shield_levels: readNumberArray(record["shield_levels"]),
      shield_maxes: readNumberArray(record["shield_maxes"]),
      shield_frequency: numbers["shield_frequency"],
      beam_frequency: numbers["beam_frequency"],
      tube_count: numbers["tube_count"],
      tube_loads: readStringArray(record["tube_loads"]),
      missiles,
      other_ship: other,
      systems,
    },
  };
}

function readStockNumber(
  entry: unknown,
  key: string,
  slot: string,
  raw: string,
): number | ObservationResult {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: `missiles.${slot} must be an object`,
      raw,
    };
  }
  const value = finite((entry as Record<string, unknown>)[key]);
  if (value === null) {
    return {
      ok: false,
      code: "INVALID_FIELD",
      detail: `missiles.${slot}.${key} must be a finite number`,
      raw,
    };
  }
  return value;
}

function readNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: number[] = [];
  for (const entry of value) {
    const number = finite(entry);
    if (number === null) {
      return [];
    }
    out.push(number);
  }
  return out;
}

function readStringArray(value: unknown): (string | null)[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: (string | null)[] = [];
  for (const entry of value) {
    out.push(typeof entry === "string" ? entry : null);
  }
  return out;
}

function readOtherShipObject(value: unknown, raw: string): OtherShip | null | string {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return "other_ship must be an object when present";
  }
  const record = value as Record<string, unknown>;
  const callsign = record["callsign"];
  const x = finite(record["x"]);
  const y = finite(record["y"]);
  const distance = finite(record["distance"]);
  if (typeof callsign !== "string" || callsign.length === 0) {
    return "other_ship.callsign must be a non-empty string";
  }
  if (x === null || y === null || distance === null) {
    return "other_ship x, y and distance must be finite numbers";
  }
  return {
    callsign,
    faction: typeof record["faction"] === "string" ? record["faction"] : null,
    position: { x, y },
    distance,
  };
}

export async function observeOnce(
  port: EeExecLuaPort,
  callsign: string,
): Promise<ObservationTick> {
  const exec = await port.call(buildObservationLua(callsign));
  return { at: Date.now(), result: parseObservationResult(exec) };
}

export function observationFailure(
  code: string,
  detail: string,
  raw = "",
): ObservationResult {
  const known: readonly string[] = [
    "PORT_ERROR",
    "HTTP_ERROR",
    "LUA_ERROR",
    "INVALID_JSON",
    "NO_PLAYER_SHIP",
    "INVALID_FIELD",
  ];
  const use: ObservationErrorCode = known.includes(code)
    ? (code as ObservationErrorCode)
    : "PORT_ERROR";
  return {
    ok: false,
    code: use,
    detail: detail.length > 0 ? detail : `vm api reported ${code}`,
    raw,
  };
}

export function normalizeDegrees(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`cannot normalize non-finite angle: ${String(value)}`);
  }
  const wrapped = value % 360;
  if (wrapped < 0) {
    return wrapped + 360;
  }
  if (wrapped >= 360) {
    return wrapped - 360;
  }
  return wrapped;
}

export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`cannot round non-finite number: ${String(value)}`);
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function distanceBetween(
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function headingToward(
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  const degrees = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return normalizeDegrees(degrees);
}