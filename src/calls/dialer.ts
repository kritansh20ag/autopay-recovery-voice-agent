import { setTimeout as sleep } from "node:timers/promises";
import type { AppConfig } from "../config.js";
import type { CustomerRow, Repo } from "../db/db.js";
import type { EventBus } from "../events/bus.js";
import { evaluateDial, evaluateWebCall, type DialDecision } from "../policy/dialPolicy.js";
import { localDate } from "../policy/time.js";
import { describeProviderError, type VoiceProvider, type WebCallSession } from "../retell/client.js";
import { handleRetellWebhook } from "../retell/webhooks.js";

export interface AgentBinding {
  agentId: string;
  agentVersion?: number;
  fromNumber?: string;
  publicBaseUrl?: string;
}

export interface DialerDeps {
  repo: Repo;
  bus: EventBus;
  config: AppConfig;
  provider: VoiceProvider | undefined;
  binding: () => AgentBinding | undefined;
  timings?: Partial<DialerTimings>;
}

export interface DialerTimings {
  staleCallMs: number;
  callWaitMs: number;
  interCallPauseMs: number;
  reconcileAfterMs: number;
}

const DEFAULT_TIMINGS: DialerTimings = { staleCallMs: 6 * 60_000, callWaitMs: 7 * 60_000, interCallPauseMs: 5000, reconcileAfterMs: 90_000 };
const TERMINAL = new Set(["ended", "error", "not_connected"]);

export type DialResult = { ok: true; callId: string } | { ok: false; code: string; reason: string };

export interface CampaignState {
  running: boolean;
  startedAt?: string;
  currentCustomerId?: string;
  currentCallId?: string;
  results: Array<{ customerId: string; outcome: string; detail?: string }>;
}

const DAY_MS = 86_400_000;

export function spokenPhone(e164: string | undefined): string {
  if (!e164) return "the number we called from";
  return e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 $1 $2 $3");
}

export class Dialer {
  private campaign: CampaignState = { running: false, results: [] };
  private abort?: AbortController;
  private placing = false;
  private lastReconcile = 0;
  private readonly timings: DialerTimings;

