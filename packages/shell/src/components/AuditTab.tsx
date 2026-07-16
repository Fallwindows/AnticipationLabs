import { fmtDateTime, shortHash } from '../lib/format';
import type { AuditEntry, StateSnapshot } from '../lib/types';

/** Append-only trail (I11): ordered by seq, newest last, hash chain visible. */
export function AuditTab(props: { snapshot: StateSnapshot }): JSX.Element {
  const entries = [...props.snapshot.audit].sort((a, b) => a.seq - b.seq);
  if (entries.length === 0) {
    return <div className="tab-empty">Audit trail is empty.</div>;
  }
  return (
    <div className="audit-tab mono">
      <div className="table-wrap">
        <table className="data-table audit-table">
          <thead>
            <tr>
              <th>seq</th>
              <th>timestamp</th>
              <th>actor</th>
              <th>action</th>
              <th>target</th>
              <th>result</th>
              <th>chain</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuditRow(props: { entry: AuditEntry }): JSX.Element {
  const { entry } = props;
  const extras: { label: string; value: string }[] = [];
  if (entry.disclosure) extras.push({ label: 'disclosure', value: entry.disclosure });
  if (entry.spokeTo) extras.push({ label: 'spoke to', value: entry.spokeTo });
  if (entry.promisedETA) extras.push({ label: 'promised ETA', value: entry.promisedETA });

  return (
    <>
      <tr className="audit-row">
        <td className="audit-seq">{entry.seq}</td>
        <td>{fmtDateTime(entry.timestamp)}</td>
        <td className="audit-actor">{entry.actor}</td>
        <td>{entry.action}</td>
        <td>{entry.target ?? '—'}</td>
        <td className="audit-result">{entry.result}</td>
        <td className="audit-chain">
          <span title={`hash ${entry.hash}`}>{shortHash(entry.hash)}</span>
          <span className="chain-prev" title={`prev ${entry.prevHash}`}>
            ↑{shortHash(entry.prevHash)}
          </span>
        </td>
      </tr>
      {extras.length > 0 ? (
        <tr className="audit-extra-row">
          <td />
          <td colSpan={6}>
            {extras.map((extra) => (
              <div key={extra.label} className="audit-extra">
                <span className="audit-extra-label">{extra.label}:</span> {extra.value}
              </div>
            ))}
          </td>
        </tr>
      ) : null}
    </>
  );
}
