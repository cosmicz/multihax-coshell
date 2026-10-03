import { readFileSync } from "node:fs";
import { INTENT_NAMES } from "../gateway/intents.ts";
import { isRecord, type ExecResponse } from "../gateway/types.ts";
import { observationFailure, parseObservationObject } from "./observe.ts";
import type { ObservationResult } from "./observe.ts";

export const DEFAULT_LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_EE_HTTP_PORT = 8080;
export const DEFAULT_EE_TIMEOUT_MS = 3000;
export const ALLOWED_LOOPBACK_HOSTS = ["127.0.0.1", "localhost"] as const;
export const EXEC_LUA_PATH = "/exec.lua";
export const DEFAULT_VMAPI_URL = "http://127.0.0.1:8790";
export const DEFAULT_VMAPI_TIMEOUT_MS = 3000;
export const MIN_API_TOKEN_LENGTH = 16;
export const VM_COMMAND_ROLES = ["helms", "engineering", "weapons"] as const;
export type VmCommandRole = (typeof VM_COMMAND_ROLES)[number];
export const FIXED_ACTOR_IDS: Readonly<Record<VmCommandRole, string>> = {
  helms: "agent-helm",
  engineering: "agent-eng",
  weapons: "agent-weapons",
};
export const LUA_REFUSAL_KEYS = ["lua", "script", "lua_body", "exec", "body"] as const;

export function isLoopbackHost(host: unknown): boolean {
  return (
    typeof host === "string" &&
    (ALLOWED_LOOPBACK_HOSTS as readonly string[]).includes(host)
  );
}

export function isVmCommandRole(value: unknown): value is VmCommandRole {
  return typeof value === "string" && (VM_COMMAND_ROLES as readonly string[]).includes(value);
}

export function isLuaFieldKey(value: unknown): boolean {
  return (LUA_REFUSAL_KEYS as readonly string[]).includes(String(value));
}

export function hasLuaField(args: Record<string, unknown>): boolean {
  return Object.keys(args).some((key) => isLuaFieldKey(key.toLowerCase()));
}

export type ExecLuaPortOptions = {
  host?: string;
  port?: number;
  timeout_ms?: number;
};

