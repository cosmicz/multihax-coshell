import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { renderCompanionPage } from "./html.ts";
import type { PageOptions } from "./html.ts";
import { validateOrderInput } from "./state.ts";
import { APP_LEVEL_ROLE, isStationRole } from "./types.ts";
import type { CompanionState, Controller, Order, Role } from "./types.ts";

export interface CompanionServerOptions {
  state: CompanionState;
  controller: Controller;
  page?: PageOptions;
}

const MAX_BODY_BYTES = 64 * 1024;

type BodyResult = { ok: true; value: unknown } | { ok: false; detail: string };

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(html),
  });
  response.end(html);
}

function readJsonBody(request: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, detail: "request body too large" });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => {
      finish({ ok: false, detail: "request body could not be read" });
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        finish({ ok: false, detail: "request body is empty" });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, detail: "request body is not valid JSON" });
      }
    });
  });
}

function seatSnapshotWith(
  state: CompanionState,
  controller: Controller,
): ReturnType<CompanionState["snapshot"]> {
  const snapshot = state.snapshot();
  snapshot.seats = snapshot.seats.map((seat) => ({
    ...seat,
    native_occupancy: controller.occupancy(seat.role),
  }));
  return snapshot;
}

export function createServer(options: CompanionServerOptions): Server {
  const state = options.state;
  const controller = options.controller;
  let sequence = 0;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return prefix + "-" + String(state.epoch()) + "-" + String(sequence);
  };

  return createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    let pathname = "/";
    try {
      pathname = new URL(request.url ?? "/", "http://companion.invalid").pathname;
    } catch {
      sendJson(response, 400, { error: "BAD_REQUEST", detail: "unparsable request url" });
      return;
    }

    if (method === "GET" && pathname === "/") {
      sendHtml(response, renderCompanionPage(seatSnapshotWith(state, controller), options.page ?? {}));
      return;
    }

    if (method === "GET" && pathname === "/api/state") {
      sendJson(response, 200, seatSnapshotWith(state, controller));
      return;
    }

    if (pathname === "/api/orders") {
      if (method !== "POST") {
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", detail: "use POST" });
        return;
      }
      void readJsonBody(request).then((body) => {
        if (!body.ok) {
          sendJson(response, 400, { error: "BAD_BODY", reason: "BAD_BODY", detail: body.detail });
          return;
        }
        const validation = validateOrderInput(body.value);
        if (!validation.ok) {
          sendJson(response, 400, {
            error: "INVALID_ORDER",
            reason: validation.reason,
            detail: validation.detail,
          });
          return;
        }
        const order: Order = {
          id: nextId("ord"),
          epoch: state.epoch(),
          at: Date.now(),
          from_role: APP_LEVEL_ROLE,
          to_role: validation.to_role,
          text: validation.text,
        };
        state.postOrder(order);
        sendJson(response, 202, { ok: true, order, epoch: state.epoch(), actuated: false });
      });
      return;
    }

    const seatAction = /^\/api\/seats\/([^/]+)\/(pause|resume)$/.exec(pathname);
    if (seatAction) {
      if (method !== "POST") {
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", detail: "use POST" });
        return;
      }
      const rawRole = seatAction[1] ?? "";
      const action = seatAction[2] === "resume" ? "resume" : "pause";
      let role = rawRole;
      try {
        role = decodeURIComponent(rawRole);
      } catch {
        sendJson(response, 400, { error: "BAD_ROLE", detail: "role is not valid percent-encoding" });
        return;
      }
      if (!isStationRole(role)) {
        sendJson(response, 404, {
          error: "UNKNOWN_SEAT",
          detail: "no native seat for role: " + role,
        });
        return;
      }
      const seatRole: Role = role;
      const result = action === "resume" ? controller.resume(seatRole) : controller.pause(seatRole);
      if (!result.ok) {
        sendJson(response, 409, {
          error: "SEAT_BUSY",
          reason: result.reason,
          detail: result.detail,
          role: seatRole,
          action,
        });
        return;
      }
      state.note({
        id: nextId("tl"),
        epoch: state.epoch(),
        at: Date.now(),
        kind: action,
        role: seatRole,
        text: action + " accepted for " + seatRole,
      });
      sendJson(response, 200, {
        ok: true,
        role: result.role,
        action,
        mode: result.mode,
        generation: result.generation,
        epoch: state.epoch(),
      });
      return;
    }

    sendJson(response, 404, { error: "NOT_FOUND", detail: "no route for " + pathname });
  });
}

export const createCompanionServer = createServer;