  constructor(private readonly deps: DialerDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  evaluate(customer: CustomerRow): DialDecision {
    const { repo, config } = this.deps;
    const now = repo.nowDate();
    const active = repo.activeCall();
    const invoice = repo.invoiceForCustomer(customer.id);
    return evaluateDial({
      customer,
      invoice,
      to: config.demoPhoneNumber,
      now,
      allowlist: config.allowedDialNumbers,
      window: config.callingWindow,
      dialedLast7d: repo.dialedAttemptsSince(customer.id, new Date(now.getTime() - 7 * DAY_MS).toISOString()),
      lastRightPartyContactAt: repo.lastRightPartyContactAt(customer.id),
      openPromiseUntil: invoice ? repo.openPromiseUntil(invoice.id, localDate(now, customer.timezone)) : undefined,
      planActive: invoice ? repo.plansForInvoice(invoice.id).length > 0 : false,
      callInProgress: this.placing || (!!active && now.getTime() - Date.parse(active.created_at) < this.timings.staleCallMs),
    });
  }

  private dynamicVariables(customer: CustomerRow, binding: AgentBinding): Record<string, string> {
    const { config, repo } = this.deps;
    return {
      customer_id: customer.id,
      customer_first_name: customer.first_name,
      customer_full_name: customer.full_name,
      company_name: config.companyName,
      agent_name: config.agentName,
      callback_number: spokenPhone(binding.fromNumber),
      today: localDate(repo.nowDate(), customer.timezone),
      customer_timezone: customer.timezone,
    };
  }

  async reconcileActiveCall(minIntervalMs = 0): Promise<void> {
    const { repo, bus, provider } = this.deps;
    const active = repo.activeCall();
    const now = repo.nowDate().getTime();
    if (!active || !provider || now - Date.parse(active.created_at) < this.timings.reconcileAfterMs) return;
    if (Date.now() - this.lastReconcile < minIntervalMs) return;
    this.lastReconcile = Date.now();
    try {
      const call = await provider.getCall(active.id);
      if (call.call_status && TERMINAL.has(call.call_status)) {
        handleRetellWebhook({ repo, bus }, { event: "call_ended", call: { ...call, disconnection_reason: call.disconnection_reason ?? call.call_status } });
      }
    } catch (err) {
      console.warn(`[dialer] could not reconcile call ${active.id}: ${describeProviderError(err)}`);
    }
  }

  async dial(customerId: string): Promise<DialResult> {
    const { repo, bus, config, provider } = this.deps;
    const customer = repo.getCustomer(customerId);
    if (!customer) return { ok: false, code: "UNKNOWN_CUSTOMER", reason: "No such customer." };
    await this.reconcileActiveCall();

    const decision = this.evaluate(customer);
    if (!decision.allowed) {
      repo.insertDialAttempt({ customer_id: customer.id, call_id: null, channel: "phone", result: "blocked", block_code: decision.code, block_reason: decision.reason });
      bus.publish({ type: "dial.blocked", customerId: customer.id, data: { code: decision.code, reason: decision.reason } });
      return { ok: false, code: decision.code, reason: decision.reason };
    }
    const binding = this.deps.binding();
    if (!provider || !binding?.fromNumber) {
      return { ok: false, code: "NOT_PROVISIONED", reason: "Retell is not configured. Set RETELL_API_KEY and run `npm run provision`." };
    }

    this.placing = true;
    const attemptId = repo.insertDialAttempt({ customer_id: customer.id, call_id: null, channel: "phone", result: "dialed", block_code: null, block_reason: null });
    try {
      const { callId } = await provider.createPhoneCall({
        fromNumber: binding.fromNumber,
        toNumber: config.demoPhoneNumber!,
        agentId: binding.agentId,
        agentVersion: binding.agentVersion,
        dynamicVariables: this.dynamicVariables(customer, binding),
        metadata: { customerId: customer.id },
      });
      repo.insertCall({ id: callId, customer_id: customer.id, channel: "phone", status: "registered" });
      repo.updateDialAttempt(attemptId, { call_id: callId });
      bus.publish({ type: "dial.placed", customerId: customer.id, callId });
      return { ok: true, callId };
    } catch (err) {
      const reason = describeProviderError(err);
      repo.updateDialAttempt(attemptId, { result: "error", block_code: "PROVIDER_ERROR", block_reason: reason });
      bus.publish({ type: "dial.failed", customerId: customer.id, data: { reason } });
      return { ok: false, code: "PROVIDER_ERROR", reason };
    } finally {
      this.placing = false;
    }
  }

  async startWebCall(customerId: string): Promise<({ ok: true } & WebCallSession) | { ok: false; code: string; reason: string }> {
    const { repo, bus, provider } = this.deps;
    const customer = repo.getCustomer(customerId);
    if (!customer) return { ok: false, code: "UNKNOWN_CUSTOMER", reason: "No such customer." };
    const decision = evaluateWebCall(customer, repo.invoiceForCustomer(customer.id));
    if (!decision.allowed) return { ok: false, code: decision.code, reason: decision.reason };
    const binding = this.deps.binding();
    if (!provider || !binding) return { ok: false, code: "NOT_PROVISIONED", reason: "Retell is not configured. Set RETELL_API_KEY and run `npm run provision`." };
    try {
      const session = await provider.createWebCall({
        agentId: binding.agentId,
        agentVersion: binding.agentVersion,
        dynamicVariables: this.dynamicVariables(customer, binding),
        metadata: { customerId: customer.id },
      });
      repo.insertCall({ id: session.callId, customer_id: customer.id, channel: "web", status: "registered" });
      repo.insertDialAttempt({ customer_id: customer.id, call_id: session.callId, channel: "web", result: "dialed", block_code: null, block_reason: null });
      bus.publish({ type: "dial.placed", customerId: customer.id, callId: session.callId, data: { channel: "web" } });
      return { ok: true, ...session };
    } catch (err) {
      return { ok: false, code: "PROVIDER_ERROR", reason: describeProviderError(err) };
    }
  }

  campaignState(): CampaignState {
    return structuredClone(this.campaign);
  }

  startCampaign(): CampaignState {
    if (this.campaign.running) return this.campaignState();
    this.abort = new AbortController();
    this.campaign = { running: true, startedAt: this.deps.repo.now(), results: [] };
    this.publishCampaign();
    void this.runCampaign(this.abort.signal).finally(() => {
      this.campaign = { ...this.campaign, running: false, currentCustomerId: undefined, currentCallId: undefined };
      this.publishCampaign();
    });
    return this.campaignState();
  }

  stopCampaign(): CampaignState {
    this.abort?.abort();
    return this.campaignState();
  }

  private publishCampaign(): void {
    this.deps.bus.publish({ type: "campaign.updated", data: { ...this.campaignState() } });
  }

  private async runCampaign(signal: AbortSignal): Promise<void> {
    for (const customer of this.deps.repo.listCustomers()) {
      if (signal.aborted) return;
      this.campaign.currentCustomerId = customer.id;
      this.campaign.currentCallId = undefined;
      this.publishCampaign();

      const result = await this.dial(customer.id);
      if (!result.ok) {
        this.campaign.results.push({ customerId: customer.id, outcome: result.code, detail: result.reason });
        this.publishCampaign();
        if (result.code === "NOT_PROVISIONED") return;
        continue;
      }
      this.campaign.currentCallId = result.callId;
      this.publishCampaign();
      const row = this.deps.repo.getCall(result.callId);
      const ended =
        row?.status === "ended"
          ? { data: { disposition: row.disposition ?? "ended" } }
          : await this.deps.bus.waitFor((e) => e.type === "call.ended" && e.callId === result.callId, this.timings.callWaitMs, signal);
      if (!ended && !signal.aborted) await this.reconcileActiveCall();
      const disposition =
        (ended?.data?.disposition as string | undefined) ?? this.deps.repo.getCall(result.callId)?.disposition ?? (signal.aborted ? "stopped" : "timed_out");
      this.campaign.results.push({ customerId: customer.id, outcome: disposition });
      this.publishCampaign();
      if (signal.aborted) return;
      await sleep(this.timings.interCallPauseMs, undefined, { signal }).catch(() => undefined);
    }
  }
}
