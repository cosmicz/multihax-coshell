import type { ExecResponse, WorldPort } from "./types.ts";

export type FakePlan = ExecResponse | "hang" | { hold: true };

export const OK: ExecResponse = { status: 200, body: '{"ok":true}' };

function isHoldPlan(plan: FakePlan): plan is { hold: true } {
  return typeof plan === "object" && plan !== null && "hold" in plan;
}

export class FakeWorldPort implements WorldPort {
  readonly scripts: string[] = [];
  maxConcurrent = 0;
  calls = 0;
  private readonly plans: FakePlan[];
  private readonly fallback: FakePlan;
  private readonly waiters = new Map<number, (response: ExecResponse) => void>();
  private inFlight = 0;

  constructor(plans: FakePlan[] = [], fallback: FakePlan = OK) {
    this.plans = plans;
    this.fallback = fallback;
  }

  get scriptCount(): number {
    return this.scripts.length;
  }

  lastScript(): string {
    const script = this.scripts[this.scripts.length - 1];
    if (script === undefined) throw new Error("no script was recorded");
    return script;
  }

  reset(): void {
    this.scripts.length = 0;
    this.calls = 0;
    this.maxConcurrent = 0;
    this.waiters.clear();
  }

  async execLua(script: string): Promise<ExecResponse> {
    this.scripts.push(script);
    const index = this.calls;
    this.calls += 1;
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    const plan = this.plans[index] ?? this.fallback;
    if (plan === "hang") {
      return new Promise<ExecResponse>(() => {});
    }
    if (isHoldPlan(plan)) {
      return new Promise<ExecResponse>((resolve) => {
        this.waiters.set(index, (response) => {
          this.inFlight -= 1;
          resolve(response);
        });
      });
    }
    this.inFlight -= 1;
    return plan;
  }

  release(index: number, response: ExecResponse): void {
    const waiter = this.waiters.get(index);
    if (!waiter) {
      throw new Error(`no held call at index ${index}`);
    }
    this.waiters.delete(index);
    waiter(response);
  }
}

export function createFakeWorldPort(
  plans: FakePlan[] = [],
  fallback: FakePlan = OK,
): FakeWorldPort {
  return new FakeWorldPort(plans, fallback);
}