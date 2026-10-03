import { INTENT_NAMES } from "../gateway/intents.ts";
import type { IntentName } from "../gateway/intents.ts";
import type { SeatRole } from "../gateway/types.ts";
import { isVmCommandRole } from "./eeport.ts";
import type {
  VmCommandOutcome,
  VmCommandRequest,
  VmCommandSummary,
  VmCommandRole,
  VmSeatInfo,
} from "./eeport.ts";
import { distanceBetween, headingToward, normalizeDegrees, roundTo } from "./observe.ts";
import type { Observation } from "./observe.ts";

export const HELM_ACTOR_ID = "agent-helm";
export const ENGINEERING_ACTOR_ID = "agent-eng";
export const WEAPONS_ACTOR_ID = "agent-weapons";
export const DEFAULT_TICK_MS = 2000;
export const MAX_INTENTS_PER_MINUTE = 10;
export const RATE_WINDOW_MS = 60000;
export const EXTERNAL_INTENTS_PER_MINUTE = 10;
export const DECISION_HISTORY_LIMIT = 20;
export const MAX_AGENT_LABEL_LENGTH = 40;
export const RULE_CONTROLLERS_DEFAULT = "helms,engineering";
export const RULE_CONTROLLERS_OFF = "off";
export const CRUISE_IMPULSE = 0.5;
export const WAYPOINT_ARRIVAL_UNITS = 500;
export const DEFAULT_TARGET_HEADING = 90;
export const IMPULSE_POWER_FLOOR = 1.0;
export const IMPULSE_POWER_TARGET = 1.2;
export const IMPULSE_POWER_STEP = 0.2;
export const COOLANT_MINIMUM = 2.0;
export const HEAT_LIMIT = 0.8;
export const COOLANT_SYSTEMS = ["impulse", "reactor"] as const;
export const CONTROLLER_LABEL = "deterministic controller (rule-based, not LLM)";
export const EXTERNAL_ROLE_AGENT_LABEL = "external role agent";
export const RULE_ROLES = ["helms", "engineering", "weapons"] as const;

export type ControllerOwner =
  | "deterministic controller (rule-based, not LLM)"
  | "external role agent";

export function ownerLabel(enabled: boolean): ControllerOwner {
  return enabled ? "deterministic controller (rule-based, not LLM)" : "external role agent";
}

export function parseRuleControllers(raw: string | undefined): SeatRole[] | null {
  const value = (raw ?? RULE_CONTROLLERS_DEFAULT).trim().toLowerCase();
  if (value.length === 0 || value === RULE_CONTROLLERS_OFF) {
    return null;
  }
  const selected: SeatRole[] = [];
  for (const part of value.split(",")) {
    const token = part.trim();
    if ((RULE_ROLES as readonly string[]).includes(token)) {
      const role = token as SeatRole;
      if (!selected.includes(role)) {
        selected.push(role);
      }
    }
  }
  return selected;
}

export function normalizeAgentLabel(
  value: unknown,
): { ok: true; label: string | null } | { ok: false; detail: string } {
  if (value === undefined || value === null) {
    return { ok: true, label: null };
  }
  if (typeof value !== "string") {
    return { ok: false, detail: "agent_label must be a string when present" };
  }
  if (value.length > MAX_AGENT_LABEL_LENGTH) {
    return {
      ok: false,
      detail: `agent_label must be at most ${String(MAX_AGENT_LABEL_LENGTH)} characters`,
    };
  }
  return { ok: true, label: value };
}

export type Waypoint = { x: number; y: number };

export type RoleDecisionRecord = {
  at: string;
  kind: "deterministic_controller" | "external_role_agent";
  role: SeatRole;
  agent: string;
  agent_label: string | null;
  request_id: string;
  intent: string;
  args: Record<string, unknown>;
  outcome: string;
  result: VmCommandSummary | null;
  note: string;
};

