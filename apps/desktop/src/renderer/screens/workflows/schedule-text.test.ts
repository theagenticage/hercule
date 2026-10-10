import { describe, expect, it } from "vitest";
import { describeSchedule } from "./schedule-text";

describe("describeSchedule", () => {
  it.each([
    ["*/15 * * * *", "Every 15 minutes"],
    ["*/1 * * * *", "Every minute"],
    ["5 * * * *", "Hourly at :05"],
    ["30 2 * * *", "Daily at 02:30"],
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["0 10 * * 6,0", "Weekends at 10:00"],
    ["0 14 * * 5", "Fridays at 14:00"],
    ["0 4 * * 0", "Sundays at 04:00"],
    ["0 4 * * 7", "Sundays at 04:00"],
    ["0 7 1 * *", "Monthly on the 1st at 07:00"],
    ["0 7 22 * *", "Monthly on the 22nd at 07:00"],
    ["0 7 13 * *", "Monthly on the 13th at 07:00"],
  ])("describes %s as %s", (schedule, text) => {
    expect(describeSchedule({ schedule })).toBe(text);
  });

  it.each(["0 7 1 */3 *", "0 9 * * 1,3", "0 9-17 * * *", "0 7 1 * 1", "@daily", "0 9 * *"])(
    "returns %s as written, because it is not a shape it knows",
    (schedule) => {
      expect(describeSchedule({ schedule })).toBe(schedule);
    },
  );

  it("names the schedule's own timezone, because the time is in that timezone", () => {
    expect(describeSchedule({ schedule: "0 1 * * *", timezone: "Europe/Amsterdam" })).toBe(
      "Daily at 01:00 (Europe/Amsterdam)",
    );
  });
});
