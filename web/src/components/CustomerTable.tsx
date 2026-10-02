import { label, money, type CustomerView } from "../api";

interface Props {
  customers: CustomerView[];
  selected?: string;
  busy: boolean;
  webBusy: boolean;
  onSelect: (id: string) => void;
  onDial: (id: string) => void;
  onWebCall: (id: string) => void;
}

export function CustomerTable({ customers, selected, busy, webBusy, onSelect, onDial, onWebCall }: Props) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th className="hide-sm">Failure</th>
            <th className="num">Balance</th>
            <th>Status</th>
            <th className="hide-sm">Last call</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id} className={selected === c.id ? "selected" : undefined} onClick={() => onSelect(c.id)}>
              <td>
                <div className="name">{c.fullName}</div>
                <div className="sub">
                  {c.planName} · {c.paymentMethod}
                </div>
              </td>
              <td className="hide-sm">
                <div>{label(c.failureCode)}</div>
                <div className="sub">attempts {c.attempts}</div>
              </td>
              <td className="num">
                {money(c.balance)}
                {c.lateFee > 0 && <div className="sub">{c.lateFeeWaived ? "fee waived" : `incl. ${money(c.lateFee)} fee`}</div>}
              </td>
              <td>
                <span className={`pill ${c.status}`}>{label(c.status)}</span>
                {!c.eligibility.allowed && label(c.eligibility.code).toLowerCase() !== label(c.status) && (
                  <div className="blocked" title={c.eligibility.reason}>
                    {label(c.eligibility.code).toLowerCase()}
                  </div>
                )}
              </td>
              <td className="hide-sm sub">{label(c.lastDisposition)}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <div className="actions">
                  <button
                    className="btn sm primary"
                    disabled={busy || !c.eligibility.allowed}
                    title={c.eligibility.allowed ? "Call the demo phone as this customer" : c.eligibility.reason}
                    onClick={() => onDial(c.id)}
                  >
                    Call
                  </button>
                  <button className="btn sm" disabled={webBusy || c.balance <= 0 || c.flags.dnc} title="Talk to the agent in the browser" onClick={() => onWebCall(c.id)}>
                    Browser
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
