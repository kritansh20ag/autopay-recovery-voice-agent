import type { FailureCode } from "../db/customers.js";
import type { CustomerRow, InvoiceRow } from "../db/db.js";
import { addDays, daysBetween, isValidYmd } from "./time.js";

export const POLICY = {
  promiseMaxDays: 14,
  planInstallments: [2, 3] as const,
  planMinBalance: 1000,
  planFirstDueDays: 7,
  planIntervalDays: 14,
  partialMinAmount: 500,
  partialMinRatio: 0.2,
  maxRetries: 2,
  linkTtlHours: 24,
  callbackMaxDays: 7,
} as const;

const RETRYABLE: Record<FailureCode, boolean> = {
  insufficient_funds: true,
  card_limit_reached: true,
  issuer_decline: true,
  expired_card: false,
  card_replaced: false,
  upi_mandate_revoked: false,
  nach_account_closed: false,
};

export const CUSTOMER_SAFE_REASON: Record<FailureCode, string> = {
  insufficient_funds: "the bank reported insufficient funds at the time of the debit",
  expired_card: "the card on file has expired",
  card_replaced: "the card issuer declined the payment",
  upi_mandate_revoked: "the UPI AutoPay mandate is no longer active",
  nach_account_closed: "the bank account linked to the NACH mandate is no longer active",
  issuer_decline: "the bank declined the payment",
  card_limit_reached: "the card's available limit was reached",
};

export const RECOMMENDED_ACTIONS: Record<FailureCode, string[]> = {
  insufficient_funds: ["retry_payment if funds are now available", "record_promise_to_pay", "partial payment link", "payment plan if hardship"],
  expired_card: ["send_payment_link purpose=update_method"],
  card_replaced: ["send_payment_link purpose=update_method"],
  upi_mandate_revoked: ["send_payment_link purpose=new_mandate", "ask whether the cancellation was intentional"],
  nach_account_closed: ["send_payment_link purpose=update_method"],
  issuer_decline: ["retry_payment once", "send_payment_link purpose=update_method"],
  card_limit_reached: ["partial payment link now", "record_promise_to_pay for the rest", "send_payment_link purpose=update_method"],
};

const inr = new Intl.NumberFormat("en-IN");

export function spokenRupees(amount: number): string {
  return `${inr.format(amount)} rupees`;
}

export function totalDue(inv: InvoiceRow): number {
  return inv.amount + (inv.late_fee_waived ? 0 : inv.late_fee);
}

export function balanceDue(inv: InvoiceRow): number {
  return Math.max(0, totalDue(inv) - inv.paid_amount);
}

export function isCollectable(inv: InvoiceRow | undefined): boolean {
  return !!inv && (inv.status === "failed" || inv.status === "partially_paid") && balanceDue(inv) > 0;
}

export type Decision = { ok: true } | { ok: false; error: string; detail: string };

export function retryAllowed(inv: InvoiceRow): Decision {
  if (!RETRYABLE[inv.failure_code]) {
    return { ok: false, error: "RETRY_NOT_ALLOWED", detail: `Retrying will not work because ${CUSTOMER_SAFE_REASON[inv.failure_code]}.` };
  }
  if (inv.retry_count >= POLICY.maxRetries) {
    return { ok: false, error: "RETRY_LIMIT_REACHED", detail: `The payment has already been retried ${inv.retry_count} times.` };
  }
  return { ok: true };
}

export function feeWaiverEligible(customer: CustomerRow, inv: InvoiceRow): boolean {
  return inv.late_fee > 0 && !inv.late_fee_waived && customer.prior_failures_12m === 0;
}

export function partialBounds(inv: InvoiceRow): { min: number; max: number } {
  const balance = balanceDue(inv);
  const min = Math.min(balance, Math.max(POLICY.partialMinAmount, Math.ceil(balance * POLICY.partialMinRatio)));
  return { min, max: balance };
}

export function validatePromiseDate(promiseDate: string, today: string): Decision {
  if (!isValidYmd(promiseDate)) return { ok: false, error: "INVALID_DATE", detail: "Use the format YYYY-MM-DD." };
  const days = daysBetween(today, promiseDate);
  if (days < 0) return { ok: false, error: "DATE_IN_PAST", detail: `The date must be today (${today}) or later.` };
  if (days > POLICY.promiseMaxDays) {
    return {
      ok: false,
      error: "DATE_TOO_FAR",
      detail: `Promises can be at most ${POLICY.promiseMaxDays} days out, so no later than ${addDays(today, POLICY.promiseMaxDays)}. Offer a payment plan instead if they need longer.`,
    };
  }
  return { ok: true };
}

export interface Installment {
  due_date: string;
  amount: number;
}

export function planEligibility(inv: InvoiceRow, installments: number): Decision {
  if (!(POLICY.planInstallments as readonly number[]).includes(installments)) {
    return { ok: false, error: "INVALID_INSTALLMENTS", detail: `Plans can have ${POLICY.planInstallments.join(" or ")} instalments.` };
  }
  if (balanceDue(inv) < POLICY.planMinBalance) {
    return { ok: false, error: "BALANCE_TOO_SMALL", detail: `Plans need a balance of at least ${spokenRupees(POLICY.planMinBalance)}.` };
  }
  return { ok: true };
}

export function buildPlanSchedule(balance: number, installments: number, today: string): Installment[] {
  const base = Math.floor(balance / installments);
  return Array.from({ length: installments }, (_, i) => ({
    due_date: addDays(today, POLICY.planFirstDueDays + i * POLICY.planIntervalDays),
    amount: i === installments - 1 ? balance - base * (installments - 1) : base,
  }));
}
