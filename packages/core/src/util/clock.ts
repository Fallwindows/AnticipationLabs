/**
 * All time reads in the system go through Clock (DECISIONS D-008). Watch tests and
 * scenario fixtures use TestClock so follow-up windows and timeouts are deterministic.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class TestClock implements Clock {
  private current: number;

  constructor(start: Date | string | number = '2026-07-16T09:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }

  advanceHours(hours: number): void {
    this.advance(hours * 3_600_000);
  }

  advanceDays(days: number): void {
    this.advance(days * 86_400_000);
  }

  set(to: Date | string): void {
    const t = new Date(to).getTime();
    if (t < this.current) {
      throw new Error('TestClock cannot move backwards');
    }
    this.current = t;
  }
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
