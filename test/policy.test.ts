import { describe, expect, it } from "vitest";
import { evaluateDial, type DialContext } from "../src/policy/dialPolicy.js";
import {
  balanceDue,
  buildPlanSchedule,
  feeWaiverEligible,
  partialBounds,
  planEligibility,
  retryAllowed,
  validatePromiseDate,
} from "../src/policy/offers.js";
import { addDays, isValidYmd, localParts, zonedLocalToUtc } from "../src/policy/time.js";
import { TOOL_NAMES, toolParametersJsonSchema } from "../src/agent/tools.js";
import { DEMO_NUMBER, makeRepo, NOON_IST } from "./helpers.js";

function ctx(overrides: Partial<DialContext> = {}): DialContext {
  const { repo } = makeRepo();
  const customer = repo.getCustomer("cus_01")!;
  return {
    customer,
    invoice: repo.invoiceForCustomer("cus_01"),
    to: DEMO_NUMBER,
    now: NOON_IST,
    allowlist: [DEMO_NUMBER],
    window: { startHour: 8, endHour: 19 },
    dialedLast7d: 0,
    lastRightPartyContactAt: undefined,
    callInProgress: false,
    ...overrides,
  };
}

describe("evaluateDial", () => {
  it("allows a consented, collectable customer inside calling hours", () => {
    expect(evaluateDial(ctx())).toEqual({ allowed: true });
  });

  it("never dials a number that is not allowlisted", () => {
    expect(evaluateDial(ctx({ to: "+910000099999" }))).toMatchObject({ allowed: false, code: "NOT_ALLOWLISTED" });
    expect(evaluateDial(ctx({ to: undefined }))).toMatchObject({ allowed: false, code: "NO_DEMO_NUMBER" });
  });

  it("blocks do-not-call, missing consent and disputed accounts", () => {
    const base = ctx();
    expect(evaluateDial({ ...base, customer: { ...base.customer, dnc: 1 } })).toMatchObject({ code: "DO_NOT_CALL" });
    expect(evaluateDial({ ...base, customer: { ...base.customer, consent: 0 } })).toMatchObject({ code: "NO_CONSENT" });
    expect(evaluateDial({ ...base, customer: { ...base.customer, dispute_flag: 1 } })).toMatchObject({ code: "DISPUTED" });
  });

  it("blocks when nothing is owed", () => {
    const base = ctx();
    expect(evaluateDial({ ...base, invoice: { ...base.invoice!, status: "paid" } })).toMatchObject({ code: "NOTHING_OWED" });
    expect(evaluateDial({ ...base, invoice: { ...base.invoice!, status: "under_review" } })).toMatchObject({ code: "NOTHING_OWED" });
  });

  it("enforces the calling window in the customer's timezone", () => {
    expect(evaluateDial(ctx({ now: new Date("2026-10-02T02:00:00Z") }))).toMatchObject({ code: "OUTSIDE_CALLING_HOURS" });
    expect(evaluateDial(ctx({ now: new Date("2026-10-02T13:30:00Z") }))).toMatchObject({ code: "OUTSIDE_CALLING_HOURS" });
    expect(evaluateDial(ctx({ now: new Date("2026-10-02T02:30:00Z") }))).toEqual({ allowed: true });
    expect(evaluateDial(ctx({ now: new Date("2026-10-02T13:29:00Z") }))).toEqual({ allowed: true });
  });

  it("caps attempts at 7 in 7 days and waits 7 days after a conversation", () => {
    expect(evaluateDial(ctx({ dialedLast7d: 7 }))).toMatchObject({ code: "FREQUENCY_CAP" });
    expect(evaluateDial(ctx({ dialedLast7d: 6 }))).toEqual({ allowed: true });
    expect(evaluateDial(ctx({ lastRightPartyContactAt: new Date(NOON_IST.getTime() - 3_600_000).toISOString() }))).toMatchObject({ code: "RECENT_CONVERSATION" });
    expect(evaluateDial(ctx({ lastRightPartyContactAt: new Date(NOON_IST.getTime() - 8 * 86_400_000).toISOString() }))).toEqual({ allowed: true });
  });

  it("does not chase a customer with an open promise or an agreed plan", () => {
    expect(evaluateDial(ctx({ openPromiseUntil: "2026-10-10" }))).toMatchObject({ code: "PROMISE_PENDING" });
    expect(evaluateDial(ctx({ planActive: true }))).toMatchObject({ code: "PLAN_ACTIVE" });
  });

  it("refuses a second concurrent call to the demo phone", () => {
    expect(evaluateDial(ctx({ callInProgress: true }))).toMatchObject({ code: "CALL_IN_PROGRESS" });
  });
});

