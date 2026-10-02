import type { AppConfig } from "../config.js";
import type { CallRow, CustomerRow, InvoiceRow, Repo } from "../db/db.js";
import type { EventBus } from "../events/bus.js";
import type { Notifier } from "../notify/outbox.js";
import { isToolName, TOOL_SPECS, type ToolArgs, type ToolName } from "../agent/tools.js";
import { createPaymentLink, retryPayment, settleInvoice } from "../payments/ledger.js";
import {
  balanceDue,
  buildPlanSchedule,
  CUSTOMER_SAFE_REASON,
  feeWaiverEligible,
  isCollectable,
  partialBounds,
  planEligibility,
  POLICY,
  RECOMMENDED_ACTIONS,
  retryAllowed,
  spokenRupees,
  validatePromiseDate,
} from "../policy/offers.js";
import { addDays, daysBetween, localDate, localParts, withinWindow, zonedLocalToUtc } from "../policy/time.js";

export interface ToolDeps {
  repo: Repo;
  bus: EventBus;
  config: AppConfig;
  notifier: Notifier;
  publicBaseUrl: () => string;
}

interface Ctx extends ToolDeps {
  call: CallRow;
  customer: CustomerRow;
  invoice: InvoiceRow;
  today: string;
}

export type ToolResult = { ok: boolean } & Record<string, unknown>;

const fail = (error: string, instruction: string, extra: Record<string, unknown> = {}): ToolResult => ({
  ok: false,
  error,
  instruction,
  ...extra,
});

function nothingOwed(inv: InvoiceRow): ToolResult | undefined {
  if (isCollectable(inv)) return undefined;
  const why: Record<string, string> = {
    paid: "The balance is already fully paid. Thank the customer and close.",
    under_review: "This balance is under review after an already-paid claim. Do not collect. Reassure and close.",
    disputed: "This balance is disputed. Do not collect. Reassure that a specialist will follow up.",
  };
  return fail("NOTHING_TO_COLLECT", why[inv.status] ?? "There is nothing to collect right now.", { invoice_status: inv.status });
}

type Handlers = { [N in ToolName]: (ctx: Ctx, args: ToolArgs<N>) => Promise<ToolResult> | ToolResult };

