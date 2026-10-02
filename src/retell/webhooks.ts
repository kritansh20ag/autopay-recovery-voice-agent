import type { Repo } from "../db/db.js";
import type { EventBus } from "../events/bus.js";
import { refreshDisposition } from "../calls/disposition.js";

export interface RetellUtterance {
  role: string;
  content: string;
}

export interface RetellCallPayload {
  call_id: string;
  call_type?: "phone_call" | "web_call";
  call_status?: string;
  metadata?: unknown;
  retell_llm_dynamic_variables?: Record<string, unknown>;
  start_timestamp?: number;
  end_timestamp?: number;
  duration_ms?: number;
  disconnection_reason?: string;
  transcript?: string;
  transcript_object?: RetellUtterance[];
  recording_url?: string;
  public_log_url?: string;
  call_cost?: { combined_cost?: number };
  call_analysis?: {
    call_summary?: string;
    user_sentiment?: string;
    call_successful?: boolean;
    in_voicemail?: boolean;
    custom_analysis_data?: unknown;
  };
}

export interface RetellWebhookPayload {
  event: string;
  call: RetellCallPayload;
}

export function customerIdFromCall(call: Pick<RetellCallPayload, "metadata" | "retell_llm_dynamic_variables">): string | undefined {
  const meta = call.metadata as { customerId?: unknown } | undefined;
  if (typeof meta?.customerId === "string") return meta.customerId;
  const dyn = call.retell_llm_dynamic_variables?.customer_id;
  return typeof dyn === "string" ? dyn : undefined;
}

const iso = (ms: number | undefined) => (typeof ms === "number" ? new Date(ms).toISOString() : undefined);

type WebhookOutcome = "handled" | "duplicate" | "ignored";
type PendingEvent = Parameters<EventBus["publish"]>[0];

export function handleRetellWebhook(deps: { repo: Repo; bus: EventBus }, payload: RetellWebhookPayload): WebhookOutcome {
  const { repo, bus } = deps;
  const events: PendingEvent[] = [];
  const outcome = repo.transaction(() => applyWebhook(repo, payload, events));
  for (const e of events) bus.publish(e);
  return outcome;
}

function applyWebhook(repo: Repo, payload: RetellWebhookPayload, events: PendingEvent[]): WebhookOutcome {
  const c = payload.call;
  if (!c?.call_id) return "ignored";

  let row = repo.getCall(c.call_id);
  if (!row) {
    const customerId = customerIdFromCall(c);
    if (!customerId || !repo.getCustomer(customerId)) return "ignored";
    repo.insertCall({ id: c.call_id, customer_id: customerId, channel: c.call_type === "web_call" ? "web" : "phone", status: "registered" });
    row = repo.getCall(c.call_id)!;
  }
  const base = { customerId: row.customer_id, callId: row.id };

  if (payload.event === "transcript_updated") {
    if (row.status === "ended") return "ignored";
    repo.updateCall(row.id, { transcript: c.transcript ?? row.transcript });
    events.push({ type: "call.transcript", ...base, data: { utterances: (c.transcript_object ?? []).slice(-40) } });
    return "handled";
  }

  if (!["call_started", "call_ended", "call_analyzed"].includes(payload.event)) return "ignored";
  if (!repo.claimWebhook(payload.event, c.call_id)) return "duplicate";

  switch (payload.event) {
    case "call_started":
      if (row.status !== "ended") repo.updateCall(row.id, { status: "ongoing", started_at: iso(c.start_timestamp) ?? repo.now() });
      events.push({ type: "call.started", ...base });
      break;
    case "call_ended": {
      repo.updateCall(row.id, {
        status: "ended",
        started_at: iso(c.start_timestamp) ?? row.started_at,
        ended_at: iso(c.end_timestamp) ?? repo.now(),
        duration_ms: c.duration_ms ?? row.duration_ms,
        disconnection_reason: c.disconnection_reason ?? row.disconnection_reason,
        transcript: c.transcript ?? row.transcript,
        recording_url: c.recording_url ?? row.recording_url,
        public_log_url: c.public_log_url ?? row.public_log_url,
      });
      const disposition = refreshDisposition(repo, row.id);
      events.push({ type: "call.ended", ...base, data: { disposition, disconnection_reason: c.disconnection_reason } });
      break;
    }
    case "call_analyzed": {
      const a = c.call_analysis ?? {};
      repo.updateCall(row.id, {
        summary: a.call_summary ?? null,
        sentiment: a.user_sentiment ?? null,
        analysis_json: JSON.stringify({ call_successful: a.call_successful, in_voicemail: a.in_voicemail, custom: a.custom_analysis_data ?? null }),
        cost_usd: typeof c.call_cost?.combined_cost === "number" ? c.call_cost.combined_cost / 100 : null,
        recording_url: c.recording_url ?? row.recording_url,
        transcript: c.transcript ?? row.transcript,
      });
      const disposition = refreshDisposition(repo, row.id);
      events.push({ type: "call.analyzed", ...base, data: { disposition, summary: a.call_summary } });
      break;
    }
  }
  return "handled";
}