describe("time helpers", () => {
  it("reads local wall-clock time", () => {
    expect(localParts(NOON_IST, "Asia/Kolkata")).toEqual({ date: "2026-10-02", hour: 12, minute: 0 });
  });

  it("converts a local IST time to UTC", () => {
    expect(zonedLocalToUtc("2026-10-03T10:30", "Asia/Kolkata")?.toISOString()).toBe("2026-10-03T05:00:00.000Z");
    expect(zonedLocalToUtc("2026-02-30T10:30", "Asia/Kolkata")).toBeUndefined();
  });

  it("converts across a DST boundary", () => {
    expect(zonedLocalToUtc("2026-07-01T09:00", "America/New_York")?.toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedLocalToUtc("2026-12-01T09:00", "America/New_York")?.toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });

  it("validates calendar dates", () => {
    expect(isValidYmd("2026-02-28")).toBe(true);
    expect(isValidYmd("2026-02-29")).toBe(false);
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });
});

describe("offer policy", () => {
  const { repo } = makeRepo();
  const inv = (id: string) => repo.invoiceForCustomer(id)!;
  const cust = (id: string) => repo.getCustomer(id)!;

  it("only retries soft declines", () => {
    expect(retryAllowed(inv("cus_01")).ok).toBe(true);
    expect(retryAllowed(inv("cus_02"))).toMatchObject({ ok: false, error: "RETRY_NOT_ALLOWED" });
    expect(retryAllowed(inv("cus_05"))).toMatchObject({ ok: false, error: "RETRY_NOT_ALLOWED" });
    expect(retryAllowed({ ...inv("cus_01"), retry_count: 2 })).toMatchObject({ ok: false, error: "RETRY_LIMIT_REACHED" });
  });

  it("waives late fees only on a first failure", () => {
    expect(feeWaiverEligible(cust("cus_08"), inv("cus_08"))).toBe(true);
    expect(feeWaiverEligible(cust("cus_02"), inv("cus_02"))).toBe(false);
    expect(feeWaiverEligible(cust("cus_01"), inv("cus_01"))).toBe(false);
  });

  it("bounds partial payments", () => {
    expect(partialBounds(inv("cus_10"))).toEqual({ min: 500, max: 2499 });
    expect(partialBounds(inv("cus_03"))).toEqual({ min: 500, max: 799 });
  });

  it("limits promise dates to 14 days", () => {
    expect(validatePromiseDate("2026-10-08", "2026-10-02")).toEqual({ ok: true });
    expect(validatePromiseDate("2026-10-16", "2026-10-02")).toEqual({ ok: true });
    expect(validatePromiseDate("2026-10-17", "2026-10-02")).toMatchObject({ error: "DATE_TOO_FAR" });
    expect(validatePromiseDate("2026-10-01", "2026-10-02")).toMatchObject({ error: "DATE_IN_PAST" });
    expect(validatePromiseDate("2026-10-32", "2026-10-02")).toMatchObject({ error: "INVALID_DATE" });
  });

  it("builds plan schedules that sum to the balance", () => {
    const balance = balanceDue(inv("cus_08"));
    const schedule = buildPlanSchedule(balance, 3, "2026-10-02");
    expect(schedule.reduce((s, i) => s + i.amount, 0)).toBe(balance);
    expect(schedule.map((s) => s.due_date)).toEqual(["2026-10-09", "2026-10-23", "2026-11-06"]);
    expect(planEligibility(inv("cus_08"), 4)).toMatchObject({ error: "INVALID_INSTALLMENTS" });
    expect(planEligibility(inv("cus_03"), 2)).toMatchObject({ error: "BALANCE_TOO_SMALL" });
  });
});

describe("tool schemas", () => {
  it("meet OpenAI strict mode: every property required, no extra properties", () => {
    for (const name of TOOL_NAMES) {
      const schema = toolParametersJsonSchema(name);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    }
  });

  it("marks optional arguments as nullable", () => {
    const amount = toolParametersJsonSchema("send_payment_link").properties.amount as { anyOf?: Array<{ type?: string }> };
    expect(amount.anyOf?.some((s) => s.type === "null")).toBe(true);
  });
});

describe("provisioning helpers", () => {
  it("restricts outbound countries to the allowlisted numbers", async () => {
    const { outboundCountries } = await import("../src/agent/provision.js");
    const { testConfig } = await import("./helpers.js");
    expect(outboundCountries(testConfig())).toEqual(["IN"]);
    expect(outboundCountries(testConfig({ ALLOWED_DIAL_NUMBERS: "+910000012345,+14155550123" }))).toEqual(["IN", "US", "CA"]);
    expect(() => outboundCountries(testConfig({ ALLOWED_DIAL_NUMBERS: "+81312345678" }))).toThrow(/Unknown country/);
  });
});

describe("notifier", () => {
  it("returns without waiting for the email provider, then records delivery", async () => {
    const { createNotifier } = await import("../src/notify/outbox.js");
    const { testConfig } = await import("./helpers.js");
    const { repo } = makeRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = (async () => {
      await gate;
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const notifier = createNotifier(repo, testConfig({ RESEND_API_KEY: "re_x", DEMO_EMAIL: "me@example.com" }), fetchImpl);
    const customer = repo.getCustomer("cus_02")!;
    const channels = await notifier.sendPaymentLink({ customer, url: "https://x/pay/t", purpose: "pay_full", amount: 10, token: "t" });
    expect(channels).toEqual(["sms", "email"]);
    expect(repo.listOutbox().find((m) => m.channel === "email")!.delivery).toBe("queued");
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(repo.listOutbox().find((m) => m.channel === "email")).toMatchObject({ delivery: "sent", provider_ref: "em_1" });
  });
});

describe("agent configuration", () => {
  it("renders every policy number from config into the prompt and tool descriptions", async () => {
    const { buildLlmParams } = await import("../src/agent/agentConfig.js");
    const { testConfig } = await import("./helpers.js");
    const llm = buildLlmParams(testConfig({ CALLING_WINDOW_START_HOUR: "9", CALLING_WINDOW_END_HOUR: "18" }), "https://x.test");
    expect(llm.general_prompt).toContain("between 09:00 and 18:00");
    expect(llm.general_prompt).not.toMatch(/\[\[|08:00|19:00/);
    const callback = llm.general_tools!.find((t) => t.name === "schedule_callback") as { description: string; url: string };
    expect(callback.description).toContain("between 09:00 and 18:00");
    expect(callback.url).toBe("https://x.test/retell/functions/schedule_callback");
    expect(JSON.stringify(llm.general_tools)).not.toContain("[[");
  });
});
