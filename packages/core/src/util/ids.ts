import { randomUUID } from 'node:crypto';

/**
 * All ID generation goes through IdSource (DECISIONS D-008) so fixtures produce
 * byte-stable output.
 */
export interface IdSource {
  next(prefix: string): string;
}

export class RandomIdSource implements IdSource {
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}

export class SequentialIdSource implements IdSource {
  private counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, '0')}`;
  }
}
