import { useState } from 'react';
import { fmtDateTime, shortHash } from '../lib/format';
import type { ApprovalToken, Outcome, StateSnapshot } from '../lib/types';
import { OutcomeStateChip } from './StateChip';

export function OutcomesTab(props: { snapshot: StateSnapshot }): JSX.Element {
  const { snapshot } = props;
  if (snapshot.outcomes.length === 0) {
    return <div className="tab-empty">No outcomes yet — Anticipy has not discovered anything to own.</div>;
  }
  return (
    <div className="card-list">
      {snapshot.outcomes.map((outcome) => (
        <OutcomeCard
          key={outcome.id}
          outcome={outcome}
          token={snapshot.approvals.find((t) => t.id === outcome.approvalTokenId)}
        />
      ))}
    </div>
  );
}

function OutcomeCard(props: { outcome: Outcome; token: ApprovalToken | undefined }): JSX.Element {
  const { outcome, token } = props;
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div className="outcome-card">
      <div className="outcome-head">
        <span className="outcome-title">{outcome.title}</span>
        <OutcomeStateChip state={outcome.state} />
      </div>
      <div className="outcome-id mono">{outcome.id}</div>

      <dl className="kv">
        <dt>owner</dt>
        <dd>
          {outcome.owner}
          {outcome.beneficiary ? (
            <span className="muted"> — for {outcome.beneficiary}</span>
          ) : null}
        </dd>
        <dt>goal</dt>
        <dd>{outcome.interpretedGoal}</dd>
        <dt>origin</dt>
        <dd>
          <span className={`origin origin-${outcome.originClassification}`}>
            {outcome.originClassification}
          </span>
        </dd>
        {outcome.supersededBy ? (
          <>
            <dt>superseded by</dt>
            <dd className="mono">{outcome.supersededBy}</dd>
          </>
        ) : null}
        {outcome.cancelReason ? (
          <>
            <dt>cancel reason</dt>
            <dd>{outcome.cancelReason}</dd>
          </>
        ) : null}
        {outcome.dormantReason ? (
          <>
            <dt>dormant</dt>
            <dd>{outcome.dormantReason}</dd>
          </>
        ) : null}
      </dl>

      {outcome.constraints.length > 0 ? (
        <div className="constraints">
          <div className="section-label">constraints</div>
          <ul>
            {outcome.constraints.map((c, i) => (
              <li key={i}>
                <span className={`constraint-kind ck-${c.kind}`}>{c.kind}</span> {c.description}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {token || outcome.preparedSignatureHash ? (
        <div className="token-box">
          <div className="section-label">approval binding</div>
          {token ? (
            <div className="token-line mono">
              token {shortHash(token.id, 12)} · sig {shortHash(token.signatureHash, 12)}
              {token.consumedAt ? ' · consumed' : ''}
              {token.invalidatedAt ? ` · INVALIDATED (${token.invalidationReason ?? '—'})` : ''}
            </div>
          ) : null}
          {token?.scope.description ? (
            <div className="token-scope">scope: {token.scope.description}</div>
          ) : null}
          {!token && outcome.preparedSignatureHash ? (
            <div className="token-line mono">
              prepared sig {shortHash(outcome.preparedSignatureHash, 12)} (no token bound)
            </div>
          ) : null}
        </div>
      ) : null}

      <button className="link-btn" onClick={() => setShowHistory((s) => !s)}>
        {showHistory ? '▾ hide' : '▸ show'} state history ({outcome.history.length})
      </button>
      {showHistory ? (
        <ol className="history">
          {outcome.history.map((t, i) => (
            <li key={i} className="history-item">
              <span className="mono history-when">{fmtDateTime(t.at)}</span>
              <span className="history-edge">
                {t.from ?? '∅'} <span className="history-arrow">→</span> {t.to}
              </span>
              {t.reason ? <span className="history-reason">{t.reason}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
