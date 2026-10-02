import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, money, type AppEvent, type State } from "./api";
import { CallDrawer } from "./components/CallDrawer";
import { CustomerTable } from "./components/CustomerTable";
import { Kpis } from "./components/Kpis";
import { LivePanel, type LiveCall, type ToolEvent } from "./components/LivePanel";
import { Commitments, Compliance, CustomerPanel, Outbox } from "./components/SidePanels";
import { useWebCall, type Utterance } from "./useWebCall";

export function App() {
  const [state, setState] = useState<State>();
  const [selected, setSelected] = useState<string>();
  const [openCall, setOpenCall] = useState<string>();
  const [live, setLive] = useState<LiveCall>();
  const [toast, setToast] = useState<string>();
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const refreshTimer = useRef<number | undefined>(undefined);
  const nameOf = useRef(new Map<string, string>());

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? undefined : t)), 5000);
  }, []);
  const web = useWebCall(notify);

  const refresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(async () => {
      const s = await api.state();
      nameOf.current = new Map(s.customers.map((c) => [c.id, c.fullName]));
      setState(s);
      setVersion((v) => v + 1);
    }, 200);
  }, []);

  useEffect(() => {
    refresh();
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as AppEvent;
      const name = (e.customerId && nameOf.current.get(e.customerId)) || "Customer";
      setLive((cur) => applyEvent(cur, e, name));
      if (e.type === "payment.received") notify(`${money(Number(e.data?.amount ?? 0))} received from ${name}`);
      if (e.type === "dial.blocked") notify(`Blocked: ${name} — ${String(e.data?.reason ?? "")}`);
      if (e.type === "dial.failed") notify(`Dial failed: ${String(e.data?.reason ?? "")}`);
      refresh();
    };
    es.onerror = () => refresh();
    return () => es.close();
  }, [refresh, notify]);

  const dial = async (id: string) => {
    setBusy(true);
    const res = await api.dial(id);
    setBusy(false);
    if (!res.ok) notify(res.reason);
    refresh();
  };

  const campaign = state?.campaign;
  const toggleCampaign = async () => {
    if (campaign?.running) await api.stopCampaign();
    else await api.startCampaign();
    refresh();
  };

  const reset = async () => {
    if (!window.confirm("Reset all demo data back to the 10 failed autopays?")) return;
    const r = await api.reset();
    if (r.error) notify(r.error);
    setLive(undefined);
    setSelected(undefined);
    refresh();
  };

  const shownLive = useMemo<LiveCall | undefined>(() => {
    if (web.callId && web.customerId && (web.status === "live" || web.status === "connecting" || live?.callId === web.callId)) {
      const base = live?.callId === web.callId ? live : undefined;
      return {
        callId: web.callId,
        customerId: web.customerId,
        customerName: nameOf.current.get(web.customerId) ?? "Customer",
        channel: "web",
        status: web.status === "connecting" ? "connecting" : web.status === "live" ? "ongoing" : base?.status ?? "ended",
        disposition: base?.disposition,
        utterances: web.utterances.length ? web.utterances : base?.utterances ?? [],
        tools: base?.tools ?? [],
      };
    }
    return live;
  }, [live, web.callId, web.customerId, web.status, web.utterances]);

  if (!state) return <div className="shell">Loading…</div>;
  const cfg = state.config;
  const selectedCustomer = state.customers.find((c) => c.id === selected);
  const phoneBusy = busy || !!campaign?.running || state.calls.some((k) => k.channel === "phone" && k.status !== "ended" && Date.now() - Date.parse(k.createdAt) < 600_000);
  const webBusy = web.status === "connecting" || web.status === "live";

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <h1>{cfg.companyName} · Autopay recovery</h1>
          <p>
            Voice agent “{cfg.agentName}” on Retell · 10 fictional accounts · every call rings only the demo phone
          </p>
        </div>
        <div className="chips">
          <span className={`chip ${cfg.provisioned ? "ok" : "bad"}`}>{cfg.provisioned ? "agent provisioned" : "agent not provisioned"}</span>
          <span className={`chip ${cfg.demoPhoneConfigured ? "ok" : "bad"}`}>demo phone {cfg.demoPhone}</span>
          <span className="chip">
            calls {String(cfg.callingWindow.startHour).padStart(2, "0")}:00–{String(cfg.callingWindow.endHour).padStart(2, "0")}:00 local
          </span>
          <span className="chip" title={cfg.publicBaseUrl}>
            {cfg.publicBaseUrl.replace(/^https?:\/\//, "")}
          </span>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={toggleCampaign} disabled={!campaign?.running && phoneBusy}>
            {campaign?.running ? "Stop campaign" : "Run campaign"}
          </button>
          <button className="btn" onClick={reset} disabled={!!campaign?.running}>
            Reset demo
          </button>
        </div>
      </header>

      <Kpis k={state.kpis} />

      <div className="grid">
        <div className="stack">
          <section className="panel slot-table">
            <header>
              <h2>Failed autopays</h2>
              {campaign?.running && (
                <span className="sub">
                  <span className="live-dot" />
                  campaign: {nameOf.current.get(campaign.currentCustomerId ?? "") ?? "starting"} · {campaign.results.length}/{state.customers.length} done
                </span>
              )}
            </header>
            <CustomerTable
              customers={state.customers}
              selected={selected}
              busy={phoneBusy}
              webBusy={webBusy}
              onSelect={setSelected}
              onDial={dial}
              onWebCall={(id) => void web.start(id)}
            />
          </section>
        </div>
        <div className="stack">
          <div className="slot-live">
            <LivePanel live={shownLive} agentTalking={web.agentTalking} onStopWeb={web.stop} onOpen={setOpenCall} />
          </div>
          {selectedCustomer && (
            <div className="slot-persona">
              <CustomerPanel c={selectedCustomer} calls={state.calls} onOpen={setOpenCall} />
            </div>
          )}
          <div className="slot-rest">
            <Outbox items={state.outbox} />
          </div>
          <div className="slot-rest">
            <Commitments state={state} />
          </div>
          <div className="slot-rest">
            <Compliance items={state.compliance} />
          </div>
        </div>
      </div>

      {openCall && <CallDrawer callId={openCall} version={version} onClose={() => setOpenCall(undefined)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function applyEvent(cur: LiveCall | undefined, e: AppEvent, name: string): LiveCall | undefined {
  if (!e.callId) return cur;
  if (e.type === "dial.placed") {
    return { callId: e.callId, customerId: e.customerId ?? "", customerName: name, channel: e.data?.channel === "web" ? "web" : "phone", status: "registered", utterances: [], tools: [] };
  }
  const base: LiveCall =
    cur && cur.callId === e.callId
      ? cur
      : { callId: e.callId, customerId: e.customerId ?? "", customerName: name, channel: "phone", status: "ongoing", utterances: [], tools: [] };
  switch (e.type) {
    case "call.started":
      return { ...base, status: "ongoing" };
    case "call.transcript":
      return { ...base, utterances: (e.data?.utterances as Utterance[] | undefined) ?? base.utterances };
    case "tool.invoked": {
      const result = (e.data?.result ?? {}) as Record<string, unknown>;
      const tool: ToolEvent = { name: String(e.data?.name), ok: !!result.ok, args: e.data?.args, result, at: e.at };
      return { ...base, tools: [...base.tools, tool] };
    }
    case "call.ended":
    case "call.analyzed":
      return { ...base, status: "ended", disposition: (e.data?.disposition as string | undefined) ?? base.disposition };
    default:
      return cur;
  }
}