export class RoleDecisionLog {
  private readonly entries: RoleDecisionRecord[] = [];

  constructor(readonly limit: number = DECISION_HISTORY_LIMIT) {}

  push(record: RoleDecisionRecord): void {
    this.entries.push(record);
    while (this.entries.length > this.limit) {
      this.entries.shift();
    }
  }

  list(): RoleDecisionRecord[] {
    return this.entries.slice();
  }

  size(): number {
    return this.entries.length;
  }
}

export function mergeRoleDecisions(
  deterministic: readonly RoleDecisionRecord[],
  external: readonly RoleDecisionRecord[],
  limit: number = DECISION_HISTORY_LIMIT,
): RoleDecisionRecord[] {
  const merged = deterministic.concat(external);
  merged.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
  return merged.slice(0, limit);
}

export type IntentPlan = {
  intent: IntentName;
  args: Record<string, unknown>;
};

export type DecisionIntent = {
  intent: IntentName;
  args: Record<string, unknown>;
  request_id: string;
  submitted: boolean;
  result: VmCommandSummary | null;
};

export type AgentDecision = {
  at: string;
  tick: number;
  agent: string;
  kind: "deterministic_controller";
  role: SeatRole;
  observation_seq: number;
  callsign: string;
  outcome: "submitted" | "partial" | "skipped";
  note: string;
  intents: DecisionIntent[];
};

export type AgentStatus = {
  agent: string;
  kind: "deterministic_controller";
  label: string;
  owner: ControllerOwner;
  enabled: boolean;
  role: SeatRole;
  actor_id: string;
  decisions: number;
  ticks_disabled: number;
  intents_submitted: number;
  rate_limited: number;
  window_used: number;
  rate_limit: number;
  last_decision: AgentDecision | null;
};

export type CommandClient = {
  command(request: VmCommandRequest): Promise<VmCommandOutcome>;
};

export type SeatLookup = (role: SeatRole) => VmSeatInfo | null;

export class RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly stamps: number[] = [];

  constructor(limit: number = MAX_INTENTS_PER_MINUTE, windowMs: number = RATE_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  tryTake(now: number): boolean {
    this.prune(now);
    if (this.stamps.length >= this.limit) {
      return false;
    }
    this.stamps.push(now);
    return true;
  }

  prune(now: number): void {
    while (
      this.stamps.length > 0 &&
      now - (this.stamps[0] as number) >= this.windowMs
    ) {
      this.stamps.shift();
    }
  }

  used(): number {
    return this.stamps.length;
  }
}

export function planHelm(
  observation: Observation,
  waypoint: Waypoint | null,
  defaultHeading: number = DEFAULT_TARGET_HEADING,
): IntentPlan[] {
  let heading = normalizeDegrees(defaultHeading);
  let impulse = CRUISE_IMPULSE;
  if (waypoint) {
    heading = headingToward(observation.position, waypoint);
    const distance = distanceBetween(observation.position, waypoint);
    if (distance <= WAYPOINT_ARRIVAL_UNITS) {
      impulse = 0;
    }
  }
  const rounded = roundTo(normalizeDegrees(heading), 2);
  return [
    {
      intent: "heading_degrees",
      args: { heading_degrees: rounded >= 360 ? 0 : rounded },
    },
    { intent: "impulse_fraction", args: { impulse_fraction: impulse } },
  ];
}

export function planEngineering(observation: Observation): IntentPlan[] {
  const plans: IntentPlan[] = [];
  const impulse = observation.systems.impulse;
  if (impulse.heat > HEAT_LIMIT) {
    const reduced = roundTo(Math.max(0, impulse.power - IMPULSE_POWER_STEP), 1);
    plans.push({
      intent: "system_power_request",
      args: { system: "impulse", level: reduced },
    });
  } else if (impulse.power < IMPULSE_POWER_FLOOR) {
    plans.push({
      intent: "system_power_request",
      args: { system: "impulse", level: IMPULSE_POWER_TARGET },
    });
  }
  for (const system of COOLANT_SYSTEMS) {
    const reading = observation.systems[system];
    if (reading.coolant < COOLANT_MINIMUM) {
      plans.push({
        intent: "system_coolant_request",
        args: { system, level: COOLANT_MINIMUM },
      });
    }
  }
  return plans;
}

