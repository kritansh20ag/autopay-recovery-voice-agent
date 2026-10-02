import Retell from "retell-sdk";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, Repo } from "../src/db/db.js";
import { seedDatabase } from "../src/db/seed.js";
import { EventBus, type AppEvent } from "../src/events/bus.js";
import type { Notifier } from "../src/notify/outbox.js";
import type { VoiceProvider } from "../src/retell/client.js";

export const API_KEY = "key_test_webhook";
export const DEMO_NUMBER = "+910000012345";
export const NOON_IST = new Date("2026-10-02T06:30:00Z");

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    RETELL_API_KEY: API_KEY,
    DEMO_PHONE_NUMBER: DEMO_NUMBER,
    ALLOWED_DIAL_NUMBERS: DEMO_NUMBER,
    PUBLIC_BASE_URL: "https://demo.example.test",
    ...overrides,
  });
}

export class Clock {
  constructor(public current: Date) {}
  now = () => this.current;
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function makeRepo(at: Date = NOON_IST) {
  const clock = new Clock(at);
  const repo = new Repo(openDb(":memory:"), clock.now);
  seedDatabase(repo);
  return { repo, clock };
}

export type DialHook = (callId: string, req: Parameters<VoiceProvider["createPhoneCall"]>[0]) => void;

export function fakeProvider(opts: { dialDelayMs?: number; onDial?: DialHook; dialError?: unknown } = {}) {
  let n = 0;
  const calls: Array<Parameters<VoiceProvider["createPhoneCall"]>[0]> = [];
  const provider: VoiceProvider = {
    async createPhoneCall(req) {
      calls.push(req);
      if (opts.dialError) throw opts.dialError;
      const callId = `call_fake_${++n}`;
      if (opts.dialDelayMs) await new Promise((r) => setTimeout(r, opts.dialDelayMs));
      opts.onDial?.(callId, req);
      return { callId };
    },
    async createWebCall() {
      return { callId: `web_fake_${++n}`, accessToken: "tok", transport: "gateway", iceServers: [] };
    },
    async getCall(callId) {
      return { call_id: callId, call_status: "ended", disconnection_reason: "user_hangup", duration_ms: 42_000 };
    },
  };
  return { provider, calls };
}

export const silentNotifier: Notifier = { sendPaymentLink: async () => ["sms"] };

export function makeApp(
  opts: { at?: Date; env?: Record<string, string>; dialDelayMs?: number; onDial?: DialHook; dialError?: unknown } = {},
) {
  const { repo, clock } = makeRepo(opts.at);
  const config = testConfig(opts.env);
  const bus = new EventBus();
  const events: AppEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const { provider, calls } = fakeProvider({ dialDelayMs: opts.dialDelayMs, onDial: opts.onDial, dialError: opts.dialError });
  const { app, publicApp, dialer } = createApp({
    repo,
    config,
    bus,
    provider,
    binding: () => ({ agentId: "agent_test", agentVersion: 3, fromNumber: "+14155550100", publicBaseUrl: "https://demo.example.test" }),
    publicBaseUrl: () => "https://demo.example.test",
    dialerTimings: { interCallPauseMs: 0, callWaitMs: 2000 },
  });
  return { app, publicApp, repo, clock, config, bus, events, dialer, providerCalls: calls };
}

export async function signed(body: unknown): Promise<{ raw: string; signature: string }> {
  const raw = JSON.stringify(body);
  return { raw, signature: await Retell.sign(raw, API_KEY) };
}

export function retellCall(callId: string, customerId: string, extra: Record<string, unknown> = {}) {
  return { call_id: callId, call_type: "phone_call", metadata: { customerId }, retell_llm_dynamic_variables: { customer_id: customerId }, ...extra };
}
