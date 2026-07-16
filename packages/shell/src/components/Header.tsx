import type { StateSnapshot } from '../lib/types';
import type { ConnectionStatus } from '../lib/client';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'connecting…',
  connected: 'ws connected',
  reconnecting: 'reconnecting…',
};

export function Header(props: { snapshot: StateSnapshot; status: ConnectionStatus }): JSX.Element {
  const { snapshot, status } = props;
  const activeWatches = snapshot.watches.filter((w) => w.state === 'active').length;
  const openOutcomes = snapshot.outcomes.filter(
    (o) => o.state !== 'Closed' && o.state !== 'Cancelled' && o.state !== 'Superseded',
  ).length;

  return (
    <header className="header">
      <div className="header-brand">
        <span className="header-mark">◆</span>
        <span className="header-title">ANTICIPY</span>
        <span className="header-sub">operator console</span>
      </div>
      <div className="header-counts">
        <Count label="outcomes" value={snapshot.outcomes.length} hint={`${openOutcomes} open`} />
        <Count label="watches" value={snapshot.watches.length} hint={`${activeWatches} active`} />
        <Count label="facts" value={snapshot.facts.length} />
        <Count label="audit" value={snapshot.audit.length} />
      </div>
      <div className={`header-status status-${status}`}>
        <span className="status-dot" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </div>
    </header>
  );
}

function Count(props: { label: string; value: number; hint?: string }): JSX.Element {
  return (
    <span className="header-count" title={props.hint}>
      <span className="header-count-value">{props.value}</span>
      <span className="header-count-label">{props.label}</span>
    </span>
  );
}