export type AgentOptions = {
  actorId: string;
  role: SeatRole;
  client: CommandClient;
  planner: (observation: Observation) => IntentPlan[];
  seat: SeatLookup;
  enabled?: boolean;
  rateLimit?: number;
  rateWindowMs?: number;
  log?: (line: string) => void;
};

export class BoundedAgent {
  readonly actorId: string;
  readonly role: SeatRole;
  readonly enabled: boolean;
  private readonly client: CommandClient;
  private readonly planner: (observation: Observation) => IntentPlan[];
  private readonly seat: SeatLookup;
  private readonly limiter: RateLimiter;
  private readonly emit: (line: string) => void;
  readonly history: RoleDecisionLog = new RoleDecisionLog();
  private requestSeq = 0;
  private decisionCount = 0;
  private disabledTicks = 0;
  private submitted = 0;
  private limited = 0;
  private last: AgentDecision | null = null;

  constructor(options: AgentOptions) {
    this.actorId = options.actorId;
    this.role = options.role;
    this.enabled = options.enabled ?? true;
    this.client = options.client;
    this.planner = options.planner;
    this.seat = options.seat;
    this.limiter = new RateLimiter(
      options.rateLimit ?? MAX_INTENTS_PER_MINUTE,
      options.rateWindowMs ?? RATE_WINDOW_MS,
    );
    this.emit = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  }

  get owner(): ControllerOwner {
    return ownerLabel(this.enabled);
  }

  get lastDecision(): AgentDecision | null {
    return this.last;
  }

  get lastIntent(): DecisionIntent | null {
    if (!this.last) {
      return null;
    }
    const sent = this.last.intents.filter((entry) => entry.submitted);
    return sent.length > 0 ? (sent[sent.length - 1] as DecisionIntent) : null;
  }

  get lastResult(): VmCommandSummary | null {
    const intent = this.lastIntent;
    return intent ? intent.result : null;
  }

  status(): AgentStatus {
    return {
      agent: this.actorId,
      kind: "deterministic_controller",
      label: CONTROLLER_LABEL,
      owner: this.owner,
      enabled: this.enabled,
      role: this.role,
      actor_id: this.actorId,
      decisions: this.decisionCount,
      ticks_disabled: this.disabledTicks,
      intents_submitted: this.submitted,
      rate_limited: this.limited,
      window_used: this.limiter.used(),
      rate_limit: this.limiter.limit,
      last_decision: this.last,
    };
  }

  private nextRequestId(tick: number): string {
    this.requestSeq += 1;
    return `${this.actorId}-${String(tick)}-${String(this.requestSeq)}`;
  }

  private write(decision: AgentDecision): void {
    this.last = decision;
    this.decisionCount += 1;
    for (const entry of decision.intents) {
      this.history.push({
        at: decision.at,
        kind: "deterministic_controller",
        role: this.role,
        agent: this.actorId,
        agent_label: null,
        request_id: entry.request_id,
        intent: entry.intent,
        args: entry.args,
        outcome: entry.result?.outcome ?? "not_submitted",
        result: entry.result,
        note: decision.note,
      });
    }
    this.emit(JSON.stringify(decision));
  }

