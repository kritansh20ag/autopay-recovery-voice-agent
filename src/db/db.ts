import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FailureCode, PaymentMethodType } from "./customers.js";

export type DB = Database.Database;

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export interface CustomerRow {
  id: string;
  full_name: string;
  first_name: string;
  display_phone: string;
  email: string;
  plan_name: string;
  timezone: string;
  dob: string;
  pincode: string;
  payment_method_type: PaymentMethodType;
  payment_method_label: string;
  consent: number;
  dnc: number;
  dispute_flag: number;
  prior_failures_12m: number;
  scenario: string;
  persona_tip: string;
  sort_order: number;
}

export type InvoiceStatus = "failed" | "partially_paid" | "paid" | "under_review" | "disputed";

export interface InvoiceRow {
  id: string;
  customer_id: string;
  amount: number;
  late_fee: number;
  late_fee_waived: number;
  paid_amount: number;
  currency: string;
  due_date: string;
  failed_at: string;
  failure_code: FailureCode;
  retry_outcome: "succeed" | "fail";
  retry_count: number;
  ledger_note: string | null;
  status: InvoiceStatus;
  paid_at: string | null;
}

export type CallChannel = "phone" | "web";

export interface CallRow {
  id: string;
  customer_id: string;
  channel: CallChannel;
  status: string;
  verified: number;
  verify_failures: number;
  locked: number;
  disconnection_reason: string | null;
  disposition: string | null;
  duration_ms: number | null;
  transcript: string | null;
  recording_url: string | null;
  public_log_url: string | null;
  summary: string | null;
  sentiment: string | null;
  analysis_json: string | null;
  cost_usd: number | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export type LinkPurpose = "pay_full" | "update_method" | "partial" | "new_mandate";

export interface PaymentLinkRow {
  token: string;
  customer_id: string;
  invoice_id: string;
  call_id: string | null;
  purpose: LinkPurpose;
  amount: number;
  status: "sent" | "paid" | "expired";
  created_at: string;
  expires_at: string;
  paid_at: string | null;
}

export interface ToolInvocationRow {
  id: number;
  call_id: string;
  customer_id: string;
  name: string;
  args_json: string;
  result_json: string;
  ok: number;
  created_at: string;
}

export interface OutboxRow {
  id: number;
  customer_id: string;
  channel: "sms" | "email";
  to_address: string;
  body: string;
  link_token: string | null;
  delivery: "simulated" | "queued" | "sent" | "failed";
  provider_ref: string | null;
  created_at: string;
}

export interface DialAttemptRow {
  id: number;
  customer_id: string;
  call_id: string | null;
  channel: CallChannel;
  result: "dialed" | "blocked" | "error";
  block_code: string | null;
  block_reason: string | null;
  attempted_at: string;
}

export interface PromiseRow {
  id: number;
  customer_id: string;
  invoice_id: string;
  call_id: string | null;
  promise_date: string;
  amount: number;
  status: string;
  created_at: string;
}

export interface PlanRow {
  id: number;
  customer_id: string;
  invoice_id: string;
  call_id: string | null;
  installments: number;
  schedule_json: string;
  created_at: string;
}

export interface CallbackRow {
  id: number;
  customer_id: string;
  call_id: string | null;
  scheduled_for: string;
  created_at: string;
}

export interface EscalationRow {
  id: number;
  customer_id: string;
  call_id: string | null;
  kind: "already_paid" | "dispute" | "hardship" | "human" | "wrong_party";
  reason: string;
  created_at: string;
}

type Patch<T> = Partial<Omit<T, "id">>;

function update<T>(db: DB, table: string, key: string, id: string | number, patch: Patch<T>): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([k]) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE ${table} SET ${sets} WHERE ${key} = @__id`).run({ ...Object.fromEntries(entries), __id: id });
}

export class Repo {
  constructor(readonly db: DB, private readonly clock: () => Date = () => new Date()) {}

  now(): string {
    return this.clock().toISOString();
  }

  nowDate(): Date {
    return this.clock();
  }

  listCustomers(): CustomerRow[] {
    return this.db.prepare("SELECT * FROM customers ORDER BY sort_order").all() as CustomerRow[];
  }

  getCustomer(id: string): CustomerRow | undefined {
    return this.db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as CustomerRow | undefined;
  }

  updateCustomer(id: string, patch: Patch<CustomerRow>): void {
    update(this.db, "customers", "id", id, patch);
  }

  invoiceForCustomer(customerId: string): InvoiceRow | undefined {
    return this.db
      .prepare("SELECT * FROM invoices WHERE customer_id = ? ORDER BY failed_at DESC LIMIT 1")
      .get(customerId) as InvoiceRow | undefined;
  }

  getInvoice(id: string): InvoiceRow | undefined {
    return this.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow | undefined;
  }

  listInvoices(): InvoiceRow[] {
    return this.db.prepare("SELECT * FROM invoices").all() as InvoiceRow[];
  }

  updateInvoice(id: string, patch: Patch<InvoiceRow>): void {
    update(this.db, "invoices", "id", id, patch);
  }

  insertCall(row: Pick<CallRow, "id" | "customer_id" | "channel" | "status">): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO calls (id, customer_id, channel, status, created_at) VALUES (@id, @customer_id, @channel, @status, @created_at)",
      )
      .run({ ...row, created_at: this.now() });
  }

  getCall(id: string): CallRow | undefined {
    return this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as CallRow | undefined;
  }

  updateCall(id: string, patch: Patch<CallRow>): void {
    update(this.db, "calls", "id", id, patch);
  }

  listCalls(limit = 50): CallRow[] {
    return this.db.prepare("SELECT * FROM calls ORDER BY created_at DESC LIMIT ?").all(limit) as CallRow[];
  }

  callsForCustomer(customerId: string): CallRow[] {
    return this.db
      .prepare("SELECT * FROM calls WHERE customer_id = ? ORDER BY created_at DESC")
      .all(customerId) as CallRow[];
  }

  activeCall(): CallRow | undefined {
    return this.db
      .prepare("SELECT * FROM calls WHERE channel = 'phone' AND status IN ('registered', 'ongoing') ORDER BY created_at DESC LIMIT 1")
      .get() as CallRow | undefined;
  }

  claimWebhook(event: string, callId: string): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO webhook_receipts (event, call_id, received_at) VALUES (?, ?, ?)")
      .run(event, callId, this.now());
    return r.changes === 1;
  }

  insertToolInvocation(row: Omit<ToolInvocationRow, "id" | "created_at">): void {
    this.db
      .prepare(
        "INSERT INTO tool_invocations (call_id, customer_id, name, args_json, result_json, ok, created_at) VALUES (@call_id, @customer_id, @name, @args_json, @result_json, @ok, @created_at)",
      )
      .run({ ...row, created_at: this.now() });
  }

  toolsForCall(callId: string): ToolInvocationRow[] {
    return this.db
      .prepare("SELECT * FROM tool_invocations WHERE call_id = ? ORDER BY id")
      .all(callId) as ToolInvocationRow[];
  }

  insertLink(row: Omit<PaymentLinkRow, "status" | "paid_at" | "created_at">): void {
    this.db
      .prepare(
        "INSERT INTO payment_links (token, customer_id, invoice_id, call_id, purpose, amount, status, created_at, expires_at) VALUES (@token, @customer_id, @invoice_id, @call_id, @purpose, @amount, 'sent', @created_at, @expires_at)",
      )
      .run({ ...row, created_at: this.now() });
  }

  getLink(token: string): PaymentLinkRow | undefined {
    return this.db.prepare("SELECT * FROM payment_links WHERE token = ?").get(token) as PaymentLinkRow | undefined;
  }

  updateLink(token: string, patch: Patch<PaymentLinkRow>): void {
    update(this.db, "payment_links", "token", token, patch);
  }

  pendingPartialLinkAmount(invoiceId: string, nowIso: string): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM payment_links WHERE invoice_id = ? AND purpose = 'partial' AND status = 'sent' AND expires_at > ?")
      .get(invoiceId, nowIso) as { n: number };
    return r.n;
  }

  expireOpenLinks(invoiceId: string): number {
    return this.db.prepare("UPDATE payment_links SET status = 'expired' WHERE invoice_id = ? AND status = 'sent'").run(invoiceId).changes;
  }

  listLinks(): PaymentLinkRow[] {
    return this.db.prepare("SELECT * FROM payment_links ORDER BY created_at DESC").all() as PaymentLinkRow[];
  }

  insertOutbox(row: Omit<OutboxRow, "id" | "created_at">): number {
    const r = this.db
      .prepare(
        "INSERT INTO outbox (customer_id, channel, to_address, body, link_token, delivery, provider_ref, created_at) VALUES (@customer_id, @channel, @to_address, @body, @link_token, @delivery, @provider_ref, @created_at)",
      )
      .run({ ...row, created_at: this.now() });
    return Number(r.lastInsertRowid);
  }

  updateOutbox(id: number, patch: Patch<OutboxRow>): void {
    update(this.db, "outbox", "id", id, patch);
  }

  listOutbox(limit = 50): OutboxRow[] {
    return this.db.prepare("SELECT * FROM outbox ORDER BY id DESC LIMIT ?").all(limit) as OutboxRow[];
  }

  insertPromise(row: Omit<PromiseRow, "id" | "status" | "created_at">): void {
    this.db
      .prepare(
        "INSERT INTO promises (customer_id, invoice_id, call_id, promise_date, amount, status, created_at) VALUES (@customer_id, @invoice_id, @call_id, @promise_date, @amount, 'open', @created_at)",
      )
      .run({ ...row, created_at: this.now() });
  }

  openPromiseUntil(invoiceId: string, today: string): string | undefined {
    const r = this.db
      .prepare("SELECT MAX(promise_date) AS d FROM promises WHERE invoice_id = ? AND status = 'open' AND promise_date >= ?")
      .get(invoiceId, today) as { d: string | null };
    return r.d ?? undefined;
  }

  listPromises(): PromiseRow[] {
    return this.db.prepare("SELECT * FROM promises ORDER BY id DESC").all() as PromiseRow[];
  }

  insertPlan(row: Omit<PlanRow, "id" | "created_at">): void {
    this.db
      .prepare(
        "INSERT INTO payment_plans (customer_id, invoice_id, call_id, installments, schedule_json, created_at) VALUES (@customer_id, @invoice_id, @call_id, @installments, @schedule_json, @created_at)",
      )
      .run({ ...row, created_at: this.now() });
  }

  plansForInvoice(invoiceId: string): PlanRow[] {
    return this.db.prepare("SELECT * FROM payment_plans WHERE invoice_id = ? ORDER BY id").all(invoiceId) as PlanRow[];
  }

  updatePlanSchedule(id: number, scheduleJson: string): void {
    this.db.prepare("UPDATE payment_plans SET schedule_json = ? WHERE id = ?").run(scheduleJson, id);
  }

  capOpenPromises(invoiceId: string, maxAmount: number): void {
    this.db.prepare("UPDATE promises SET amount = MIN(amount, ?) WHERE invoice_id = ? AND status = 'open'").run(maxAmount, invoiceId);
  }

  listPlans(): PlanRow[] {
    return this.db.prepare("SELECT * FROM payment_plans ORDER BY id DESC").all() as PlanRow[];
  }

  insertCallback(row: Omit<CallbackRow, "id" | "created_at">): void {
    this.db
      .prepare("INSERT INTO callbacks (customer_id, call_id, scheduled_for, created_at) VALUES (@customer_id, @call_id, @scheduled_for, @created_at)")
      .run({ ...row, created_at: this.now() });
  }

  listCallbacks(): CallbackRow[] {
    return this.db.prepare("SELECT * FROM callbacks ORDER BY id DESC").all() as CallbackRow[];
  }

  insertEscalation(row: Omit<EscalationRow, "id" | "created_at">): number {
    const r = this.db
      .prepare("INSERT INTO escalations (customer_id, call_id, kind, reason, created_at) VALUES (@customer_id, @call_id, @kind, @reason, @created_at)")
      .run({ ...row, created_at: this.now() });
    return Number(r.lastInsertRowid);
  }

  listEscalations(): EscalationRow[] {
    return this.db.prepare("SELECT * FROM escalations ORDER BY id DESC").all() as EscalationRow[];
  }

  insertDialAttempt(row: Omit<DialAttemptRow, "id" | "attempted_at">): number {
    const r = this.db
      .prepare(
        "INSERT INTO dial_attempts (customer_id, call_id, channel, result, block_code, block_reason, attempted_at) VALUES (@customer_id, @call_id, @channel, @result, @block_code, @block_reason, @attempted_at)",
      )
      .run({ ...row, attempted_at: this.now() });
    return Number(r.lastInsertRowid);
  }

  updateDialAttempt(id: number, patch: Patch<DialAttemptRow>): void {
    update(this.db, "dial_attempts", "id", id, patch);
  }

  listDialAttempts(limit = 100): DialAttemptRow[] {
    return this.db.prepare("SELECT * FROM dial_attempts ORDER BY id DESC LIMIT ?").all(limit) as DialAttemptRow[];
  }

  dialedAttemptsSince(customerId: string, sinceIso: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM dial_attempts WHERE customer_id = ? AND channel = 'phone' AND result = 'dialed' AND attempted_at >= ?")
      .get(customerId, sinceIso) as { n: number };
    return r.n;
  }

  lastRightPartyContactAt(customerId: string): string | undefined {
    const r = this.db
      .prepare("SELECT MAX(COALESCE(ended_at, created_at)) AS t FROM calls WHERE customer_id = ? AND channel = 'phone' AND verified = 1")
      .get(customerId) as { t: string | null };
    return r.t ?? undefined;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
