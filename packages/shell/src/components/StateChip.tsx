import type { OutcomeState, WatchState } from '../lib/types';

/**
 * Distinct chip color per outcome state — the operator should be able to read the
 * lifecycle at a glance. Classes are defined in styles.css (chip-<state>).
 */
export function OutcomeStateChip(props: { state: OutcomeState }): JSX.Element {
  return <span className={`chip chip-outcome chip-${props.state}`}>{props.state}</span>;
}

export function WatchStateChip(props: { state: WatchState }): JSX.Element {
  return <span className={`chip chip-watch chip-w-${props.state}`}>{props.state}</span>;
}