  async tick(
    observation: Observation,
    observationSeq: number,
    tickIndex: number,
  ): Promise<AgentDecision | null> {
    if (!this.enabled) {
      this.disabledTicks += 1;
      return null;
    }
    const now = Date.now();
    this.limiter.prune(now);
    const seat = this.seat(this.role);
    const base: AgentDecision = {
      at: new Date(now).toISOString(),
      tick: tickIndex,
      agent: this.actorId,
      kind: "deterministic_controller",
      role: this.role,
      observation_seq: observationSeq,
      callsign: observation.callsign,
      outcome: "skipped",
      note: "",
      intents: [],
    };
    if (!seat) {
      base.note = `no seat reported by the vm api for ${this.role}`;
      this.write(base);
      return base;
    }
    if (seat.mode !== "AGENT" || seat.leaseholder !== this.actorId) {
      base.note = `seat ${this.role} is ${seat.mode} held by ${String(seat.leaseholder)}`;
      this.write(base);
      return base;
    }
    let plans: IntentPlan[];
    try {
      plans = this.planner(observation);
    } catch (error) {
      base.note = `planner threw: ${error instanceof Error ? error.message : String(error)}`;
      this.write(base);
      return base;
    }
    if (plans.length === 0) {
      base.note = "plan is empty";
      this.write(base);
      return base;
    }
    for (const plan of plans) {
      if (!(INTENT_NAMES as readonly string[]).includes(plan.intent)) {
        base.note = `planner produced ${String(plan.intent)}, which is not in the allowlist`;
        break;
      }
      const entry: DecisionIntent = {
        intent: plan.intent,
        args: plan.args,
        request_id: this.nextRequestId(tickIndex),
        submitted: false,
        result: null,
      };
      if (!this.limiter.tryTake(now)) {
        this.limited += 1;
        base.note = `rate limit ${String(this.limiter.limit)} intents per ${String(
          this.limiter.windowMs,
        )}ms reached; a deterministic controller waits instead of acting`;
        base.intents.push(entry);
        break;
      }
      const live = this.seat(this.role) ?? seat;
      this.submitted += 1;
      entry.submitted = true;
      const outcome = await this.client.command({
        role: this.role as VmCommandRole,
        actor_id: this.actorId,
        request_id: entry.request_id,
        intent: plan.intent,
        args: plan.args,
        generation: live.generation >= 0 ? live.generation : undefined,
      });
      entry.result = outcome.summary;
      base.intents.push(entry);
    }
    const sent = base.intents.filter((entry) => entry.submitted).length;
    if (sent === 0) {
      base.outcome = "skipped";
      if (base.note.length === 0) {
        base.note = "nothing submitted";
      }
    } else if (sent < plans.length || base.note.length > 0) {
      base.outcome = "partial";
      if (base.note.length === 0) {
        base.note = `${String(sent)} of ${String(plans.length)} intents delivered`;
      }
    } else {
      base.outcome = "submitted";
      base.note = `${String(sent)} intent(s) delivered`;
    }
    this.write(base);
    return base;
  }
}

export function createHelmAgent(
  options: Omit<AgentOptions, "planner" | "actorId" | "role"> & {
    waypoint: Waypoint | null;
    defaultHeading?: number;
  },
): BoundedAgent {
  const { waypoint, defaultHeading, ...rest } = options;
  return new BoundedAgent({
    ...rest,
    actorId: HELM_ACTOR_ID,
    role: "helms",
    planner: (observation: Observation) =>
      planHelm(observation, waypoint, defaultHeading ?? DEFAULT_TARGET_HEADING),
  });
}

export function createEngineeringAgent(
  options: Omit<AgentOptions, "planner" | "actorId" | "role">,
): BoundedAgent {
  return new BoundedAgent({
    ...options,
    actorId: ENGINEERING_ACTOR_ID,
    role: "engineering",
    planner: planEngineering,
  });
}

export function seatFromVmSeats(
  seats: readonly VmSeatInfo[],
  role: SeatRole,
): VmSeatInfo | null {
  if (!isVmCommandRole(role)) {
    return null;
  }
  for (const seat of seats) {
    if (seat.role === role) {
      return seat;
    }
  }
  return null;
}