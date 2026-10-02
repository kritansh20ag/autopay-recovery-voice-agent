import type { CallRow, Repo } from "../db/db.js";

export type Disposition =
  | "recovered"
  | "partially_recovered"
  | "link_sent"
  | "promise_to_pay"
  | "payment_plan"
  | "already_paid_review"
  | "disputed"
  | "opted_out"
  | "wrong_party"
  | "escalated"
  | "callback_scheduled"
  | "verification_failed"
  | "no_resolution"
  | "not_verified"
  | "voicemail"
  | "no_answer"
  | "busy"
  | "failed";

const NO_ANSWER = new Set(["dial_no_answer", "user_declined", "registered_call_timeout", "error_user_not_joined"]);
const FAILED = new Set([
  "dial_failed",
  "invalid_destination",
  "telephony_provider_permission_denied",
  "telephony_provider_unavailable",
  "sip_routing_error",
  "no_valid_payment",
  "marked_as_spam",
  "concurrency_limit_reached",
  "no_concurrency_fallback",
  "scam_detected",
]);

const TOOL_PRIORITY: Array<[string, Disposition]> = [
  ["report_already_paid", "already_paid_review"],
  ["log_dispute", "disputed"],
  ["mark_do_not_call", "opted_out"],
  ["report_wrong_party", "wrong_party"],
  ["set_up_payment_plan", "payment_plan"],
  ["record_promise_to_pay", "promise_to_pay"],
  ["send_payment_link", "link_sent"],
  ["escalate_to_human", "escalated"],
  ["schedule_callback", "callback_scheduled"],
];

export interface DispositionInput {
  call: Pick<CallRow, "verified" | "locked" | "disconnection_reason">;
  inVoicemail: boolean;
  successfulTools: ReadonlySet<string>;
  payment: "full" | "partial" | "none";
}

export function computeDisposition(input: DispositionInput): Disposition {
  const reason = input.call.disconnection_reason ?? "";
  if (input.payment === "full") return "recovered";
  if (reason === "voicemail_reached" || input.inVoicemail) return "voicemail";
  if (NO_ANSWER.has(reason)) return "no_answer";
  if (reason === "dial_busy") return "busy";
  if (FAILED.has(reason) || reason.startsWith("error_")) {
    if (!input.successfulTools.size) return "failed";
  }
  if (input.payment === "partial") return input.successfulTools.has("record_promise_to_pay") ? "promise_to_pay" : "partially_recovered";
  for (const [tool, disposition] of TOOL_PRIORITY) if (input.successfulTools.has(tool)) return disposition;
  if (input.call.locked) return "verification_failed";
  if (input.call.verified) return "no_resolution";
  return "not_verified";
}

export function refreshDisposition(repo: Repo, callId: string): Disposition | undefined {
  const call = repo.getCall(callId);
  if (!call || call.status !== "ended") return undefined;
  const tools = repo.toolsForCall(callId).filter((t) => t.ok);
  const successfulTools = new Set(tools.map((t) => t.name));
  const retried = tools.some((t) => t.name === "retry_payment");
  const paidLinks = repo.db
    .prepare("SELECT COUNT(*) AS n FROM payment_links WHERE call_id = ? AND status = 'paid'")
    .get(callId) as { n: number };
  const invoice = repo.invoiceForCustomer(call.customer_id);
  const anyPayment = retried || paidLinks.n > 0;
  const payment = !anyPayment ? "none" : invoice?.status === "paid" ? "full" : "partial";
  const analysis = call.analysis_json ? (JSON.parse(call.analysis_json) as { in_voicemail?: boolean }) : {};
  const disposition = computeDisposition({ call, inVoicemail: !!analysis.in_voicemail, successfulTools, payment });
  repo.updateCall(callId, { disposition });
  return disposition;
}
