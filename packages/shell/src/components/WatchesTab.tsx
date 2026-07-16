import { fmtDateTime, fmtMs } from '../lib/format';
import type { StateSnapshot, Watch } from '../lib/types';
import { WatchStateChip } from './StateChip';

export function WatchesTab(props: { snapshot: StateSnapshot }): JSX.Element {
  const { snapshot } = props;
  if (snapshot.watches.length === 0) {
    return <div className="tab-empty">No watches — nothing is being tracked to ground truth.</div>;
  }
  return (
    <div className="card-list">
      {snapshot.watches.map((watch) => (
        <WatchCard key={watch.id} watch={watch} />
      ))}
    </div>
  );
}

function WatchCard(props: { watch: Watch }): JSX.Element {
  const { watch } = props;
  return (
    <div className="watch-card">
      <div className="watch-head">
        <span className={`watch-kind wk-${watch.kind}`}>{watch.kind}</span>
        <span className="watch-desc">{watch.description}</span>
        <WatchStateChip state={watch.state} />
      </div>
      <dl className="kv">
        <dt>outcome</dt>
        <dd className="mono">{watch.outcomeId}</dd>
        <dt>next poll</dt>
        <dd className="mono">{fmtDateTime(watch.nextPollAt)}</dd>
        <dt>interval</dt>
        <dd className="mono">every {fmtMs(watch.pollPolicy.intervalMs)}</dd>
        <dt>follow-ups</dt>
        <dd>
          {watch.followUpPolicy ? (
            <>
              used {watch.followUpsSentInWindow} of 1 this window
              <span className="muted"> · window {fmtMs(watch.followUpPolicy.windowMs)}</span>
              <span className="muted"> · action: {watch.followUpPolicy.action}</span>
            </>
          ) : (
            <span className="muted">no follow-up policy</span>
          )}
        </dd>
        <dt>timeout</dt>
        <dd className="mono">{watch.timeoutAt ? fmtDateTime(watch.timeoutAt) : '—'}</dd>
        <dt>closes when</dt>
        <dd>{watch.closeCondition.description}</dd>
        {watch.lastPolledAt ? (
          <>
            <dt>last polled</dt>
            <dd className="mono">{fmtDateTime(watch.lastPolledAt)}</dd>
          </>
        ) : null}
      </dl>
      {watch.lastPollResult ? (
        <details className="poll-result">
          <summary>last poll result</summary>
          <pre className="mono json-block">{JSON.stringify(watch.lastPollResult, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