const handlers: Handlers = {
  verify_identity(ctx, args) {
    if (ctx.call.locked) {
      return fail("VERIFICATION_LOCKED", "Verification is locked for this call. Share nothing about the account and end the call politely.", { verified: false });
    }
    if (ctx.call.verified) return { ok: true, verified: true, note: "Already verified on this call." };
    const dobMatch = args.date_of_birth === ctx.customer.dob;
    const pinMatch = args.pincode.replace(/\D/g, "") === ctx.customer.pincode;
    if (dobMatch && pinMatch) {
      ctx.repo.updateCall(ctx.call.id, { verified: 1 });
      return { ok: true, verified: true, next_step: "Call get_account_summary, then explain the failed payment." };
    }
    const failures = ctx.call.verify_failures + 1;
    const locked = failures >= 2;
    ctx.repo.updateCall(ctx.call.id, { verify_failures: failures, locked: locked ? 1 : 0 });
    if (locked) {
      return fail(
        "VERIFICATION_LOCKED",
        "Do not share any account information. Say you could not verify the details and that they can reach us in the app or wait for a call back, then end the call.",
        { verified: false, attempts_remaining: 0 },
      );
    }
    return fail("VERIFICATION_FAILED", "Say the details did not match and ask for date of birth and PIN code once more. Do not say which one was wrong.", {
      verified: false,
      attempts_remaining: 2 - failures,
    });
  },

  get_account_summary(ctx) {
    const blocked = nothingOwed(ctx.invoice);
    if (blocked) return blocked;
    const inv = ctx.invoice;
    const balance = balanceDue(inv);
    const lateFee = inv.late_fee_waived ? 0 : inv.late_fee;
    const bounds = partialBounds(inv);
    return {
      ok: true,
      plan: ctx.customer.plan_name,
      monthly_amount: inv.amount,
      late_fee: lateFee,
      already_paid: inv.paid_amount,
      balance_due: balance,
      balance_due_spoken: spokenRupees(balance),
      due_date: inv.due_date,
      payment_method_on_file: ctx.customer.payment_method_label,
      reason_for_customer: CUSTOMER_SAFE_REASON[inv.failure_code],
      retry_allowed: retryAllowed(inv).ok,
      recommended_actions: RECOMMENDED_ACTIONS[inv.failure_code],
      fee_waiver_eligible: feeWaiverEligible(ctx.customer, inv),
      partial_payment_min: bounds.min,
      promise_latest_date: addDays(ctx.today, POLICY.promiseMaxDays),
      plan_installment_options: balance >= POLICY.planMinBalance ? POLICY.planInstallments : [],
      today: ctx.today,
      guidance: "State the amount and the customer-safe reason in one or two short sentences, then ask how they would like to resolve it.",
    };
  },

  retry_payment(ctx, args) {
    if (!args.customer_confirmed) return fail("NEEDS_CONFIRMATION", "Ask the customer whether you may retry the payment now, and only call again if they say yes.");
    const blocked = nothingOwed(ctx.invoice);
    if (blocked) return blocked;
    const r = retryPayment(ctx.repo, ctx.invoice);
    if (!r.ok) return fail(r.error, `${r.detail} Offer the secure payment link instead.`);
    if (r.outcome === "declined") {
      return fail("RETRY_DECLINED", "The retry was declined by the bank. Offer the secure link to pay another way, or a promise-to-pay date.", {
        retries_left: r.retriesLeft,
      });
    }
    publishPayment(ctx, r.payment.applied, "retry");
    return {
      ok: true,
      outcome: "payment_succeeded",
      amount_charged: r.payment.applied,
      amount_charged_spoken: spokenRupees(r.payment.applied),
      remaining_balance: balanceDue(r.payment.invoice),
      instruction: "Confirm the payment went through and that autopay will continue as normal next month.",
    };
  },

  async send_payment_link(ctx, args) {
    const blocked = nothingOwed(ctx.invoice);
    if (blocked) return blocked;
    const balance = balanceDue(ctx.invoice);
    let amount = balance;
    if (args.purpose === "partial") {
      const bounds = partialBounds(ctx.invoice);
      if (args.amount == null) return fail("AMOUNT_REQUIRED", `Ask how much they can pay now (between ${spokenRupees(bounds.min)} and ${spokenRupees(bounds.max)}).`);
      if (args.amount < bounds.min || args.amount > bounds.max) {
        return fail("AMOUNT_OUT_OF_RANGE", `Part-payments must be between ${spokenRupees(bounds.min)} and ${spokenRupees(bounds.max)}.`, bounds);
      }
      amount = args.amount;
    }
    const link = createPaymentLink(ctx.repo, { customer: ctx.customer, invoice: ctx.invoice, purpose: args.purpose, amount, callId: ctx.call.id });
    const url = `${ctx.publicBaseUrl()}/pay/${link.token}`;
    const channels = await ctx.notifier.sendPaymentLink({ customer: ctx.customer, url, purpose: args.purpose, amount, token: link.token });
    ctx.bus.publish({ type: "link.sent", customerId: ctx.customer.id, callId: ctx.call.id, data: { token: link.token, purpose: args.purpose, amount, channels, url } });
    return {
      ok: true,
      sent_via: channels,
      amount,
      amount_spoken: spokenRupees(amount),
      valid_for_hours: POLICY.linkTtlHours,
      instruction:
        `Tell them the secure link was sent by text message, valid for ${POLICY.linkTtlHours} hours, and that they can complete it now while you wait. Never ask them to read out card numbers, CVV, OTP or UPI PIN.`,
    };
  },

  record_promise_to_pay(ctx, args) {
    const blocked = nothingOwed(ctx.invoice);
    if (blocked) return blocked;
    const check = validatePromiseDate(args.promise_date, ctx.today);
    if (!check.ok) return fail(check.error, check.detail);
    const balance = balanceDue(ctx.invoice);
    const pending = Math.min(balance, ctx.repo.pendingPartialLinkAmount(ctx.invoice.id, ctx.repo.now()));
    const amount = args.amount ?? balance - pending;
    if (amount < 1) return fail("NOTHING_LEFT_TO_PROMISE", "The part-payment link already covers the full balance. Ask them to complete the link instead.");
    if (amount > balance) return fail("AMOUNT_TOO_HIGH", `The remaining balance is only ${spokenRupees(balance)}.`);
    ctx.repo.insertPromise({ customer_id: ctx.customer.id, invoice_id: ctx.invoice.id, call_id: ctx.call.id, promise_date: args.promise_date, amount });
    return {
      ok: true,
      promise_date: args.promise_date,
      days_from_today: daysBetween(ctx.today, args.promise_date),
      amount,
      amount_spoken: spokenRupees(amount),
      ...(pending ? { pending_link_amount: pending, note: `This excludes the ${spokenRupees(pending)} part-payment link that is still open.` } : {}),
      instruction: "Confirm the date and amount back to the customer and mention a reminder will be sent the day before.",
    };
  },

  set_up_payment_plan(ctx, args) {
    const blocked = nothingOwed(ctx.invoice);
    if (blocked) return blocked;
    const check = planEligibility(ctx.invoice, args.installments);
    if (!check.ok) return fail(check.error, check.detail);
    const schedule = buildPlanSchedule(balanceDue(ctx.invoice), args.installments, ctx.today);
    ctx.repo.insertPlan({
      customer_id: ctx.customer.id,
      invoice_id: ctx.invoice.id,
      call_id: ctx.call.id,
      installments: args.installments,
      schedule_json: JSON.stringify(schedule),
    });
    return {
      ok: true,
      schedule: schedule.map((s) => ({ ...s, amount_spoken: spokenRupees(s.amount) })),
      instruction: "Read the schedule back briefly and confirm they agree.",
    };
  },

  waive_late_fee(ctx) {
    const blocked = nothingOwed(ctx.invoice);
    if (blocked) return blocked;
    if (!feeWaiverEligible(ctx.customer, ctx.invoice)) {
      return fail("NOT_ELIGIBLE", "The late fee cannot be waived for this account. Do not promise a waiver.");
    }
    ctx.repo.updateInvoice(ctx.invoice.id, { late_fee_waived: 1 });
    const updated = settleInvoice(ctx.repo, ctx.invoice.id);
    const balance = balanceDue(updated);
    ctx.repo.capOpenPromises(updated.id, balance);
    const plans = ctx.repo.plansForInvoice(updated.id);
    let schedule: ReturnType<typeof buildPlanSchedule> | undefined;
    for (const plan of plans) {
      schedule = buildPlanSchedule(balance, plan.installments, ctx.today);
      ctx.repo.updatePlanSchedule(plan.id, JSON.stringify(schedule));
    }
    return {
      ok: true,
      waived_amount: ctx.invoice.late_fee,
      new_balance: balance,
      new_balance_spoken: spokenRupees(balance),
      ...(updated.status === "paid" ? { instruction: "The waiver cleared the balance. Tell the customer nothing more is due." } : {}),
      ...(schedule
        ? { updated_plan_schedule: schedule.map((s) => ({ ...s, amount_spoken: spokenRupees(s.amount) })), plan_note: "The payment plan was recalculated without the fee. Read the new amounts back." }
        : {}),
    };
  },

  report_already_paid(ctx, args) {
    if (ctx.invoice.status === "paid") return { ok: true, found_matching_payment: true, detail: "The balance shows as paid.", instruction: "Confirm nothing is owed and close." };
    ctx.repo.updateInvoice(ctx.invoice.id, { status: "under_review" });
    ctx.repo.expireOpenLinks(ctx.invoice.id);
    const ticket = ctx.repo.insertEscalation({
      customer_id: ctx.customer.id,
      call_id: ctx.call.id,
      kind: "already_paid",
      reason: `Customer reports payment. When: ${args.paid_on ?? "n/a"}; method: ${args.method ?? "n/a"}; ref: ${args.reference ?? "n/a"}. Ledger: ${ctx.invoice.ledger_note ?? "no matching entry"}.`,
    });
    if (ctx.invoice.ledger_note) {
      return {
        ok: true,
        found_matching_payment: true,
        ledger_detail: ctx.invoice.ledger_note,
        ticket_id: ticket,
        instruction: "Thank them, confirm we can see that payment pending reconciliation, collection is paused, and it will be matched within 48 hours. Do not ask for payment.",
      };
    }
    return {
      ok: true,
      found_matching_payment: false,
      ticket_id: ticket,
      instruction: "Say we could not see it yet, collection is paused while a specialist checks within 48 hours, and they will be emailed the outcome. Do not ask for payment.",
    };
  },

  log_dispute(ctx, args) {
    ctx.repo.updateInvoice(ctx.invoice.id, { status: "disputed" });
    ctx.repo.expireOpenLinks(ctx.invoice.id);
    ctx.repo.updateCustomer(ctx.customer.id, { dispute_flag: 1 });
    const ticket = ctx.repo.insertEscalation({ customer_id: ctx.customer.id, call_id: ctx.call.id, kind: "dispute", reason: args.reason });
    return { ok: true, ticket_id: ticket, instruction: "Confirm the dispute is logged, collection is paused, and a specialist will respond in writing within 5 business days." };
  },

  schedule_callback(ctx, args) {
    const at = zonedLocalToUtc(args.callback_time_local, ctx.customer.timezone);
    if (!at) return fail("INVALID_TIME", "Use the format YYYY-MM-DDTHH:mm in the customer's local time.");
    const now = ctx.repo.nowDate();
    if (at.getTime() <= now.getTime()) return fail("TIME_IN_PAST", "That time has already passed. Ask for a later time.");
    if (at.getTime() - now.getTime() > POLICY.callbackMaxDays * 86_400_000) return fail("TOO_FAR", `Callbacks must be within ${POLICY.callbackMaxDays} days.`);
    const local = localParts(at, ctx.customer.timezone);
    if (!withinWindow(local.hour, ctx.config.callingWindow)) {
      return fail(
        "OUTSIDE_CALLING_HOURS",
        `We can only call between ${ctx.config.callingWindow.startHour}:00 and ${ctx.config.callingWindow.endHour}:00 local time. Suggest a time in that window.`,
      );
    }
    ctx.repo.insertCallback({ customer_id: ctx.customer.id, call_id: ctx.call.id, scheduled_for: at.toISOString() });
    return { ok: true, scheduled_for_local: args.callback_time_local, instruction: "Confirm the callback time and end the call politely." };
  },

  mark_do_not_call(ctx) {
    ctx.repo.updateCustomer(ctx.customer.id, { dnc: 1 });
    return { ok: true, instruction: "Confirm they will not receive further calls from us, apologise for the disturbance, and end the call." };
  },

  escalate_to_human(ctx, args) {
    const ticket = ctx.repo.insertEscalation({
      customer_id: ctx.customer.id,
      call_id: ctx.call.id,
      kind: args.category === "hardship" ? "hardship" : "human",
      reason: `${args.category}: ${args.reason}`,
    });
    return { ok: true, ticket_id: ticket, instruction: `Tell them a specialist will call back within one business day, between ${ctx.config.callingWindow.startHour}:00 and ${ctx.config.callingWindow.endHour}:00.` };
  },

  report_wrong_party(ctx, args) {
    if (args.kind === "wrong_number") ctx.repo.updateCustomer(ctx.customer.id, { consent: 0 });
    ctx.repo.insertEscalation({ customer_id: ctx.customer.id, call_id: ctx.call.id, kind: "wrong_party", reason: args.kind });
    return { ok: true, instruction: "Do not mention the account or the reason for the call. Apologise for the disturbance and end the call." };
  },
};

