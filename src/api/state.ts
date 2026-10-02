import type { AppConfig } from "../config.js";
import type { CallRow, CustomerRow, InvoiceRow, PaymentLinkRow, Repo } from "../db/db.js";
import type { Dialer } from "../calls/dialer.js";
import { maskPhone } from "../notify/outbox.js";
import { balanceDue, CUSTOMER_SAFE_REASON, totalDue } from "../policy/offers.js";

export type CustomerStatus =
  | "recovered"
  | "partially_paid"
  | "under_review"
  | "disputed"
  | "do_not_call"
  | "payment_plan"
  | "promise_to_pay"
  | "link_sent"
  | "callback"
  | "contacted"
  | "failed";

const NOT_CONNECTED = new Set(["voicemail", "no_answer", "busy", "failed"]);

function deriveStatus(
  customer: CustomerRow,
  invoice: InvoiceRow | undefined,
  facts: { plan: boolean; promise: boolean; liveLink: boolean; callback: boolean; calls: number },
): CustomerStatus {
  if (invoice?.status === "paid") return "recovered";
  if (invoice?.status === "under_review") return "under_review";
  if (invoice?.status === "disputed") return "disputed";
  if (customer.dnc) return "do_not_call";
  if (facts.plan) return "payment_plan";
  if (facts.promise) return "promise_to_pay";
  if (invoice?.status === "partially_paid") return "partially_paid";
  if (facts.liveLink) return "link_sent";
  if (facts.callback) return "callback";
  return facts.calls ? "contacted" : "failed";
}

