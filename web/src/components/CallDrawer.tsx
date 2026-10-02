import { useEffect, useState } from "react";
import { api, label, time, type CallDetail } from "../api";

export function CallDrawer({ callId, version, onClose }: { callId: string; version: number; onClose: () => void }) {
  const [detail, setDetail] = useState<CallDetail>();

  useEffect(() => {
    let alive = true;
    api.call(callId).then((d) => alive && setDetail(d));
    return () => {
      alive = false;
    };
  }, [callId, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Call detail">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3>{detail ? `${detail.customerName} · ${label(detail.disposition ?? detail.status)}` : "Loading…"}</h3>
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
        </div>
        {detail && (
          <>
            <section className="panel">
              <div className="body">
                <dl className="kv">
                  <dt>Call ID</dt>
                  <dd className="sub">{detail.id}</dd>
                  <dt>Channel</dt>
                  <dd>{detail.channel}</dd>
                  <dt>Started</dt>
                  <dd>{time(detail.createdAt)}</dd>
                  <dt>Duration</dt>
                  <dd>{detail.durationMs ? `${Math.round(detail.durationMs / 1000)}s` : "—"}</dd>
                  <dt>Ended because</dt>
                  <dd>{label(detail.disconnectionReason)}</dd>
                  <dt>Verified</dt>
                  <dd>{detail.verified ? "yes" : "no"}</dd>
                  <dt>Sentiment</dt>
                  <dd>{detail.sentiment ?? "—"}</dd>
                  <dt>Cost</dt>
                  <dd>{detail.costUsd != null ? `$${detail.costUsd.toFixed(3)}` : "—"}</dd>
                  {detail.publicLogUrl && (
                    <>
                      <dt>Retell log</dt>
                      <dd>
                        <a href={detail.publicLogUrl} target="_blank" rel="noreferrer">
                          open
                        </a>
                      </dd>
                    </>
                  )}
                </dl>
              </div>
            </section>
            {detail.recordingUrl && <audio controls src={detail.recordingUrl} />}
            <section className="panel">
              <header>
                <h2>Summary &amp; analysis</h2>
              </header>
              <div className="body">
                <p style={{ marginTop: 0 }}>{detail.summary ?? "Post-call analysis arrives a few seconds after the call ends."}</p>
                {detail.analysis?.custom && <pre className="raw">{JSON.stringify(detail.analysis.custom, null, 2)}</pre>}
              </div>
            </section>
            <section className="panel">
              <header>
                <h2>Tool calls ({detail.tools.length})</h2>
              </header>
              <div className="body timeline">
                {detail.tools.length === 0 && <div className="empty">No tools were called.</div>}
                {detail.tools.map((t) => (
                  <div key={t.id} className={`tool ${t.ok ? "ok" : "no"}`}>
                    <span className="t">{time(t.at)}</span>
                    <strong>{t.name}</strong> <code>{JSON.stringify(t.args)}</code>
                    <pre className="raw" style={{ marginTop: 6, maxHeight: 160 }}>
                      {JSON.stringify(t.result, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </section>
            <section className="panel">
              <header>
                <h2>Transcript</h2>
              </header>
              <div className="body">
                <pre className="raw">{detail.transcript || "No transcript."}</pre>
              </div>
            </section>
          </>
        )}
      </aside>
    </>
  );
}