export function eeEndpoint(host: string, httpPort: number): string {
  return `http://${host}:${String(httpPort)}${EXEC_LUA_PATH}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `timeout after ${String(error.message || "aborted")}`;
    }
    return error.message;
  }
  return String(error);
}

function bodyHasLuaError(body: string): boolean {
  return body.includes("ERROR");
}

export class EeExecLuaPort {
  readonly host: string;
  readonly httpPort: number;
  readonly timeoutMs: number;
  readonly endpoint: string;
  calls = 0;

  constructor(options: ExecLuaPortOptions = {}) {
    const host = options.host ?? DEFAULT_LOOPBACK_HOST;
    if (!isLoopbackHost(host)) {
      throw new TypeError(
        `refusing host ${String(host)}: only ${ALLOWED_LOOPBACK_HOSTS.join(
          " and ",
        )} are allowed`,
      );
    }
    const httpPort = options.port ?? DEFAULT_EE_HTTP_PORT;
    if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
      throw new TypeError(`invalid http port: ${String(httpPort)}`);
    }
    const timeoutMs = options.timeout_ms ?? DEFAULT_EE_TIMEOUT_MS;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError(`invalid timeout_ms: ${String(timeoutMs)}`);
    }
    this.host = host;
    this.httpPort = httpPort;
    this.timeoutMs = timeoutMs;
    this.endpoint = eeEndpoint(host, httpPort);
  }

  async call(script: string): Promise<EeExecResult> {
    this.calls += 1;
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          accept: "application/json, text/plain",
        },
        body: script,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        code: "PORT_ERROR",
        detail: `${errorMessage(error)} (${this.endpoint}, limit ${String(this.timeoutMs)}ms)`,
        status: 0,
        body: "",
      };
    }

    let body = "";
    try {
      body = await response.text();
    } catch (error) {
      return {
        ok: false,
        code: "PORT_ERROR",
        detail: `response body unreadable: ${errorMessage(error)}`,
        status: response.status,
        body: "",
      };
    }

    if (response.status !== 200) {
      return {
        ok: false,
        code: "HTTP_ERROR",
        detail: `http ${String(response.status)} from ${this.endpoint}`,
        status: response.status,
        body,
      };
    }
    if (bodyHasLuaError(body)) {
      return {
        ok: false,
        code: "LUA_ERROR",
        detail: "engine reported a lua error for the posted body",
        status: 200,
        body,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      return {
        ok: false,
        code: "INVALID_JSON",
        detail: `response is not json: ${errorMessage(error)}`,
        status: 200,
        body,
      };
    }
    if (!isRecord(parsed)) {
      return {
        ok: false,
        code: "INVALID_JSON",
        detail: "response is valid json but not an object",
        status: 200,
        body,
      };
    }
    return { ok: true, status: 200, body, parsed };
  }

  async execLua(script: string): Promise<ExecResponse> {
    const result = await this.call(script);
    if (result.ok) {
      return { status: result.status, body: result.body };
    }
    if (result.code === "HTTP_ERROR" || result.code === "INVALID_JSON") {
      return { status: result.status, body: result.body };
    }
    if (result.code === "LUA_ERROR") {
      return {
        status: 200,
        body: JSON.stringify({
          error: "LUA_ERROR",
          detail: result.detail,
          body: result.body,
        }),
      };
    }
    return { status: 0, body: `port_error: ${result.detail}` };
  }
}

export type EeFailureCode = "PORT_ERROR" | "HTTP_ERROR" | "LUA_ERROR" | "INVALID_JSON";

export type EeExecResult =
  | { ok: true; status: number; body: string; parsed: Record<string, unknown> }
  | { ok: false; code: EeFailureCode; detail: string; status: number; body: string };

export type VmApiPortOptions = {
  url?: string;
  token: string;
  timeout_ms?: number;
};

export type VmObservationTick = {
  at: number;
  result: ObservationResult;
  detail: string;
};

export type VmCommandRequest = {
  role: VmCommandRole;
  actor_id: string;
  request_id: string;
  intent: string;
  args: Record<string, unknown>;
  generation?: number;
};

export type VmCommandSummary = {
  outcome: string;
  intent: string | null;
  code: string | null;
  reason: string | null;
  detail: string | null;
  status: number | null;
};

export type VmCommandOutcome = {
  at: number;
  ok: boolean;
  http_status: number;
  summary: VmCommandSummary;
  detail: string;
};

export type VmSeatInfo = {
  role: string;
  mode: string;
  generation: number;
  leaseholder: string | null;
};

export type VmHealth = {
  ok: boolean;
  ship: string | null;
  epoch: number | null;
  observation_seq: number;
  seats: VmSeatInfo[];
  uptime_ms: number | null;
  detail: string;
};

export function validateApiUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`EE_API_URL is not a url: ${raw}`);
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return url;
  }
  throw new TypeError(
    `EE_API_URL must use https unless the host is 127.0.0.1 or localhost: ${raw}`,
  );
}

export type ApiTokenSource = {
  token: string;
  from: "file" | "environment";
};

export function readApiTokenFromFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      "EE_API_TOKEN_FILE could not be read; check that the path exists and is readable",
    );
  }
  const token = raw.trim();
  if (token.length === 0) {
    throw new Error("EE_API_TOKEN_FILE is empty; write the vm api token into it");
  }
  if (token.length < MIN_API_TOKEN_LENGTH) {
    throw new Error(
      `EE_API_TOKEN_FILE must hold at least ${String(MIN_API_TOKEN_LENGTH)} characters`,
    );
  }
  return token;
}

export function resolveApiToken(env: NodeJS.ProcessEnv): ApiTokenSource {
  const path = env["EE_API_TOKEN_FILE"];
  if (typeof path === "string" && path.trim().length > 0) {
    return { token: readApiTokenFromFile(path.trim()), from: "file" };
  }
  const token = (env["EE_API_TOKEN"] ?? "").trim();
  if (token.length === 0) {
    throw new TypeError(
      "EE_API_TOKEN or EE_API_TOKEN_FILE is required; the drive never talks to /exec.lua",
    );
  }
  if (token.length < MIN_API_TOKEN_LENGTH) {
    throw new TypeError(
      `EE_API_TOKEN must be at least ${String(MIN_API_TOKEN_LENGTH)} characters`,
    );
  }
  return { token, from: "environment" };
}

type RawResponse = {
  at: number;
  http_status: number;
  ok: boolean;
  json: Record<string, unknown> | null;
  text: string;
  detail: string;
};

function summarizeCommandJson(
  json: Record<string, unknown> | null,
  httpStatus: number,
  detail: string,
): VmCommandSummary {
  const result = json && isRecord(json["result"]) ? (json["result"] as Record<string, unknown>) : null;
  if (!result) {
    return {
      outcome: json && json["ok"] === true ? "accepted" : "rejected",
      intent: null,
      code: json && typeof json["error"] === "string" ? json["error"] : null,
      reason: null,
      detail,
      status: httpStatus,
    };
  }
  const pick = (key: string): string | null => {
    const value = result[key];
    return typeof value === "string" ? value : null;
  };
  const status = result["status"];
  return {
    outcome: typeof result["outcome"] === "string" ? result["outcome"] : "unknown",
    intent: pick("intent"),
    code: pick("code"),
    reason: pick("reason"),
    detail: pick("detail"),
    status: typeof status === "number" ? status : httpStatus,
  };
}

export class VmApiPort {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  calls = 0;
  readonly #token: string;

  constructor(options: VmApiPortOptions) {
    if (typeof options?.token !== "string" || options.token.trim().length === 0) {
      throw new TypeError("EE_API_TOKEN or EE_API_TOKEN_FILE is required for the vm api client");
    }
    const token = options.token.trim();
    if (token.length < MIN_API_TOKEN_LENGTH) {
      throw new TypeError(
        `the vm api token must be at least ${String(MIN_API_TOKEN_LENGTH)} characters`,
      );
    }
    const timeoutMs = options.timeout_ms ?? DEFAULT_VMAPI_TIMEOUT_MS;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError(`invalid timeout_ms: ${String(timeoutMs)}`);
    }
    this.#token = token;
    this.timeoutMs = timeoutMs;
    this.baseUrl = validateApiUrl(options.url ?? DEFAULT_VMAPI_URL)
      .toString()
      .replace(/\/+$/, "");
  }

  private async request(
    path: string,
    init: { method: string; body?: string } = { method: "GET" },
  ): Promise<RawResponse> {
    this.calls += 1;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: "application/json",
    };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return {
        at: Date.now(),
        http_status: 0,
        ok: false,
        json: null,
        text: "",
        detail: `${errorMessage(error)} (${this.baseUrl}${path}, limit ${String(this.timeoutMs)}ms)`,
      };
    }
    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      return {
        at: Date.now(),
        http_status: response.status,
        ok: false,
        json: null,
        text: "",
        detail: `response body unreadable: ${errorMessage(error)}`,
      };
    }
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        json = parsed;
      }
    } catch {
      json = null;
    }
    const detail =
      json && typeof json["detail"] === "string"
        ? json["detail"]
        : json && typeof json["error"] === "string"
          ? json["error"]
          : text.slice(0, 300);
    return {
      at: Date.now(),
      http_status: response.status,
      ok: response.status === 200,
      json,
      text,
      detail,
    };
  }

  async observe(): Promise<VmObservationTick> {
    const response = await this.request("/v1/observe");
    if (!response.ok || response.json === null) {
      return {
        at: response.at,
        result: observationFailure(
          "PORT_ERROR",
          `vm api observe failed (http ${String(response.http_status)}): ${response.detail}`,
          response.text,
        ),
        detail: response.detail,
      };
    }
    if (response.json["ok"] !== true || response.json["observation"] === undefined) {
      const code = typeof response.json["code"] === "string" ? response.json["code"] : "INVALID_JSON";
      return {
        at: response.at,
        result: observationFailure(code, response.detail, response.text),
        detail: response.detail,
      };
    }
    const result = parseObservationObject(response.json["observation"]);
    return { at: response.at, result, detail: result.ok ? "" : result.detail };
  }

  async command(request: VmCommandRequest): Promise<VmCommandOutcome> {
    if (!isVmCommandRole(request.role)) {
      throw new TypeError(`invalid role: ${String(request.role)}`);
    }
    if (typeof request.intent !== "string" || !(INTENT_NAMES as readonly string[]).includes(request.intent)) {
      throw new TypeError(`intent is not in the allowlist: ${String(request.intent)}`);
    }
    if (!isRecord(request.args) || hasLuaField(request.args)) {
      throw new TypeError("args must be a plain object without lua fields");
    }
    const payload: Record<string, unknown> = {
      role: request.role,
      actor_id: request.actor_id,
      request_id: request.request_id,
      intent: request.intent,
      args: request.args,
    };
    if (typeof request.generation === "number" && Number.isInteger(request.generation)) {
      payload["generation"] = request.generation;
    }
    const response = await this.request("/v1/command", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const summary = summarizeCommandJson(response.json, response.http_status, response.detail);
    return {
      at: response.at,
      ok: summary.outcome === "accepted",
      http_status: response.http_status,
      summary,
      detail: response.detail,
    };
  }

  async health(): Promise<VmHealth> {
    const response = await this.request("/v1/health");
    const json = response.json;
    const seats: VmSeatInfo[] = [];
    if (json && Array.isArray(json["seats"])) {
      for (const entry of json["seats"] as unknown[]) {
        if (!isRecord(entry)) {
          continue;
        }
        seats.push({
          role: typeof entry["role"] === "string" ? entry["role"] : "unknown",
          mode: typeof entry["mode"] === "string" ? entry["mode"] : "unknown",
          generation: typeof entry["generation"] === "number" ? entry["generation"] : -1,
          leaseholder: typeof entry["leaseholder"] === "string" ? entry["leaseholder"] : null,
        });
      }
    }
    return {
      ok: response.ok && json !== null && json["ok"] === true,
      ship: json && typeof json["ship"] === "string" ? json["ship"] : null,
      epoch: json && typeof json["epoch"] === "number" ? json["epoch"] : null,
      observation_seq: json && typeof json["observation_seq"] === "number" ? json["observation_seq"] : 0,
      seats,
      uptime_ms: json && typeof json["uptime_ms"] === "number" ? json["uptime_ms"] : null,
      detail: response.detail,
    };
  }
}