import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeApp, retellCall, signed } from "./helpers.js";

type App = ReturnType<typeof makeApp>;

async function tool(t: App, callId: string, customerId: string, name: string, args: Record<string, unknown> = {}) {
  const { raw, signature } = await signed({ name, call: retellCall(callId, customerId), args });
  const res = await request(t.app).post(`/retell/functions/${name}`).set("Content-Type", "application/json").set("X-Retell-Signature", signature).send(raw);
  expect(res.status).toBe(200);
  return res.body as Record<string, any>;
}

async function webhook(t: App, event: string, call: Record<string, unknown>) {
  const { raw, signature } = await signed({ event, call });
  return request(t.app).post("/retell/webhook").set("Content-Type", "application/json").set("X-Retell-Signature", signature).send(raw);
}

async function placeCall(t: App, customerId: string) {
  const res = await request(t.app).post(`/api/customers/${customerId}/call`).send({});
  expect(res.status).toBe(201);
  return res.body.callId as string;
}

const verifyArgs = (t: App, id: string) => {
  const c = t.repo.getCustomer(id)!;
  return { date_of_birth: c.dob, pincode: c.pincode };
};

describe("Retell signature guard", () => {
  it("rejects unsigned and tampered requests", async () => {
    const t = makeApp();
    const body = JSON.stringify({ name: "get_account_summary", call: retellCall("c1", "cus_02"), args: {} });
    expect((await request(t.app).post("/retell/functions/get_account_summary").set("Content-Type", "application/json").send(body)).status).toBe(401);
    const { signature } = await signed({ other: true });
    expect(
      (await request(t.app).post("/retell/functions/get_account_summary").set("Content-Type", "application/json").set("X-Retell-Signature", signature).send(body)).status,
    ).toBe(401);
    expect((await request(t.app).post("/retell/webhook").set("Content-Type", "application/json").send(body)).status).toBe(401);
  });
});

describe("public listener", () => {
  it("exposes only Retell, checkout and health routes", async () => {
    const t = makeApp();
    expect((await request(t.publicApp).get("/health")).status).toBe(200);
    expect((await request(t.publicApp).get("/api/state")).status).toBe(404);
    expect((await request(t.publicApp).get("/api/events")).status).toBe(404);
    expect((await request(t.publicApp).post("/api/customers/cus_01/call").send({})).status).toBe(404);
    expect((await request(t.publicApp).post("/api/demo/reset").send({})).status).toBe(404);
    expect((await request(t.publicApp).get("/")).status).toBe(404);
    expect(t.providerCalls).toHaveLength(0);
  });

  it("rejects dashboard POSTs that are not JSON, so cross-site forms cannot trigger dials", async () => {
    const t = makeApp();
    const res = await request(t.app).post("/api/customers/cus_01/call").type("form").send("x=1");
    expect(res.status).toBe(415);
    expect(t.providerCalls).toHaveLength(0);
  });

  it("returns JSON errors without stack traces", async () => {
    const t = makeApp();
    const res = await request(t.app).post("/api/campaign/start").set("Content-Type", "application/json").send("{bad json");
    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/at .*\.js|node_modules/);
  });
});

describe("verification gate", () => {
  it("refuses account tools until identity is verified and locks after two failures", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_02");

    expect(await tool(t, callId, "cus_02", "get_account_summary")).toMatchObject({ ok: false, error: "NOT_VERIFIED" });
    expect(await tool(t, callId, "cus_02", "verify_identity", { date_of_birth: "1990-01-01", pincode: "682020" })).toMatchObject({
      ok: false,
      error: "VERIFICATION_FAILED",
      attempts_remaining: 1,
    });
    const locked = await tool(t, callId, "cus_02", "verify_identity", { date_of_birth: "1988-11-03", pincode: "000000" });
    expect(locked).toMatchObject({ ok: false, error: "VERIFICATION_LOCKED" });
    expect(JSON.stringify(locked)).not.toMatch(/2,?599|expired/i);
    expect(await tool(t, callId, "cus_02", "verify_identity", verifyArgs(t, "cus_02"))).toMatchObject({ ok: false, error: "VERIFICATION_LOCKED" });
    expect(await tool(t, callId, "cus_02", "send_payment_link", { purpose: "pay_full" })).toMatchObject({ ok: false, error: "VERIFICATION_LOCKED" });
  });

  it("accepts null for optional arguments, as strict-mode tool calls send them", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_02");
    await tool(t, callId, "cus_02", "verify_identity", verifyArgs(t, "cus_02"));
    expect(await tool(t, callId, "cus_02", "send_payment_link", { purpose: "update_method", amount: null })).toMatchObject({ ok: true, amount: 2599 });
    expect(await tool(t, callId, "cus_02", "report_already_paid", { paid_on: null, method: null, reference: null })).toMatchObject({ ok: true });
    expect(await tool(t, callId, "cus_02", "mark_do_not_call", { reason: null })).toMatchObject({ ok: true });
    expect(t.repo.getCustomer("cus_02")!.dnc).toBe(1);
  });

  it("rejects malformed arguments without crashing", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_02");
    expect(await tool(t, callId, "cus_02", "verify_identity", { date_of_birth: "3rd Nov" })).toMatchObject({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(await tool(t, callId, "cus_02", "no_such_tool")).toMatchObject({ ok: false, error: "UNKNOWN_TOOL" });
  });
});

