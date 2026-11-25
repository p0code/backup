/** When the next scheduled backup runs, from the last success and any failures since. */

export type Frequency = "off" | "hourly" | "daily" | "weekly";

const HOUR = 60 * 60 * 1000;
export const FREQUENCY_MS: Record<Exclude<Frequency, "off">, number> = {
  hourly: HOUR,
  daily: 24 * HOUR,
  weekly: 7 * 24 * HOUR,
};
const FIRST_RETRY_MS = 5 * 60 * 1000;

export interface ScheduleState {
  readonly frequency: Frequency;
  /** Epoch ms of the last backup that uploaded, or null if none has. */
  readonly lastSuccessAt: number | null;
  /** Epoch ms of the last attempt, successful or not. */
  readonly lastAttemptAt: number | null;
  /** Failed attempts since the last success. */
  readonly consecutiveFailures: number;
}

/**
 * Epoch ms of the next run, never before `now`; null when scheduling is off.
 * A backup is due one interval after the last success, so a machine that slept through
 * its slot backs up as soon as it wakes. Failures retry after 5, 10, 20… minutes,
 * never waiting longer than the interval itself.
 */
export function nextRunAt(state: ScheduleState, now: number): number | null {
  if (state.frequency === "off") return null;
  const interval = FREQUENCY_MS[state.frequency];
  let next = state.lastSuccessAt === null ? now : state.lastSuccessAt + interval;
  if (state.consecutiveFailures > 0 && state.lastAttemptAt !== null) {
    const backoff = Math.min(interval, FIRST_RETRY_MS * 2 ** (state.consecutiveFailures - 1));
    next = Math.max(next, state.lastAttemptAt + backoff);
  }
  return Math.max(now, next);
}
