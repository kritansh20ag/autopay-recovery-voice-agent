import { label, time } from "../api";
import type { Utterance } from "../useWebCall";

export interface ToolEvent {
  name: string;
  ok: boolean;
  args: unknown;
  result: Record<string, unknown>;
  at: string;
}

export interface LiveCall {
  callId: string;
  customerId: string;
  customerName: string;
  channel: "phone" | "web";
  status: string;
  disposition?: string;
  utterances: Utterance[];
  tools: ToolEvent[];
}

interface Props {
  live?: LiveCall;
  agentTalking: boolean;
  onStopWeb?: () => void;
  onOpen: (callId: string) => void;
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

export function LivePanel({ live, agentTalking, onStopWeb, onOpen }: Props) {
  const isLive = live && live.status !== "ended";
  return (
    <section className="panel">
      <header>
        <h2>{isLive ? <><span className="live-dot" />Live call</> : "Last call"}</h2>
        {live && (
          <div className="actions">
            {isLive && live.channel === "web" && onStopWeb && (
              <button className="btn sm danger" onClick={onStopWeb}>
                Hang up
              </button>
            )}
            <button className="btn sm" onClick={() => onOpen(live.callId)}>
              Details
            </button>
          </div>
        )}
      </header>
      <div className="body stack">
        {!live && <div className="empty">No call yet. Press Call on a customer, or Run campaign.</div>}
        {live && (
          <>
            <div>
              <div className="name">{live.customerName}</div>
              <div className="sub">
                {live.channel === "web" ? "browser call" : "phone call"} · {label(live.status)}
                {live.disposition ? ` · ${label(live.disposition)}` : ""}
                {isLive && agentTalking ? " · agent speaking" : ""}
              </div>
            </div>
            <div className="transcript" aria-live="polite">
              {live.utterances.length === 0 && <div className="empty">Waiting for speech…</div>}
              {live.utterances.map((u, i) => (
                <div key={i} className={`utt ${u.role === "agent" ? "agent" : "user"}`}>
                  <b>{u.role === "agent" ? "agent" : "customer"}</b>
                  {u.content}
                </div>
              ))}
            </div>
            <div>
              <div className="sub" style={{ marginBottom: 6 }}>
                Tool calls
              </div>
              <div className="timeline">
                {live.tools.length === 0 && <div className="empty">None yet.</div>}
                {live.tools.map((t, i) => (
                  <div key={i} className={`tool ${t.ok ? "ok" : "no"}`}>
                    <span className="t">{time(t.at)}</span>
                    <strong>{t.name}</strong> <code>{short(t.args)}</code>
                    <div>
                      <code>{t.ok ? "ok" : String(t.result.error ?? "rejected")}</code>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
