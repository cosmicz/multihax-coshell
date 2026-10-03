import {
  classifyIntent,
  validateIntentArgs,
  type ValidatedIntent,
} from "./intents.ts";
import { isValidCallsign, renderLua } from "./lua.ts";
import { SeatRegistry, type ControlResult } from "./seats.ts";
import {
  isRecord,
  seatKeyId,
  type ExecResponse,
  type FailureReason,
  type GatewayEvent,
  type GatewayResult,
  type RefusalCode,
  type SeatKey,
  type SeatView,
  type WorldPort,
  type WireEnvelope,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 5000;

export type GatewayOptions = {
  ship: string;
  epoch: number;
  timeout_ms?: number;
  on_event?: (event: GatewayEvent) => void;
};

type Precheck =
  | {
      ok: true;
      key: SeatKey;
      seatId: string;
      generation: number;
      intent: ValidatedIntent;
    }
  | { ok: false; code: RefusalCode; detail: string };

type CacheEntry = {
  fingerprint: string;
  result: GatewayResult | null;
  pending: Promise<GatewayResult> | null;
};

type PortOutcome =
  | { kind: "timeout" }
  | { kind: "response"; response: ExecResponse };

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? `n:${value}` : `x:${String(value)}`;
  }
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `b:${value}`;
  if (typeof value === "undefined") return "u";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries
      .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return `t:${typeof value}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class RoleScopedGateway {
  private readonly ship: string;
  private readonly epoch: number;
  private readonly timeoutMs: number;
  private readonly port: WorldPort;
  private readonly onEvent: ((event: GatewayEvent) => void) | undefined;
  private readonly seats = new SeatRegistry();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: GatewayOptions, port: WorldPort) {
    if (!isValidCallsign(options?.ship)) {
      throw new TypeError(`invalid callsign: ${String(options?.ship)}`);
    }
    if (!Number.isInteger(options.epoch)) {
      throw new TypeError(`invalid epoch: ${String(options?.epoch)}`);
    }
    const timeout = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw new TypeError(`invalid timeout_ms: ${String(timeout)}`);
    }
    if (!port || typeof port.execLua !== "function") {
      throw new TypeError("a WorldPort with execLua is required");
    }
    this.ship = options.ship;
    this.epoch = options.epoch;
    this.timeoutMs = timeout;
    this.port = port;
    this.onEvent = options.on_event;
    for (const role of this.seats.roles()) {
      this.seats.register({ epoch: this.epoch, ship: this.ship, role });
    }
  }

  get callsign(): string {
    return this.ship;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get requestTimeoutMs(): number {
    return this.timeoutMs;
  }

  seat(key: SeatKey): SeatView | null {
    return this.seats.view(key);
  }

  claimAgent(key: SeatKey, actorId: string): ControlResult {
    return this.seats.claimAgent(key, actorId);
  }

  resume(key: SeatKey, actorId: string): ControlResult {
    return this.seats.resume(key, actorId);
  }

  pause(key: SeatKey): ControlResult {
    return this.seats.pause(key);
  }

  markHumanOccupied(key: SeatKey): ControlResult {
    return this.seats.markHumanOccupied(key);
  }

  reportNativeVacancy(key: SeatKey, vacant: boolean): ControlResult {
    return this.seats.reportNativeVacancy(key, vacant);
  }

  async submit(env: WireEnvelope): Promise<GatewayResult> {
    if (!isRecord(env)) {
      throw new TypeError("envelope must be an object");
    }
    const requestId = env.request_id;
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new TypeError("request_id must be a non-empty string");
    }
    const fingerprint = canonical(env);
    const prior = this.cache.get(requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return this.refuse(
          requestId,
          "DUPLICATE_MISMATCH",
          "request_id replayed with a different payload",
        );
      }
      if (prior.result) return prior.result;
      if (prior.pending) return prior.pending;
    }
    const entry: CacheEntry = { fingerprint, result: null, pending: null };
    this.cache.set(requestId, entry);
    const settled = this.run(env);
    entry.pending = settled;
    const result = await settled;
    entry.pending = null;
    entry.result = result;
    return result;
  }

  private async run(env: WireEnvelope): Promise<GatewayResult> {
    const requestId = env.request_id;
    const precheck = this.precheck(env);
    if (!precheck.ok) {
      return this.refuse(requestId, precheck.code, precheck.detail);
    }
    let lua: string;
    try {
      lua = renderLua({
        callsign: this.ship,
        role: precheck.key.role,
        intent: precheck.intent,
      });
    } catch (error) {
      return this.failed(requestId, precheck, "", "unexpected_body", 0, errorMessage(error));
    }
    this.seats.recordObservation(precheck.key, env.observation_seq);
    const shipKey = `${env.epoch}:${env.ship}`;
    return this.enqueue(shipKey, async () => {
      if (
        !this.seats.isAgentLease(
          precheck.seatId,
          env.actor_id,
          precheck.generation,
        )
      ) {
        return this.refuse(
          requestId,
          "STALE_GENERATION",
          "lease moved before the write reached the world port",
        );
      }
      return this.execute(requestId, precheck, env.actor_id, env.intent, lua);
    });
  }

  private precheck(env: WireEnvelope): Precheck {
    const requestId = env.request_id;
    const classified = classifyIntent(env.intent, env.role);
    if (!classified.ok) {
      return {
        ok: false,
        code: classified.code,
        detail:
          classified.code === "UNKNOWN_INTENT"
            ? `intent is not in the allowlist: ${String(env.intent)}`
            : `intent is not permitted for role: ${String(env.role)}`,
      };
    }
    const role = env.role as SeatKey["role"];
    const key: SeatKey = { epoch: this.epoch, ship: this.ship, role };
    const seatId = seatKeyId(key);
    const live = this.seats.view(key);
    if (!live || live.leaseholder !== env.actor_id) {
      return {
        ok: false,
        code: "NOT_LEASEHOLDER",
        detail: `actor does not hold the lease for ${seatId}`,
      };
    }
    if (!Number.isInteger(env.generation) || env.generation !== live.generation) {
      return {
        ok: false,
        code: "STALE_GENERATION",
        detail: `generation ${String(env.generation)} != ${live.generation}`,
      };
    }
    if (env.epoch !== this.epoch || env.ship !== this.ship) {
      return {
        ok: false,
        code: "EPOCH_MISMATCH",
        detail: `bound to epoch ${this.epoch} ship ${this.ship}`,
      };
    }
    if (!this.seats.observationAccepted(key, env.observation_seq)) {
      return {
        ok: false,
        code: "STALE_OBSERVATION",
        detail: `observation_seq ${String(env.observation_seq)} is older than the last accepted`,
      };
    }
    if (live.mode !== "AGENT") {
      return {
        ok: false,
        code: "SEAT_NOT_AGENT",
        detail: `seat mode is ${live.mode}`,
      };
    }
    const args = validateIntentArgs(classified.intent, env.args);
    if (!args.ok) {
      return {
        ok: false,
        code: args.code,
        detail: `args rejected for ${classified.intent}`,
      };
    }
    return {
      ok: true,
      key,
      seatId,
      generation: live.generation,
      intent: args.intent,
    };
  }

  private async execute(
    requestId: string,
    precheck: Extract<Precheck, { ok: true }>,
    actorId: string,
    intentName: string,
    lua: string,
  ): Promise<GatewayResult> {
    this.emit({
      type: "accepted",
      request_id: requestId,
      seat: precheck.seatId,
      generation: precheck.generation,
      intent: intentName,
      lua,
    });
    const outcome = await this.callPort(lua);
    if (!this.seats.isAgentLease(precheck.seatId, actorId, precheck.generation)) {
      return this.refuse(
        requestId,
        "STALE_GENERATION",
        "lease moved while the write was in flight",
      );
    }
    if (outcome.kind === "timeout") {
      this.emit({ type: "timeout", request_id: requestId, timeout_ms: this.timeoutMs });
      return {
        outcome: "timeout",
        request_id: requestId,
        seat: precheck.seatId,
        generation: precheck.generation,
        intent: intentName,
        lua,
        timeout_ms: this.timeoutMs,
      };
    }
    const response = outcome.response;
    if (response.status !== 200) {
      return this.failed(
        requestId,
        precheck,
        lua,
        "http_error",
        response.status,
        response.body,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return this.failed(
        requestId,
        precheck,
        lua,
        "invalid_json",
        response.status,
        response.body,
      );
    }
    if (!isRecord(parsed)) {
      return this.failed(
        requestId,
        precheck,
        lua,
        "unexpected_body",
        response.status,
        response.body,
      );
    }
    if (parsed.refused === "OCCUPIED") {
      this.seats.latchOccupied(precheck.key);
      return this.refuse(
        requestId,
        "OCCUPIED",
        "a covering native station is occupied",
      );
    }
    if (typeof parsed.error === "string") {
      return this.failed(
        requestId,
        precheck,
        lua,
        "upstream_error",
        response.status,
        response.body,
      );
    }
    if (parsed.ok === true) {
      this.emit({
        type: "upstream_receipt",
        request_id: requestId,
        receipt: parsed,
      });
      return {
        outcome: "accepted",
        stage: "upstream_receipt",
        request_id: requestId,
        seat: precheck.seatId,
        generation: precheck.generation,
        intent: intentName,
        lua,
        receipt: parsed,
      };
    }
    return this.failed(
      requestId,
      precheck,
      lua,
      "unexpected_body",
      response.status,
      response.body,
    );
  }

  private callPort(lua: string): Promise<PortOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ kind: "timeout" });
      }, this.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      let started: Promise<ExecResponse>;
      try {
        started = Promise.resolve(this.port.execLua(lua));
      } catch (error) {
        started = Promise.reject(error);
      }
      started.then(
        (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ kind: "response", response });
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            kind: "response",
            response: { status: 0, body: `port_error: ${errorMessage(error)}` },
          });
        },
      );
    });
  }

  private async enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(key, done);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(key) === done) this.queues.delete(key);
    }
  }

  private refuse(
    requestId: string,
    code: RefusalCode,
    detail: string,
  ): GatewayResult {
    this.emit({ type: "refused", request_id: requestId, code });
    return {
      outcome: "refused",
      request_id: requestId,
      code,
      detail,
      seat: null,
    };
  }

  private failed(
    requestId: string,
    precheck: Extract<Precheck, { ok: true }>,
    lua: string,
    reason: FailureReason,
    status: number,
    body: string,
  ): GatewayResult {
    this.emit({ type: "failed", request_id: requestId, reason, status });
    return {
      outcome: "failed",
      request_id: requestId,
      seat: precheck.seatId,
      generation: precheck.generation,
      intent: precheck.intent.intent,
      lua,
      reason,
      status,
      body,
    };
  }

  private emit(event: GatewayEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch {
      // observers must never break command delivery
    }
  }
}