function publishPayment(ctx: Ctx, amount: number, source: "retry"): void {
  ctx.bus.publish({ type: "payment.received", customerId: ctx.customer.id, callId: ctx.call.id, data: { amount, source } });
}

export interface ToolCallInput {
  name: string;
  callId: string;
  customerId: string | undefined;
  channel: "phone" | "web";
  args: unknown;
}

export async function executeTool(deps: ToolDeps, input: ToolCallInput): Promise<ToolResult> {
  const { repo } = deps;
  if (!isToolName(input.name)) return fail("UNKNOWN_TOOL", "This tool does not exist. Continue the conversation without it.");

  const existing = repo.getCall(input.callId);
  const customerId = existing?.customer_id ?? input.customerId;
  const customer = customerId ? repo.getCustomer(customerId) : undefined;
  const invoice = customer ? repo.invoiceForCustomer(customer.id) : undefined;
  if (!customer || !invoice) return fail("UNKNOWN_CUSTOMER", "The account could not be found. Apologise, say someone will follow up, and end the call.");

  if (!existing) repo.insertCall({ id: input.callId, customer_id: customer.id, channel: input.channel, status: "ongoing" });
  const call = repo.getCall(input.callId)!;
  const spec = TOOL_SPECS[input.name];

  let result: ToolResult;
  const parsed = spec.args.safeParse(input.args ?? {});
  if (!parsed.success) {
    result = fail("INVALID_ARGUMENTS", `Fix the arguments and try again: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"} ${i.message}`).join("; ")}`);
  } else if (spec.gated && call.locked) {
    result = fail("VERIFICATION_LOCKED", "Verification failed too many times. Share nothing about the account and end the call politely.");
  } else if (spec.gated && !call.verified) {
    result = fail("NOT_VERIFIED", "Verify identity first: ask for date of birth and service-address PIN code, then call verify_identity.");
  } else {
    const ctx: Ctx = { ...deps, call, customer, invoice, today: localDate(repo.nowDate(), customer.timezone) };
    const handler = handlers[input.name] as (c: Ctx, a: unknown) => Promise<ToolResult> | ToolResult;
    try {
      result = await handler(ctx, parsed.data);
    } catch (err) {
      console.error(`[tool:${input.name}]`, err);
      result = fail("INTERNAL_ERROR", "Something went wrong on our side. Apologise and offer a specialist callback.");
    }
  }

  repo.insertToolInvocation({
    call_id: call.id,
    customer_id: customer.id,
    name: input.name,
    args_json: JSON.stringify(input.args ?? {}),
    result_json: JSON.stringify(result),
    ok: result.ok ? 1 : 0,
  });
  deps.bus.publish({ type: "tool.invoked", customerId: customer.id, callId: call.id, data: { name: input.name, args: input.args ?? {}, result } });
  return result;
}
