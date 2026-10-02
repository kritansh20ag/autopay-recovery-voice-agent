import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { CUSTOMERS } from "./customers.js";
import { openDb, Repo } from "./db.js";
import { DAY_MS, localDate } from "../policy/time.js";

const TABLES = [
  "webhook_receipts",
  "tool_invocations",
  "outbox",
  "payment_links",
  "promises",
  "payment_plans",
  "callbacks",
  "escalations",
  "dial_attempts",
  "calls",
  "invoices",
  "customers",
];

export function seedDatabase(repo: Repo): void {
  const now = repo.nowDate().getTime();
  const insertCustomer = repo.db.prepare(
    `INSERT INTO customers (id, full_name, first_name, display_phone, email, plan_name, timezone, dob, pincode,
       payment_method_type, payment_method_label, consent, dnc, dispute_flag, prior_failures_12m, scenario, persona_tip, sort_order)
     VALUES (@id, @full_name, @first_name, @display_phone, @email, @plan_name, @timezone, @dob, @pincode,
       @payment_method_type, @payment_method_label, @consent, @dnc, @dispute_flag, @prior_failures_12m, @scenario, @persona_tip, @sort_order)`,
  );
  const insertInvoice = repo.db.prepare(
    `INSERT INTO invoices (id, customer_id, amount, late_fee, currency, due_date, failed_at, failure_code, retry_outcome, ledger_note, status)
     VALUES (@id, @customer_id, @amount, @late_fee, 'INR', @due_date, @failed_at, @failure_code, @retry_outcome, @ledger_note, 'failed')`,
  );

  repo.transaction(() => {
    for (const t of TABLES) repo.db.prepare(`DELETE FROM ${t}`).run();
    CUSTOMERS.forEach((c, i) => {
      insertCustomer.run({
        id: c.id,
        full_name: c.fullName,
        first_name: c.firstName,
        display_phone: c.displayPhone,
        email: c.email,
        plan_name: c.planName,
        timezone: c.timezone,
        dob: c.dob,
        pincode: c.pincode,
        payment_method_type: c.paymentMethodType,
        payment_method_label: c.paymentMethodLabel,
        consent: c.consent ? 1 : 0,
        dnc: c.dnc ? 1 : 0,
        dispute_flag: c.disputeFlag ? 1 : 0,
        prior_failures_12m: c.priorFailures12m,
        scenario: c.scenario,
        persona_tip: c.personaTip,
        sort_order: i + 1,
      });
      const due = new Date(now - c.invoice.dueDaysAgo * DAY_MS);
      insertInvoice.run({
        id: `inv_${c.id.slice(4)}`,
        customer_id: c.id,
        amount: c.invoice.amount,
        late_fee: c.invoice.lateFee,
        due_date: localDate(due, c.timezone),
        failed_at: due.toISOString(),
        failure_code: c.invoice.failureCode,
        retry_outcome: c.invoice.retryOutcome,
        ledger_note: c.invoice.ledgerNote ?? null,
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = loadConfig();
  const repo = new Repo(openDb(config.dbPath));
  seedDatabase(repo);
  console.log(`Seeded ${CUSTOMERS.length} customers into ${config.dbPath}`);
}
