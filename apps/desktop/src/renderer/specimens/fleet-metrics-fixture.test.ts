/**
 * Tests that the Fleet specimen's Runner Metrics tell atlas's story: the
 * graphs of its page and the forecast of its disk are drawn from them, and
 * the goldens depend on each part being there.
 */
import { describe, expect, it } from "vitest";
import { forecastDiskLimit } from "@hercule/client-core/fleet";
import { describeMachineGraphs } from "@hercule/client-core/machine-graphs";
import { ATLAS, BEELINK, BOSGAME, FLEET_RECORDS, MINI, STUDIO } from "./fleet-fixture";
import { SPECIMEN_NOW } from "./sidebar-fixture";

const { fiveMinutesByRunner, hoursByRunner, fleetHours } = FLEET_RECORDS.metrics;
const fiveMinutes = fiveMinutesByRunner[ATLAS.id]!;
const hours = hoursByRunner[ATLAS.id]!;

describe("the Fleet specimen's Runner Metrics", () => {
  it("hold 24 hours of five-minute points and 14 days of hour points, with one gap of about an hour", () => {
    const starts = fiveMinutes.points.map((point) => Date.parse(point.at));
    const gaps = starts.flatMap((start, index) =>
      index > 0 && start - starts[index - 1]! > 5 * 60_000 ? [start - starts[index - 1]!] : [],
    );

    expect(starts[0]).toBeGreaterThanOrEqual(SPECIMEN_NOW - 24 * 3_600_000);
    expect(gaps).toEqual([65 * 60_000]);
    expect(hours.points.length).toBeGreaterThan(14 * 24 - 3);
    expect(fiveMinutes.readAt).toBe(SPECIMEN_NOW);
  });

  it("show atlas waiting for slots in the afternoon, and its disk reaching the limit in 12 days", () => {
    const graphs = describeMachineGraphs(
      ATLAS,
      fiveMinutes,
      hours,
      forecastDiskLimit(fleetHours.points, ATLAS, SPECIMEN_NOW),
    );

    expect(graphs.sessions.waiting.length).toBe(2);
    expect(graphs.sessions.running.length).toBe(2);
    expect(graphs.disk).toMatchObject({
      kind: "drawn",
      forecastText: "Reaches its limit in about 12 days",
    });
  });

  it("give no other machine a forecast", () => {
    for (const runner of [BEELINK, BOSGAME, MINI, STUDIO]) {
      expect(forecastDiskLimit(fleetHours.points, runner, SPECIMEN_NOW), runner.name).toBeNull();
    }
  });
});
