import { fmtDateTime } from '../lib/format';
import type { StateSnapshot } from '../lib/types';

export function MemoryTab(props: { snapshot: StateSnapshot }): JSX.Element {
  const { snapshot } = props;

  const vaultAccessLog = snapshot.audit.filter((entry) => entry.actor === 'vault');

  return (
    <div className="memory-tab">
      {snapshot.facts.length === 0 ? (
        <div className="tab-empty">No facts in memory.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>subject</th>
                <th>predicate</th>
                <th>value</th>
                <th>conf</th>
                <th>sens</th>
                <th>source</th>
                <th>expires</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.facts.map((fact) => (
                <tr key={fact.id} className={fact.supersededBy ? 'fact-superseded' : undefined}>
                  <td>{fact.subject}</td>
                  <td>{fact.predicate}</td>
                  <td>
                    <span className="fact-value">{fact.value}</span>
                    {fact.supersededBy ? (
                      <div className="superseded-link">superseded by {fact.supersededBy}</div>
                    ) : null}
                  </td>
                  <td className="mono">{fact.confidence.toFixed(2)}</td>
                  <td>
                    <span className={`sens sens-${fact.sensitivity}`}>{fact.sensitivity}</span>
                  </td>
                  <td>
                    <span className="mono">{fact.source.kind}</span>
                    {fact.source.assertedBy ? (
                      <span className="muted"> by {fact.source.assertedBy}</span>
                    ) : null}
                  </td>
                  <td className="mono">{fact.expiresAt ? fmtDateTime(fact.expiresAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="vault-section">
        <div className="section-label">Vault</div>
        {snapshot.vault.length === 0 ? (
          <div className="tab-empty">Vault is empty.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>label</th>
                  <th>created</th>
                  <th>value</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.vault.map((item) => (
                  <tr key={item.id}>
                    <td>{item.label}</td>
                    <td className="mono">{fmtDateTime(item.createdAt)}</td>
                    <td className="mono vault-redacted">••••••• (encrypted)</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="section-label">Vault access log</div>
        {vaultAccessLog.length === 0 ? (
          <div className="tab-empty">No vault access recorded.</div>
        ) : (
          <ul className="vault-log mono">
            {vaultAccessLog.map((entry) => (
              <li key={entry.id}>
                <span className="vault-log-time">{fmtDateTime(entry.timestamp)}</span> {entry.action}
                {entry.target ? ` → ${entry.target}` : ''} · {entry.result}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