describe("end-to-end recovery", () => {
  it("expired card: verify → summary → update link → customer pays → call recovered", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_02");
    expect(t.providerCalls[0]).toMatchObject({
      toNumber: "+910000012345",
      agentId: "agent_test",
      agentVersion: 3,
      metadata: { customerId: "cus_02" },
      dynamicVariables: { customer_first_name: "Priya", company_name: "Acme Fiber" },
    });
    expect(Object.values(t.providerCalls[0]!.dynamicVariables).join(" ")).not.toMatch(/2499|2,499|expired/);

    expect((await webhook(t, "call_started", retellCall(callId, "cus_02"))).status).toBe(204);
    expect(await tool(t, callId, "cus_02", "verify_identity", verifyArgs(t, "cus_02"))).toMatchObject({ ok: true, verified: true });

    const summary = await tool(t, callId, "cus_02", "get_account_summary");
    expect(summary).toMatchObject({ ok: true, balance_due: 2599, retry_allowed: false, reason_for_customer: "the card on file has expired", fee_waiver_eligible: false });

    expect(await tool(t, callId, "cus_02", "retry_payment", { customer_confirmed: true })).toMatchObject({ ok: false, error: "RETRY_NOT_ALLOWED" });
    expect(await tool(t, callId, "cus_02", "waive_late_fee")).toMatchObject({ ok: false, error: "NOT_ELIGIBLE" });

    const sent = await tool(t, callId, "cus_02", "send_payment_link", { purpose: "update_method" });
    expect(sent).toMatchObject({ ok: true, amount: 2599 });
    const link = t.repo.listLinks()[0]!;
    expect(t.events.some((e) => e.type === "link.sent" && e.data?.url === `https://demo.example.test/pay/${link.token}`)).toBe(true);

    const page = await request(t.app).get(`/pay/${link.token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Priya Nair");

    const wrongCard = await request(t.app).post(`/pay/${link.token}`).type("form").send({ method: "card", card_number: "4111 1111 1111 1111" });
    expect(wrongCard.status).toBe(422);
    expect(t.repo.invoiceForCustomer("cus_02")!.status).toBe("failed");

    const paid = await request(t.app).post(`/pay/${link.token}`).type("form").send({ method: "card", card_number: "4242 4242 4242 4242" });
    expect(paid.status).toBe(200);
    expect(paid.text).toContain("Payment successful");
    expect(t.repo.invoiceForCustomer("cus_02")).toMatchObject({ status: "paid", paid_amount: 2599 });
    expect(t.repo.getCustomer("cus_02")!.payment_method_label).toMatch(/4242/);
    expect((await request(t.app).post(`/pay/${link.token}`).type("form").send({ method: "card", card_number: "4242424242424242" })).status).toBe(409);

    const ended = await webhook(t, "call_ended", retellCall(callId, "cus_02", { disconnection_reason: "agent_hangup", duration_ms: 95_000, transcript: "Agent: Hello" }));
    expect(ended.status).toBe(204);
    expect(t.repo.getCall(callId)).toMatchObject({ status: "ended", disposition: "recovered", verified: 1 });

    const dup = await webhook(t, "call_ended", retellCall(callId, "cus_02", { disconnection_reason: "agent_hangup" }));
    expect(dup.headers["x-webhook-outcome"]).toBe("duplicate");

    const state = (await request(t.app).get("/api/state")).body;
    expect(state.kpis).toMatchObject({ recovered: 2599, customersRecovered: 1, linksSent: 1, linksPaid: 1, rightParty: 1 });
    expect(state.customers.find((c: any) => c.id === "cus_02")).toMatchObject({ status: "recovered", eligibility: { allowed: false, code: "NOTHING_OWED" } });
  });

  it("insufficient funds: immediate retry succeeds", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_01");
    await tool(t, callId, "cus_01", "verify_identity", verifyArgs(t, "cus_01"));
    expect(await tool(t, callId, "cus_01", "retry_payment", { customer_confirmed: false })).toMatchObject({ ok: false, error: "NEEDS_CONFIRMATION" });
    expect(await tool(t, callId, "cus_01", "retry_payment", { customer_confirmed: true })).toMatchObject({ ok: true, outcome: "payment_succeeded", amount_charged: 1199 });
    await webhook(t, "call_ended", retellCall(callId, "cus_01", { disconnection_reason: "user_hangup" }));
    expect(t.repo.getCall(callId)!.disposition).toBe("recovered");
  });

  it("promise to pay within policy", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_03");
    await tool(t, callId, "cus_03", "verify_identity", verifyArgs(t, "cus_03"));
    expect(await tool(t, callId, "cus_03", "record_promise_to_pay", { promise_date: "2026-10-30" })).toMatchObject({ ok: false, error: "DATE_TOO_FAR" });
    expect(await tool(t, callId, "cus_03", "record_promise_to_pay", { promise_date: "2026-10-08" })).toMatchObject({ ok: true, amount: 799, days_from_today: 6 });
    await webhook(t, "call_ended", retellCall(callId, "cus_03", { disconnection_reason: "user_hangup" }));
    expect(t.repo.getCall(callId)!.disposition).toBe("promise_to_pay");
    const view = (await request(t.app).get("/api/state")).body.customers.find((c: any) => c.id === "cus_03");
    expect(view).toMatchObject({ status: "promise_to_pay", eligibility: { allowed: false, code: "RECENT_CONVERSATION" } });
  });

  it("hardship: fee waiver then a 3-part plan", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_08");
    await tool(t, callId, "cus_08", "verify_identity", verifyArgs(t, "cus_08"));
    expect(await tool(t, callId, "cus_08", "waive_late_fee")).toMatchObject({ ok: true, waived_amount: 150, new_balance: 2499 });
    expect(await tool(t, callId, "cus_08", "waive_late_fee")).toMatchObject({ ok: false, error: "NOT_ELIGIBLE" });
    const plan = await tool(t, callId, "cus_08", "set_up_payment_plan", { installments: 3 });
    expect(plan.schedule.map((s: any) => s.amount)).toEqual([833, 833, 833]);
  });

  it("partial payment then promise for the rest", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_10");
    await tool(t, callId, "cus_10", "verify_identity", verifyArgs(t, "cus_10"));
    expect(await tool(t, callId, "cus_10", "send_payment_link", { purpose: "partial", amount: 100 })).toMatchObject({ ok: false, error: "AMOUNT_OUT_OF_RANGE" });
    expect(await tool(t, callId, "cus_10", "send_payment_link", { purpose: "partial", amount: 1000 })).toMatchObject({ ok: true, amount: 1000 });
    const link = t.repo.listLinks()[0]!;
    await request(t.app).post(`/pay/${link.token}`).type("form").send({ method: "upi" });
    expect(t.repo.invoiceForCustomer("cus_10")).toMatchObject({ status: "partially_paid", paid_amount: 1000 });
    expect(await tool(t, callId, "cus_10", "record_promise_to_pay", { promise_date: "2026-10-12" })).toMatchObject({ ok: true, amount: 1499 });
  });

  it("already paid: pauses collection and blocks the next dial", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_07");
    await tool(t, callId, "cus_07", "verify_identity", verifyArgs(t, "cus_07"));
    expect(await tool(t, callId, "cus_07", "report_already_paid", { method: "UPI", paid_on: "two days ago" })).toMatchObject({ ok: true, found_matching_payment: true });
    expect(await tool(t, callId, "cus_07", "send_payment_link", { purpose: "pay_full" })).toMatchObject({ ok: false, error: "NOTHING_TO_COLLECT" });
    await webhook(t, "call_ended", retellCall(callId, "cus_07", { disconnection_reason: "user_hangup" }));
    expect(t.repo.getCall(callId)!.disposition).toBe("already_paid_review");
  });

  it("a dispute expires earlier links and the checkout refuses them", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_04");
    await tool(t, callId, "cus_04", "verify_identity", verifyArgs(t, "cus_04"));
    await tool(t, callId, "cus_04", "send_payment_link", { purpose: "update_method", amount: null });
    const link = t.repo.listLinks()[0]!;
    expect(await tool(t, callId, "cus_04", "log_dispute", { reason: "Never ordered the upgrade" })).toMatchObject({ ok: true });
    expect(t.repo.getLink(link.token)!.status).toBe("expired");
    const paid = await request(t.app).post(`/pay/${link.token}`).type("form").send({ method: "card", card_number: "4242424242424242" });
    expect(paid.status).toBe(409);
    expect(t.repo.invoiceForCustomer("cus_04")).toMatchObject({ status: "disputed", paid_amount: 0 });
  });

  it("rejects a link that expired after 24 hours", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_06");
    await tool(t, callId, "cus_06", "verify_identity", verifyArgs(t, "cus_06"));
    await tool(t, callId, "cus_06", "send_payment_link", { purpose: "update_method", amount: null });
    const link = t.repo.listLinks()[0]!;
    t.clock.advance(25 * 3_600_000);
    const paid = await request(t.app).post(`/pay/${link.token}`).type("form").send({ method: "upi" });
    expect(paid.status).toBe(409);
    expect(paid.text).toContain("Link expired");
    expect(t.repo.invoiceForCustomer("cus_06")!.status).toBe("failed");
  });

  it("stop calling: marks DNC without verification and the dialer refuses afterwards", async () => {
    const t = makeApp();
    const callId = await placeCall(t, "cus_05");
    expect(await tool(t, callId, "cus_05", "mark_do_not_call")).toMatchObject({ ok: true });
    await webhook(t, "call_ended", retellCall(callId, "cus_05", { disconnection_reason: "agent_hangup" }));
    const again = await request(t.app).post("/api/customers/cus_05/call").send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("DO_NOT_CALL");
    expect((await request(t.app).get("/api/state")).body.compliance[0]).toMatchObject({ customer_id: "cus_05", block_code: "DO_NOT_CALL" });
  });
});

describe("dialer", () => {
  it("blocks the DNC customer before anything is dialed", async () => {
    const t = makeApp();
    const res = await request(t.app).post("/api/customers/cus_09/call").send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DO_NOT_CALL");
    expect(t.providerCalls).toHaveLength(0);
  });

  it("allows only one live call to the demo phone at a time", async () => {
    const t = makeApp();
    await placeCall(t, "cus_01");
    const second = await request(t.app).post("/api/customers/cus_02/call").send({});
    expect(second.body.code).toBe("CALL_IN_PROGRESS");
  });

  it("places only one call when two dials race while Retell is still answering", async () => {
    const t = makeApp({ dialDelayMs: 100 });
    const [a, b] = await Promise.all([
      request(t.app).post("/api/customers/cus_01/call").send({}),
      request(t.app).post("/api/customers/cus_02/call").send({}),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.body.code, b.body.code]).toContain("CALL_IN_PROGRESS");
    expect(t.providerCalls).toHaveLength(1);
  });

  it("refuses to dial outside calling hours", async () => {
    const t = makeApp({ at: new Date("2026-10-02T16:00:00Z") });
    const res = await request(t.app).post("/api/customers/cus_01/call").send({});
    expect(res.body.code).toBe("OUTSIDE_CALLING_HOURS");
    expect(t.providerCalls).toHaveLength(0);
  });

  it("maps unanswered calls to no_answer and voicemail", async () => {
    const t = makeApp();
    const a = await placeCall(t, "cus_04");
    await webhook(t, "call_ended", retellCall(a, "cus_04", { disconnection_reason: "dial_no_answer" }));
    expect(t.repo.getCall(a)!.disposition).toBe("no_answer");
    const b = await placeCall(t, "cus_06");
    await webhook(t, "call_ended", retellCall(b, "cus_06", { disconnection_reason: "voicemail_reached" }));
    expect(t.repo.getCall(b)!.disposition).toBe("voicemail");
  });
});
