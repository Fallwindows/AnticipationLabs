import { useState } from 'react';
import type { StateSnapshot } from '../lib/types';
import { OutcomesTab } from './OutcomesTab';
import { MemoryTab } from './MemoryTab';
import { WatchesTab } from './WatchesTab';
import { AuditTab } from './AuditTab';

type TabId = 'outcomes' | 'memory' | 'watches' | 'audit';

const TABS: { id: TabId; label: string }[] = [
  { id: 'outcomes', label: 'Outcomes' },
  { id: 'memory', label: 'Memory' },
  { id: 'watches', label: 'Watches' },
  { id: 'audit', label: 'Audit' },
];

export function Inspector(props: { snapshot: StateSnapshot }): JSX.Element {
  const { snapshot } = props;
  const [active, setActive] = useState<TabId>('outcomes');

  const counts: Record<TabId, number> = {
    outcomes: snapshot.outcomes.length,
    memory: snapshot.facts.length,
    watches: snapshot.watches.length,
    audit: snapshot.audit.length,
  };

  return (
    <div className="inspector">
      <div className="tab-bar" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active === tab.id}
            className={`tab${active === tab.id ? ' tab-active' : ''}`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
            <span className="tab-count">{counts[tab.id]}</span>
          </button>
        ))}
      </div>
      <div className="tab-content">
        {active === 'outcomes' ? <OutcomesTab snapshot={snapshot} /> : null}
        {active === 'memory' ? <MemoryTab snapshot={snapshot} /> : null}
        {active === 'watches' ? <WatchesTab snapshot={snapshot} /> : null}
        {active === 'audit' ? <AuditTab snapshot={snapshot} /> : null}
      </div>
    </div>
  );
}
