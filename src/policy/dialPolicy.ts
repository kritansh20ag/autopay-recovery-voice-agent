import type { CustomerRow, InvoiceRow } from "../db/db.js";
import { isCollectable } from "./offers.js";
import { localParts, withinWindow } from "./time.js";

export const MAX_ATTEMPTS_7D = 7;
export const QUIET_PERIOD_DAYS = 7;
const DAY_MS = 86_400_000;

export type BlockCode =
  | "NO_DEMO_NUMBER"
  | "NOT_ALLOWLISTED"
  | "NO_CONSENT"
  | "DO_NOT_CALL"
  | "DISPUTED"
  | "NOTHING_OWED"
  | "CALL_IN_PROGRESS"
  | "OUTSIDE_CALLING_HOURS"
  | "FREQUENCY_CAP"
  | "RECENT_CONVERSATION";

export type DialDecision = { allowed: true } | { allowed: false; code: BlockCode; reason: string };

export interface DialContext {
  customer: CustomerRow;
  invoice: InvoiceRow | undefined;
  to: string | undefined;
  now: Date;
  allowlist: string[];
  window: { startHour: number; endHour: number };
  dialedLast7d: number;
  lastRightPartyContactAt: string | undefined;
  callInProgress: boolean;
}

const block = (code: BlockCode, reason: string): DialDecision => ({ allowed: false, code, reason });

export function evaluateDial(ctx: DialContext): DialDecision {
  if (!ctx.to) return block("NO_DEMO_NUMBER", "DEMO_PHONE_NUMBER is not configured.");
  if (!ctx.allowlist.includes(ctx.to)) return block("NOT_ALLOWLISTED", "Destination number is not on the dial allowlist.");
  if (!ctx.customer.consent) return block("NO_CONSENT", "No valid consent to call this customer's number.");
  if (ctx.customer.dnc) return block("DO_NOT_CALL", "Customer is on the do-not-call list.");
  if (ctx.customer.dispute_flag || ctx.invoice?.status === "disputed") return block("DISPUTED", "Account has an open dispute; collection calls are paused.");
  if (!isCollectable(ctx.invoice)) return block("NOTHING_OWED", "No collectable balance (paid, under review, or no invoice).");
  if (ctx.callInProgress) return block("CALL_IN_PROGRESS", "Another call to the demo phone is still in progress.");

  const local = localParts(ctx.now, ctx.customer.timezone);
  if (!withinWindow(local.hour, ctx.window)) {
    const pad = (h: number) => `${String(h).padStart(2, "0")}:00`;
    return block(
      "OUTSIDE_CALLING_HOURS",
      `Local time for the customer is ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")} (${ctx.customer.timezone}); calls are allowed ${pad(ctx.window.startHour)}–${pad(ctx.window.endHour)}.`,
    );
  }
  if (ctx.dialedLast7d >= MAX_ATTEMPTS_7D) {
    return block("FREQUENCY_CAP", `Already ${ctx.dialedLast7d} call attempts in the last 7 days (cap ${MAX_ATTEMPTS_7D}).`);
  }
  if (ctx.lastRightPartyContactAt) {
    const since = ctx.now.getTime() - Date.parse(ctx.lastRightPartyContactAt);
    if (since < QUIET_PERIOD_DAYS * DAY_MS) {
      return block("RECENT_CONVERSATION", `Spoke with the customer ${Math.floor(since / 3_600_000)}h ago; wait ${QUIET_PERIOD_DAYS} days after a conversation.`);
    }
  }
  return { allowed: true };
}

export function evaluateWebCall(customer: CustomerRow, invoice: InvoiceRow | undefined): DialDecision {
  if (!customer.consent) return block("NO_CONSENT", "No valid consent to contact this customer.");
  if (customer.dnc) return block("DO_NOT_CALL", "Customer is on the do-not-call list.");
  if (customer.dispute_flag || invoice?.status === "disputed") return block("DISPUTED", "Account has an open dispute; collection calls are paused.");
  if (!isCollectable(invoice)) return block("NOTHING_OWED", "No collectable balance (paid, under review, or no invoice).");
  return { allowed: true };
}
