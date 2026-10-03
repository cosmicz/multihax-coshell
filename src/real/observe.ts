import type { EeExecResult, EeExecLuaPort } from "./eeport.ts";

export const OBSERVATION_LUA = [
  "local s = getPlayerShip(-1)",
  'if s == nil then return toJSON({error="NO_PLAYER_SHIP"}) end',
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
  "return toJSON({",
  "  callsign = s:getCallSign(),",
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

export const OBSERVED_SYSTEMS = ["reactor", "impulse", "maneuver"] as const;
export type ObservedSystem = (typeof OBSERVED_SYSTEMS)[number];

export type SystemReading = {
  power: number;
  coolant: number;
  health: number;
  heat: number;
};

export type Observation = {
  callsign: string;
  position: { x: number; y: number };
  rotation: number;
  heading: number;
  velocity: { x: number; y: number };
  speed: number;
  impulse_level: number;
  impulse_request: number;
  energy_level: number;
  energy_max: number;
  systems: Record<ObservedSystem, SystemReading>;
};

export type ObservationErrorCode =
  | "PORT_ERROR"
  | "HTTP_ERROR"
  | "LUA_ERROR"
  | "INVALID_JSON"
  | "NO_PLAYER_SHIP"
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
    const code: ObservationErrorCode =
      record["error"] === "NO_PLAYER_SHIP" ? "NO_PLAYER_SHIP" : "LUA_ERROR";
    return {
      ok: false,
      code,
      detail: `engine reported ${String(record["error"])}`,
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
  const observation: Observation = {
    callsign,
    position: { x: numbers["x"], y: numbers["y"] },
    rotation: numbers["rotation"],
    heading,
    velocity: { x: numbers["velocity_x"], y: numbers["velocity_y"] },
    speed: numbers["speed"],
    impulse_level: numbers["impulse_level"],
    impulse_request: numbers["impulse_request"],
    energy_level: numbers["energy_level"],
    energy_max: numbers["energy_max"],
    systems,
  };
  return { ok: true, observation, raw: body };
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

export async function observeOnce(port: EeExecLuaPort): Promise<ObservationTick> {
  const exec = await port.call(OBSERVATION_LUA);
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