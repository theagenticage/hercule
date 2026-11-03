/**
 * Tests that the Fleet specimen's Runner Metrics tell atlas's story: the
 * graphs of its page are drawn from its five-minute points and the forecast of
 * its disk on the Fleet page from the hour points of every machine, and the
 * goldens depend on each part being there.
 */
import { describe, expect, it } from "vitest";
import { forecastDiskLimit } from "@hercule/client-core/fleet";
import { describeMachineGraphs } from "@hercule/client-core/machine-graphs";
import { ATLAS, BEELINK, BOSGAME, FLEET_RECORDS, MINI, STUDIO } from "./fleet-fixture";
import { SPECIMEN_NOW } from "./sidebar-fixture";

const { fiveMinutesByRunner, fleetHours } = FLEET_RECORDS.metrics;
const fiveMinutes = fiveMinutesByRunner[ATLAS.id]!;
const pickHourPoints = (runnerId: string) =>
  fleetHours.points.filter((point) => point.runnerId === runnerId);

describe("the Fleet specimen's Runner Metrics", () => {
  it("hold 24 hours of five-minute points and 7 days of hour points, with one gap of about an hour", () => {
    const starts = fiveMinutes.points.map((point) => Date.parse(point.at));
    const gaps = starts.flatMap((start, index) =>
      index > 0 && start - starts[index - 1]! > 5 * 60_000 ? [start - starts[index - 1]!] : [],
    );

    expect(starts[0]).toBeGreaterThanOrEqual(SPECIMEN_NOW - 24 * 3_600_000);
    expect(gaps).toEqual([65 * 60_000]);
    expect(pickHourPoints(ATLAS.id).length).toBeGreaterThan(7 * 24 - 3);
    expect(fiveMinutes.readAt).toBe(SPECIMEN_NOW);
  });

  it("show atlas waiting for slots in the afternoon", () => {
    const graphs = describeMachineGraphs(ATLAS, fiveMinutes);

    expect(graphs.sessions.waiting.length).toBe(2);
    expect(graphs.sessions.running.length).toBe(2);
  });

  it("forecast atlas's disk reaching the limit in 12 days and give no other machine a forecast", () => {
    expect(forecastDiskLimit(pickHourPoints(ATLAS.id), ATLAS, SPECIMEN_NOW)).toMatchObject({
      days: 12,
    });
    for (const runner of [BEELINK, BOSGAME, MINI, STUDIO]) {
      expect(
        forecastDiskLimit(pickHourPoints(runner.id), runner, SPECIMEN_NOW),
        runner.name,
      ).toBeNull();
    }
  });
});
