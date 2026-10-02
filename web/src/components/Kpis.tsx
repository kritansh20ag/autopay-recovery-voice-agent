import { money, pct, type State } from "../api";

export function Kpis({ k }: { k: State["kpis"] }) {
  const cells: Array<[string, string, string]> = [
    ["Right-party contacts", String(k.rightParty), `${pct(k.rightPartyRate)} of ${k.dialed} dials`],
    ["Promises to pay", String(k.promises), `${k.plans} payment plan${k.plans === 1 ? "" : "s"}`],
    ["Links paid", `${k.linksPaid}/${k.linksSent}`, "secure links sent"],
    ["Voicemails", String(k.voicemails), `${k.connected} connected calls`],
    ["Opt-outs", String(k.optOuts), `${k.escalations} escalations`],
    ["Blocked by policy", String(k.blocked), "pre-dial gate refusals"],
  ];
  return (
    <section className="kpis" aria-label="Key metrics">
      <div className="kpi hero">
        <div className="k">Recovered</div>
        <div className="v">{money(k.recovered)}</div>
        <div className="s">
          of {money(k.owed)} failed · {k.customersRecovered}/{k.customers} accounts · {pct(k.recoveryRate)}
        </div>
        <div className="bar">
          <span style={{ width: pct(k.recoveryRate) }} />
        </div>
      </div>
      {cells.map(([label, value, sub]) => (
        <div className="kpi" key={label}>
          <div className="k">{label}</div>
          <div className="v">{value}</div>
          <div className="s">{sub}</div>
        </div>
      ))}
    </section>
  );
}
