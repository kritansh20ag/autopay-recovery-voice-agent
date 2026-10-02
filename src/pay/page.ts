import type { CustomerRow, InvoiceRow, PaymentLinkRow } from "../db/db.js";
import { balanceDue, spokenRupees } from "../policy/offers.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const TITLE: Record<PaymentLinkRow["purpose"], string> = {
  pay_full: "Pay your balance",
  partial: "Make a part-payment",
  update_method: "Update payment method",
  new_mandate: "Set up UPI AutoPay again",
};

function shell(company: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(company)} · Secure payment</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#14171f;--mute:#555b67;--line:#e3e6eb;--brand:#0f62fe;--on-brand:#fff;--ok:#0e7c4a;--banner:#fbe3a8;--on-banner:#3a2700;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#171b22;--ink:#e8eaee;--mute:#a3abb9;--line:#2a303b;--brand:#78a9ff;--on-brand:#0b1530;--ok:#42be65;--banner:#3d2f0a;--on-banner:#f8dc8a;--err:#ff8389}}
*{box-sizing:border-box}html,body{margin:0;padding:0}body{min-height:100vh;display:flex;justify-content:center;align-items:flex-start;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:440px;margin:0 auto;padding:24px 16px}
@media (min-width:720px){main{padding-top:64px}}
.banner{background:var(--banner);color:var(--on-banner);font-weight:600;font-size:13px;padding:8px 12px;border-radius:8px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
h1{font-size:20px;margin:0 0 4px}.mute{color:var(--mute);font-size:14px}
.amount{font-size:34px;font-weight:700;margin:16px 0 4px;font-variant-numeric:tabular-nums}
.row{display:flex;justify-content:space-between;font-size:14px;padding:6px 0;border-top:1px solid var(--line)}
label{display:block;font-size:13px;color:var(--mute);margin:16px 0 6px}
input{width:100%;font-size:17px;padding:12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);letter-spacing:1px}
.tabs{display:flex;gap:8px;margin-top:16px}.tabs label{flex:1;margin:0;border:1px solid var(--line);border-radius:10px;padding:10px;text-align:center;color:var(--ink);cursor:pointer}
.tabs input{display:none}.tabs label:has(input:checked){border-color:var(--brand);outline:2px solid var(--brand)}
button{width:100%;margin-top:20px;font-size:17px;font-weight:600;padding:14px;border:0;border-radius:12px;background:var(--brand);color:var(--on-brand);cursor:pointer}
.err{color:var(--err);font-size:14px;margin-top:12px}.ok{color:var(--ok)}
.foot{font-size:12px;color:var(--mute);margin-top:16px;text-align:center}
</style></head><body><main>
<div class="banner">DEMO checkout. Fictional account. Do not enter real card details.</div>
${body}
<p class="foot">${esc(company)} will never ask for your OTP, CVV or UPI PIN on a call.</p>
</main></body></html>`;
}

export function renderPayPage(input: { company: string; customer: CustomerRow; invoice: InvoiceRow; link: PaymentLinkRow; error?: string }): string {
  const { customer, invoice, link } = input;
  const amount = Math.min(link.amount, balanceDue(invoice));
  const upiFirst = link.purpose === "new_mandate" || customer.payment_method_type === "upi";
  return shell(
    input.company,
    `<div class="card">
<h1>${esc(TITLE[link.purpose])}</h1>
<div class="mute">${esc(customer.full_name)} · ${esc(customer.plan_name)}</div>
<div class="amount">${esc(spokenRupees(amount).replace(" rupees", ""))} <span class="mute">INR</span></div>
<div class="row"><span>Invoice</span><span>${esc(invoice.id)}</span></div>
<div class="row"><span>Due date</span><span>${esc(invoice.due_date)}</span></div>
<div class="row"><span>Link expires</span><span>${esc(new Date(link.expires_at).toLocaleString("en-IN", { timeZone: customer.timezone }))}</span></div>
<form method="post">
<div class="tabs">
<label><input type="radio" name="method" value="card"${upiFirst ? "" : " checked"}> Card</label>
<label><input type="radio" name="method" value="upi"${upiFirst ? " checked" : ""}> UPI</label>
</div>
<label for="card">Test card number (card only)</label>
<input id="card" name="card_number" inputmode="numeric" autocomplete="off" placeholder="4242 4242 4242 4242" value="4242 4242 4242 4242">
${input.error ? `<div class="err">${esc(input.error)}</div>` : ""}
<button type="submit">Pay ${esc(spokenRupees(amount))}</button>
</form></div>`,
  );
}

export function renderPayResult(input: { company: string; title: string; detail: string; ok: boolean }): string {
  return shell(
    input.company,
    `<div class="card"><h1 class="${input.ok ? "ok" : ""}">${esc(input.title)}</h1><p class="mute">${esc(input.detail)}</p></div>`,
  );
}
