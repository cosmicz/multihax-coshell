import {
  isRecord,
  isSeatRole,
  isValidCallsign,
  type RefusalCode,
  type SeatRole,
} from "./types.ts";

export const SYSTEM_ALLOWLIST = [
  "reactor",
  "beamweapons",
  "missilesystem",
  "maneuver",
  "impulse",
  "warp",
  "jumpdrive",
  "frontshield",
  "rearshield",
] as const;
export type SystemName = (typeof SYSTEM_ALLOWLIST)[number];

const SYSTEM_SET: ReadonlySet<string> = new Set<string>(SYSTEM_ALLOWLIST);

export function isSystemName(value: unknown): value is SystemName {
  return typeof value === "string" && SYSTEM_SET.has(value);
}

export const MISSILE_TYPES = ["Homing", "Nuke", "Mine", "EMP", "HVLI"] as const;
export type MissileType = (typeof MISSILE_TYPES)[number];

const MISSILE_SET: ReadonlySet<string> = new Set<string>(MISSILE_TYPES);

export function isMissileType(value: unknown): value is MissileType {
  return typeof value === "string" && MISSILE_SET.has(value);
}

export const MISSILE_TUBE_MAX = 15;
export const BEAM_FREQUENCY_MIN = 0;
export const BEAM_FREQUENCY_MAX = 20;

export const INTENT_NAMES = [
  "heading_degrees",
  "impulse_fraction",
  "system_power_request",
  "system_coolant_request",
  "target_ship",
  "load_tube",
  "fire_tube",
  "set_shields",
  "set_beam_frequency",
] as const;
export type IntentName = (typeof INTENT_NAMES)[number];

const INTENT_SET: ReadonlySet<string> = new Set<string>(INTENT_NAMES);

export function isIntentName(value: unknown): value is IntentName {
  return typeof value === "string" && INTENT_SET.has(value);
}

export const INTENT_ROLE: Readonly<Record<IntentName, SeatRole>> = {
  heading_degrees: "helms",
  impulse_fraction: "helms",
  system_power_request: "engineering",
  system_coolant_request: "engineering",
  target_ship: "weapons",
  load_tube: "weapons",
  fire_tube: "weapons",
  set_shields: "weapons",
  set_beam_frequency: "weapons",
};

export const STATION_COVERAGE: Readonly<Record<SeatRole, readonly string[]>> = {
  helms: ["helms", "tactical", "singlepilot"],
  engineering: [
    "engineering",
    "engineering+",
    "powermanagement",
    "damagecontrol",
    "singlepilot",
  ],
  weapons: ["weapons", "singlepilot"],
};

export type ValidatedIntent =
  | { intent: "heading_degrees"; target_rotation_degrees: number }
  | { intent: "impulse_fraction"; impulse_fraction: number }
  | {
      intent: "system_power_request";
      system: SystemName;
      level: number;
    }
  | {
      intent: "system_coolant_request";
      system: SystemName;
      level: number;
    }
  | { intent: "target_ship"; callsign: string }
  | { intent: "load_tube"; tube: number; weapon: MissileType }
  | { intent: "fire_tube"; tube: number; callsign: string }
  | { intent: "set_shields"; active: boolean }
  | { intent: "set_beam_frequency"; frequency: number };

export type Classification =
  | { ok: true; intent: IntentName }
  | { ok: false; code: RefusalCode };

export type ArgsCheck =
  | { ok: true; intent: ValidatedIntent }
  | { ok: false; code: RefusalCode };

export function classifyIntent(intent: unknown, role: unknown): Classification {
  if (!isIntentName(intent)) {
    return { ok: false, code: "UNKNOWN_INTENT" };
  }
  if (!isSeatRole(role)) {
    return { ok: false, code: "WRONG_ROLE" };
  }
  if (INTENT_ROLE[intent] !== role) {
    return { ok: false, code: "WRONG_ROLE" };
  }
  return { ok: true, intent };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isClosedRange(
  value: unknown,
  low: number,
  high: number,
): value is number {
  return isFiniteNumber(value) && value >= low && value <= high;
}

function isTubeIndex(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MISSILE_TUBE_MAX
  );
}

export function validateIntentArgs(
  intent: IntentName,
  args: unknown,
): ArgsCheck {
  if (!isRecord(args)) {
    return { ok: false, code: "OUT_OF_RANGE" };
  }
  switch (intent) {
    case "heading_degrees": {
      const heading = args.heading_degrees;
      if (!isFiniteNumber(heading) || heading < 0 || heading >= 360) {
        return { ok: false, code: "OUT_OF_RANGE" };
      }
      return {
        ok: true,
        intent: {
          intent: "heading_degrees",
          target_rotation_degrees: heading - 90,
        },
      };
    }
    case "impulse_fraction": {
      const fraction = args.impulse_fraction;
      if (!isClosedRange(fraction, -1, 1)) {
        return { ok: false, code: "OUT_OF_RANGE" };
      }
      return { ok: true, intent: { intent, impulse_fraction: fraction } };
    }
    case "system_power_request": {
      const system = args.system;
      const level = args.level;
      if (!isSystemName(system) || !isClosedRange(level, 0, 3)) {
        return { ok: false, code: "OUT_OF_RANGE" };
      }
      return { ok: true, intent: { intent, system, level } };
    }
    case "system_coolant_request": {
      const system = args.system;
      const level = args.level;
      if (!isSystemName(system) || !isClosedRange(level, 0, 10)) {
        return { ok: false, code: "OUT_OF_RANGE" };
      }
      return { ok: true, intent: { intent, system, level } };
    }
    case "target_ship": {
      const callsign = args.callsign;
      if (!isValidCallsign(callsign)) {
        return { ok: false, code: "OUT_OF_RANGE" };
      }
      return { ok: true, intent: { intent, callsign } };
    }
    case "load_tube": {
      const tube = args.tube;
      const weapon = args.weapon;
      if (!isTubeIndex(tube) || !isMissileType(weapon)) {
        return { ok: false, code: "OUT_OF_RANGE" };
      }
      return { ok: true, intent: { intent, tube, weapon } };
    }
    case "fire_tube": {
      const tube = args.tube;
      const callsign = args.callsign;
      if (!isTubeIndex(tube) || !isValidCallsign(callsign)) {
        return { ok: false, code: "OUT_OF_RANGE" };
      }
      return { ok: true, intent: { intent, tube, callsign } };
    }
    case "set_shields": {
      const active = args.active;
      if (typeof active !== "boolean") {
        return { ok: false, code: "OUT_OF_RANGE" };
      }
      return { ok: true, intent: { intent, active } };
    }
    case "set_beam_frequency": {
      const frequency = args.frequency;
      if (!Number.isInteger(frequency)) {
        return { ok: false, code: "OUT_OF_RANGE" };
      }
      if (
        (frequency as number) < BEAM_FREQUENCY_MIN ||
        (frequency as number) > BEAM_FREQUENCY_MAX
      ) {
        return { ok: false, code: "OUT_OF_RANGE" };
      }
      return {
        ok: true,
        intent: { intent, frequency: frequency as number },
      };
    }
  }
}