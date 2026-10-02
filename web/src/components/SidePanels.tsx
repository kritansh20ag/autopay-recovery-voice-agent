import { label, money, time, type CustomerView, type State } from "../api";

export function CustomerPanel({ c, calls, onOpen }: { c: CustomerView; calls: State["calls"]; onOpen: (id: string) => void }) {
  const history = calls.filter((k) => k.customerId === c.id);
  return (
    <section className="panel">
      <header>
        <h2>Persona · {c.fullName}</h2>
      </header>
      <div className="body">
        <dl className="persona">
          <dt>Date of birth</dt>
          <dd>{c.persona.dob}</dd>
          <dt>PIN code</dt>
          <dd>{c.persona.pincode}</dd>
          <dt>Display phone</dt>
          <dd>{c.displayPhone}</dd>
          <dt>Balance</dt>
          <dd>{money(c.balance)}</dd>
        </dl>
        <div className="tip">
          <strong>Play it like this:</strong> {c.persona.tip}
        </div>
        <p className="sub">{c.persona.scenario}</p>
        {!c.eligibility.allowed && <p className="blocked">Dial blocked: {c.eligibility.reason}</p>}
        <div className="list">
          {history.length === 0 && <div className="empty">No calls yet.</div>}
          {history.map((k) => (
            <button key={k.id} className="btn sm" style={{ textAlign: "left" }} onClick={() => onOpen(k.id)}>
              {time(k.createdAt)} · {k.channel} · {label(k.disposition ?? k.status)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Outbox({ items }: { items: State["outbox"] }) {
  return (
    <section className="panel">
      <header>
        <h2>Outbox</h2>
        <span className="sub">SMS is simulated</span>
      </header>
      <div className="body list">
        {items.length === 0 && <div className="empty">No messages sent.</div>}
        {items.slice(0, 6).map((m) => {
          const url = /https?:\/\/\S+/.exec(m.body)?.[0];
          return (
            <div key={m.id} className="msg">
              <div className="meta">
                <span>
                  {m.channel} → {m.to_address}
                </span>
                <span>
                  {m.delivery} · {time(m.created_at)}
                </span>
              </div>
              {m.body.replace(url ?? "", "")}
              {url && (
                <div>
                  <a href={url} target="_blank" rel="noreferrer">
                    {url}
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Commitments({ state }: { state: State }) {
  const rows = [
    ...state.promises.map((p) => ({ key: `p${p.id}`, who: p.customerName, what: `Promise ${money(p.amount)} by ${p.promise_date}`, tag: p.status })),
    ...state.plans.map((p) => ({ key: `l${p.id}`, who: p.customerName, what: `${p.installments}-part plan from ${p.schedule[0]?.due_date ?? ""}`, tag: "plan" })),
    ...state.callbacks.map((k) => ({ key: `c${k.id}`, who: k.customerName, what: `Callback ${new Date(k.scheduled_for).toLocaleString("en-IN")}`, tag: "callback" })),
    ...state.escalations.map((e) => ({ key: `e${e.id}`, who: e.customerName, what: e.reason, tag: e.kind })),
  ];
  return (
    <section className="panel">
      <header>
        <h2>Commitments &amp; escalations</h2>
      </header>
      <div className="body list">
        {rows.length === 0 && <div className="empty">Nothing yet.</div>}
        {rows.slice(0, 10).map((r) => (
          <div key={r.key} className="msg">
            <div className="meta">
              <span>{r.who}</span>
              <span>{label(r.tag)}</span>
            </div>
            {r.what}
          </div>
        ))}
      </div>
    </section>
  );
}

export function Compliance({ items }: { items: State["compliance"] }) {
  return (
    <section className="panel">
      <header>
        <h2>Compliance log</h2>
      </header>
      <div className="body list">
        {items.length === 0 && <div className="empty">No blocked or failed dials.</div>}
        {items.slice(0, 8).map((a) => (
          <div key={a.id} className="msg">
            <div className="meta">
              <span>{a.customerName}</span>
              <span>{time(a.attempted_at)}</span>
            </div>
            <span className="blocked">{a.block_code}</span> {a.block_reason}
          </div>
        ))}
      </div>
    </section>
  );
}
