import { useState } from 'react';
import { coreClient } from '../lib/client';
import { displayValue, shortHash } from '../lib/format';
import type { ActionSignature, ApprovalCardPayload, Outcome } from '../lib/types';
import { OutcomeStateChip } from './StateChip';

/**
 * The approval surface (I5): renders the exact ActionSignature that will be executed —
 * nothing summarized away — plus the single-use scope. Editing any param invalidates
 * the previous approval and re-binds to a new signature hash.
 */
export function ApprovalCard(props: {
  messageId: string;
  payload: ApprovalCardPayload;
  outcome: Outcome | undefined;
}): JSX.Element {
  const { payload, outcome } = props;
  const signature: ActionSignature | undefined = outcome?.preparedAction ?? payload.signature;
  const signatureHash = outcome?.preparedSignatureHash ?? payload.signatureHash;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!signature) {
    return (
      <div className="approval-card">
        <div className="card-heading">approval requested</div>
        <div className="card-empty">signature not available</div>
      </div>
    );
  }

  const outcomeId = outcome?.id;
  const actionable = outcome?.state === 'AwaitingApproval' && !editing;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = () => {
    const initial: Record<string, string> = {};
    for (const [key, value] of Object.entries(signature.params)) {
      initial[key] = displayValue(value);
    }
    setDraft(initial);
    setEditing(true);
  };

  const saveEdit = () =>
    run(async () => {
      if (!outcomeId) throw new Error('no outcome bound to this approval card');
      const params: Record<string, unknown> = {};
      for (const [key, original] of Object.entries(signature.params)) {
        const edited = draft[key];
        params[key] = edited === undefined ? original : parseEdited(edited, original);
      }
      const edited: ActionSignature = { ...signature, params };
      const res = await coreClient.edit(outcomeId, edited, 'Omar');
      setEditing(false);
      setNotice(
        `previous approval invalidated — new signature ${shortHash(res.signatureHash, 12)}`,
      );
    });

  return (
    <div className="approval-card">
      <div className="card-heading">
        <span>approval required — exact action</span>
        {outcome ? <OutcomeStateChip state={outcome.state} /> : null}
      </div>

      <table className="sig-table">
        <tbody>
          <SigRow name="actionType" value={signature.actionType} />
          <SigRow name="target" value={signature.target} />
          {Object.entries(signature.params).map(([key, value]) => (
            <tr key={key}>
              <th scope="row">
                params.<span className="sig-param">{key}</span>
              </th>
              <td>
                {editing ? (
                  <input
                    className="sig-input"
                    value={draft[key] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  />
                ) : (
                  <code>{displayValue(value)}</code>
                )}
              </td>
            </tr>
          ))}
          <SigRow name="pageVersionHash" value={shortHash(signature.pageVersionHash, 16)} mono />
          <tr>
            <th scope="row">disclosures</th>
            <td>
              {signature.disclosures.length === 0 ? (
                <span className="muted">none</span>
              ) : (
                <ul className="disclosure-list">
                  {signature.disclosures.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </td>
          </tr>
          {payload.scopeDescription ? (
            <SigRow name="scope" value={payload.scopeDescription} />
          ) : null}
          <SigRow name="signature" value={shortHash(signatureHash, 12)} mono />
        </tbody>
      </table>

      {notice ? <div className="card-notice">{notice}</div> : null}
      {error ? <div className="card-error">{error}</div> : null}
      {outcome && outcome.state !== 'AwaitingApproval' ? (
        <div className="card-state-note">
          outcome is {outcome.state} — approval controls are inactive
        </div>
      ) : null}

      <div className="card-actions">
        {editing ? (
          <>
            <button className="btn btn-approve" disabled={busy} onClick={() => void saveEdit()}>
              Save edit
            </button>
            <button className="btn" disabled={busy} onClick={() => setEditing(false)}>
              Discard
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-approve"
              disabled={busy || !actionable || !outcomeId}
              onClick={() => outcomeId && void run(() => coreClient.approve(outcomeId, 'Omar'))}
            >
              Approve
            </button>
            <button
              className="btn"
              disabled={busy || !actionable || !outcomeId}
              onClick={startEdit}
            >
              Edit
            </button>
            <button
              className="btn btn-cancel"
              disabled={busy || !actionable || !outcomeId}
              onClick={() =>
                outcomeId && void run(() => coreClient.cancel(outcomeId, 'user cancelled'))
              }
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SigRow(props: { name: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <tr>
      <th scope="row">{props.name}</th>
      <td>{props.mono ? <code>{props.value}</code> : props.value}</td>
    </tr>
  );
}

/** Preserve the original param's type where possible; strings stay strings. */
function parseEdited(edited: string, original: unknown): unknown {
  if (typeof original === 'string' || original === undefined || original === null) return edited;
  try {
    return JSON.parse(edited) as unknown;
  } catch {
    return edited;
  }
}
