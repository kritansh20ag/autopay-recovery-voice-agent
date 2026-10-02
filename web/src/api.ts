import type { buildCallDetail, buildState } from "../../src/api/state.js";
import type { AppEvent } from "../../src/events/bus.js";

export type State = ReturnType<typeof buildState>;
export type CustomerView = State["customers"][number];
export type CallSummary = State["calls"][number];
export type CallDetail = NonNullable<ReturnType<typeof buildCallDetail>>;
export type { AppEvent };

export interface WebCallStart {
  ok: true;
  callId: string;
  accessToken: string;
  transport?: string;
  iceServers?: RTCIceServer[];
}

export type ApiFailure = { ok: false; code: string; reason: string };

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T;
  return body;
}

const post = (url: string) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

export const api = {
  state: () => fetch("/api/state").then((r) => json<State>(r)),
  call: (id: string) => fetch(`/api/calls/${id}`).then((r) => json<CallDetail>(r)),
  dial: (customerId: string) => post(`/api/customers/${customerId}/call`).then((r) => json<{ ok: true; callId: string } | ApiFailure>(r)),
  webCall: (customerId: string) => post(`/api/customers/${customerId}/web-call`).then((r) => json<WebCallStart | ApiFailure>(r)),
  startCampaign: () => post("/api/campaign/start").then((r) => json<State["campaign"]>(r)),
  stopCampaign: () => post("/api/campaign/stop").then((r) => json<State["campaign"]>(r)),
  reset: () => post("/api/demo/reset").then((r) => json<{ ok?: boolean; error?: string }>(r)),
};

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
export const money = (n: number) => inr.format(n);
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
export const label = (s: string | null | undefined) => (s ? s.replace(/_/g, " ") : "—");
