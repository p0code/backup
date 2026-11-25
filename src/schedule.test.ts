import { describe, expect, it } from "vite-plus/test";

import { nextRunAt, type ScheduleState } from "./schedule.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 25, 12);
const state = (patch: Partial<ScheduleState>): ScheduleState => ({
  frequency: "daily",
  lastSuccessAt: null,
  lastAttemptAt: null,
  consecutiveFailures: 0,
  ...patch,
});

describe("schedule", () => {
  it("is off when off", () => {
    expect(nextRunAt(state({ frequency: "off", lastSuccessAt: NOW - DAY }), NOW)).toBeNull();
  });

  it("runs right away when nothing has been backed up", () => {
    expect(nextRunAt(state({}), NOW)).toBe(NOW);
  });

  it("runs one interval after the last success", () => {
    expect(nextRunAt(state({ frequency: "hourly", lastSuccessAt: NOW - 10 * MIN }), NOW)).toBe(
      NOW + 50 * MIN,
    );
    expect(nextRunAt(state({ lastSuccessAt: NOW - HOUR }), NOW)).toBe(NOW + 23 * HOUR);
    expect(nextRunAt(state({ frequency: "weekly", lastSuccessAt: NOW }), NOW)).toBe(NOW + 7 * DAY);
  });

  it("catches up at once after a missed slot", () => {
    expect(nextRunAt(state({ lastSuccessAt: NOW - 3 * DAY }), NOW)).toBe(NOW);
  });

  it("backs off after failures, capped at the interval", () => {
    const failed = (consecutiveFailures: number, frequency: ScheduleState["frequency"] = "daily") =>
      nextRunAt(
        state({ frequency, lastSuccessAt: NOW - 2 * DAY, lastAttemptAt: NOW, consecutiveFailures }),
        NOW,
      );
    expect(failed(1)).toBe(NOW + 5 * MIN);
    expect(failed(2)).toBe(NOW + 10 * MIN);
    expect(failed(4)).toBe(NOW + 40 * MIN);
    expect(failed(20)).toBe(NOW + DAY);
    expect(failed(20, "hourly")).toBe(NOW + HOUR);
  });

  it("keeps the regular slot when a manual backup fails early", () => {
    expect(
      nextRunAt(
        state({ lastSuccessAt: NOW - HOUR, lastAttemptAt: NOW, consecutiveFailures: 1 }),
        NOW,
      ),
    ).toBe(NOW + 23 * HOUR);
  });
});