export function buildState(repo: Repo, config: AppConfig, dialer: Dialer, extras: { provisioned: boolean; publicBaseUrl: string }) {
  const now = repo.nowDate();
  const customers = repo.listCustomers();
  const invoices = new Map(repo.listInvoices().map((i) => [i.customer_id, i]));
  const calls = repo.listCalls(500);
  const links = repo.listLinks();
  const promises = repo.listPromises();
  const plans = repo.listPlans();
  const callbacks = repo.listCallbacks();
  const escalations = repo.listEscalations();
  const attempts = repo.listDialAttempts(500);
  const nameOf = new Map(customers.map((c) => [c.id, c.full_name]));
  const liveLink = (l: PaymentLinkRow) => l.status === "sent" && Date.parse(l.expires_at) > now.getTime();

  const customerViews = customers.map((c) => {
    const inv = invoices.get(c.id);
    const theirCalls = calls.filter((k) => k.customer_id === c.id);
    const last = theirCalls[0];
    const decision = dialer.evaluate(c);
    return {
      id: c.id,
      fullName: c.full_name,
      planName: c.plan_name,
      displayPhone: c.display_phone,
      paymentMethod: c.payment_method_label,
      failureCode: inv?.failure_code,
      failureReason: inv ? CUSTOMER_SAFE_REASON[inv.failure_code] : undefined,
      amount: inv?.amount ?? 0,
      lateFee: inv?.late_fee ?? 0,
      lateFeeWaived: !!inv?.late_fee_waived,
      paid: inv?.paid_amount ?? 0,
      balance: inv ? balanceDue(inv) : 0,
      dueDate: inv?.due_date,
      invoiceStatus: inv?.status,
      status: deriveStatus(c, inv, {
        plan: plans.some((p) => p.customer_id === c.id),
        promise: promises.some((p) => p.customer_id === c.id && p.status === "open"),
        liveLink: links.some((l) => l.customer_id === c.id && liveLink(l)),
        callback: callbacks.some((k) => k.customer_id === c.id && Date.parse(k.scheduled_for) > now.getTime()),
        calls: theirCalls.length,
      }),
      flags: { dnc: !!c.dnc, consent: !!c.consent, dispute: !!c.dispute_flag },
      attempts: attempts.filter((a) => a.customer_id === c.id && a.result === "dialed").length,
      lastCallId: last?.id,
      lastDisposition: last?.disposition ?? (last ? last.status : undefined),
      eligibility: decision.allowed ? { allowed: true as const } : { allowed: false as const, code: decision.code, reason: decision.reason },
      persona: { dob: c.dob, pincode: c.pincode, scenario: c.scenario, tip: c.persona_tip },
    };
  });

  const allInvoices = [...invoices.values()];
  const owed = allInvoices.reduce((s, i) => s + i.amount + i.late_fee, 0);
  const recovered = allInvoices.reduce((s, i) => s + i.paid_amount, 0);
  const dialed = attempts.filter((a) => a.result === "dialed").length;
  const ended = calls.filter((k) => k.status === "ended");
  const connected = ended.filter((k) => k.disposition && !NOT_CONNECTED.has(k.disposition)).length;
  const rightParty = calls.filter((k) => k.verified).length;
  const voicemails = ended.filter((k) => k.disposition === "voicemail").length;
  const toolOk = (name: string) =>
    (repo.db.prepare("SELECT COUNT(*) AS n FROM tool_invocations WHERE name = ? AND ok = 1").get(name) as { n: number }).n;

  return {
    config: {
      companyName: config.companyName,
      agentName: config.agentName,
      demoPhone: maskPhone(config.demoPhoneNumber),
      demoPhoneConfigured: !!config.demoPhoneNumber,
      retellConfigured: !!config.retellApiKey,
      provisioned: extras.provisioned,
      publicBaseUrl: extras.publicBaseUrl,
      callingWindow: config.callingWindow,
    },
    kpis: {
      owed,
      recovered,
      recoveryRate: owed ? recovered / owed : 0,
      customersRecovered: allInvoices.filter((i) => i.status === "paid").length,
      customers: customers.length,
      dialed,
      connected,
      rightParty,
      rightPartyRate: dialed ? rightParty / dialed : 0,
      promises: promises.length,
      plans: plans.length,
      linksSent: links.length,
      linksPaid: links.filter((l) => l.status === "paid").length,
      optOuts: toolOk("mark_do_not_call"),
      escalations: escalations.filter((e) => e.kind !== "wrong_party").length,
      voicemails,
      blocked: attempts.filter((a) => a.result === "blocked").length,
      outstanding: allInvoices.reduce((s, i) => s + balanceDue(i), 0),
      totalDue: allInvoices.reduce((s, i) => s + totalDue(i), 0),
    },
    customers: customerViews,
    calls: calls.slice(0, 50).map((k) => callSummary(k, nameOf.get(k.customer_id))),
    outbox: repo.listOutbox(30),
    compliance: attempts.filter((a) => a.result !== "dialed").slice(0, 50).map((a) => ({ ...a, customerName: nameOf.get(a.customer_id) })),
    promises: promises.map((p) => ({ ...p, customerName: nameOf.get(p.customer_id) })),
    plans: plans.map((p) => ({ ...p, schedule: JSON.parse(p.schedule_json), customerName: nameOf.get(p.customer_id) })),
    callbacks: callbacks.map((k) => ({ ...k, customerName: nameOf.get(k.customer_id) })),
    escalations: escalations.map((e) => ({ ...e, customerName: nameOf.get(e.customer_id) })),
    campaign: dialer.campaignState(),
  };
}

function callSummary(k: CallRow, customerName: string | undefined) {
  return {
    id: k.id,
    customerId: k.customer_id,
    customerName,
    channel: k.channel,
    status: k.status,
    disposition: k.disposition,
    verified: !!k.verified,
    durationMs: k.duration_ms,
    createdAt: k.created_at,
    summary: k.summary,
  };
}

export function buildCallDetail(repo: Repo, callId: string) {
  const call = repo.getCall(callId);
  if (!call) return undefined;
  const customer = repo.getCustomer(call.customer_id);
  return {
    ...callSummary(call, customer?.full_name),
    disconnectionReason: call.disconnection_reason,
    transcript: call.transcript,
    recordingUrl: call.recording_url,
    publicLogUrl: call.public_log_url,
    sentiment: call.sentiment,
    costUsd: call.cost_usd,
    analysis: call.analysis_json ? JSON.parse(call.analysis_json) : null,
    tools: repo.toolsForCall(callId).map((t) => ({
      id: t.id,
      name: t.name,
      ok: !!t.ok,
      args: JSON.parse(t.args_json),
      result: JSON.parse(t.result_json),
      at: t.created_at,
    })),
    links: repo.listLinks().filter((l) => l.call_id === callId),
  };
}
