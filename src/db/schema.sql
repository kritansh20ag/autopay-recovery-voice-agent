PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  display_phone TEXT NOT NULL,
  email TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  dob TEXT NOT NULL,
  pincode TEXT NOT NULL,
  payment_method_type TEXT NOT NULL,
  payment_method_label TEXT NOT NULL,
  consent INTEGER NOT NULL DEFAULT 1,
  dnc INTEGER NOT NULL DEFAULT 0,
  dispute_flag INTEGER NOT NULL DEFAULT 0,
  prior_failures_12m INTEGER NOT NULL DEFAULT 0,
  scenario TEXT NOT NULL,
  persona_tip TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  amount INTEGER NOT NULL,
  late_fee INTEGER NOT NULL DEFAULT 0,
  late_fee_waived INTEGER NOT NULL DEFAULT 0,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  due_date TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  failure_code TEXT NOT NULL,
  retry_outcome TEXT NOT NULL DEFAULT 'fail',
  retry_count INTEGER NOT NULL DEFAULT 0,
  ledger_note TEXT,
  status TEXT NOT NULL DEFAULT 'failed',
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_failures INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  disconnection_reason TEXT,
  disposition TEXT,
  duration_ms INTEGER,
  transcript TEXT,
  recording_url TEXT,
  public_log_url TEXT,
  summary TEXT,
  sentiment TEXT,
  analysis_json TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  event TEXT NOT NULL,
  call_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (event, call_id)
);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_links (
  token TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  call_id TEXT,
  purpose TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  to_address TEXT NOT NULL,
  body TEXT NOT NULL,
  link_token TEXT,
  delivery TEXT NOT NULL,
  provider_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  call_id TEXT,
  promise_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  call_id TEXT,
  installments INTEGER NOT NULL,
  schedule_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS callbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  call_id TEXT,
  scheduled_for TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  call_id TEXT,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dial_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  call_id TEXT,
  channel TEXT NOT NULL,
  result TEXT NOT NULL,
  block_code TEXT,
  block_reason TEXT,
  attempted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls(customer_id);
CREATE INDEX IF NOT EXISTS idx_tools_call ON tool_invocations(call_id);
CREATE INDEX IF NOT EXISTS idx_attempts_customer ON dial_attempts(customer_id, attempted_at);
