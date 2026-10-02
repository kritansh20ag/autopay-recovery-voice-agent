import { randomBytes } from "node:crypto";
import type { CustomerRow, InvoiceRow, LinkPurpose, PaymentLinkRow, Repo } from "../db/db.js";
import { balanceDue, isCollectable, POLICY, retryAllowed } from "../policy/offers.js";

export interface PaymentResult {
  invoice: InvoiceRow;
  applied: number;
  fullyPaid: boolean;
}

export function applyPayment(repo: Repo, invoice: InvoiceRow, amount: number): PaymentResult {
  const applied = Math.min(amount, balanceDue(invoice));
  const paidAmount = invoice.paid_amount + applied;
  const fullyPaid = paidAmount >= invoice.amount + (invoice.late_fee_waived ? 0 : invoice.late_fee);
  repo.updateInvoice(invoice.id, {
    paid_amount: paidAmount,
    status: fullyPaid ? "paid" : "partially_paid",
    paid_at: fullyPaid ? repo.now() : invoice.paid_at,
  });
  if (fullyPaid) {
    repo.db.prepare("UPDATE promises SET status = 'kept' WHERE invoice_id = ? AND status = 'open'").run(invoice.id);
  }
  return { invoice: repo.getInvoice(invoice.id)!, applied, fullyPaid };
}

export type RetryResult =
  | { ok: true; outcome: "succeeded"; payment: PaymentResult }
  | { ok: true; outcome: "declined"; retriesLeft: number }
  | { ok: false; error: string; detail: string };

export function retryPayment(repo: Repo, invoice: InvoiceRow): RetryResult {
  const allowed = retryAllowed(invoice);
  if (!allowed.ok) return allowed;
  const retryCount = invoice.retry_count + 1;
  repo.updateInvoice(invoice.id, { retry_count: retryCount });
  if (invoice.retry_outcome === "succeed") {
    return { ok: true, outcome: "succeeded", payment: applyPayment(repo, { ...invoice, retry_count: retryCount }, balanceDue(invoice)) };
  }
  return { ok: true, outcome: "declined", retriesLeft: Math.max(0, POLICY.maxRetries - retryCount) };
}

export function createPaymentLink(
  repo: Repo,
  input: { customer: CustomerRow; invoice: InvoiceRow; purpose: LinkPurpose; amount: number; callId: string | null },
): PaymentLinkRow {
  const token = randomBytes(12).toString("base64url");
  const expires = new Date(repo.nowDate().getTime() + POLICY.linkTtlHours * 3_600_000).toISOString();
  repo.insertLink({
    token,
    customer_id: input.customer.id,
    invoice_id: input.invoice.id,
    call_id: input.callId,
    purpose: input.purpose,
    amount: input.amount,
    expires_at: expires,
  });
  return repo.getLink(token)!;
}

export type LinkPaymentMethod = "card" | "upi";

export type CompleteLinkResult =
  | { ok: true; link: PaymentLinkRow; payment: PaymentResult }
  | { ok: false; error: "NOT_FOUND" | "ALREADY_PAID" | "EXPIRED" | "NOTHING_OWED" | "PAUSED" };

const UPDATED_METHOD_LABEL: Record<LinkPaymentMethod, string> = {
  card: "Visa ending 4242 (updated via secure link)",
  upi: "UPI AutoPay (re-authorised via secure link)",
};

export function completePaymentLink(repo: Repo, token: string, method: LinkPaymentMethod): CompleteLinkResult {
  return repo.transaction(() => {
    const link = repo.getLink(token);
    if (!link) return { ok: false, error: "NOT_FOUND" } as const;
    if (link.status === "paid") return { ok: false, error: "ALREADY_PAID" } as const;
    if (link.status === "expired") return { ok: false, error: "EXPIRED" } as const;
    if (Date.parse(link.expires_at) < repo.nowDate().getTime()) {
      repo.updateLink(token, { status: "expired" });
      return { ok: false, error: "EXPIRED" } as const;
    }
    const invoice = repo.getInvoice(link.invoice_id)!;
    if (invoice.status === "under_review" || invoice.status === "disputed") return { ok: false, error: "PAUSED" } as const;
    if (!isCollectable(invoice)) return { ok: false, error: "NOTHING_OWED" } as const;
    const payment = applyPayment(repo, invoice, link.amount);
    repo.updateLink(token, { status: "paid", paid_at: repo.now() });
    if (link.purpose === "update_method" || link.purpose === "new_mandate") {
      repo.updateCustomer(link.customer_id, {
        payment_method_type: method,
        payment_method_label: UPDATED_METHOD_LABEL[method],
      });
    }
    return { ok: true, link: repo.getLink(token)!, payment } as const;
  });
}
