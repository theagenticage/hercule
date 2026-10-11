import { assert, describe, it } from "vitest";
import { describeCronInWords, describeSchedule } from "./schedule-text";

describe("describeCronInWords", () => {
  it.each([
    ["*/1 * * * *", "Every minute"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["*/30 * * * *", "Every 30 minutes"],
    ["5 * * * *", "Hourly at :05"],
    ["0 1 * * *", "Daily at 01:00"],
    ["30 9 * * 1-5", "Weekdays at 09:30"],
    ["0 10 * * 0,6", "Weekends at 10:00"],
    ["0 10 * * 6,0", "Weekends at 10:00"],
    ["0 14 * * 5", "Fridays at 14:00"],
    ["0 8 * * 0", "Sundays at 08:00"],
    ["0 8 * * 7", "Sundays at 08:00"],
    ["0 7 1 * *", "Monthly on the 1st at 07:00"],
    ["0 7 2 * *", "Monthly on the 2nd at 07:00"],
    ["0 7 11 * *", "Monthly on the 11th at 07:00"],
    ["0 7 23 * *", "Monthly on the 23rd at 07:00"],
    ["  0   1 * * *  ", "Daily at 01:00"],
  ])("describes %s as %s", (cron, words) => {
    assert.strictEqual(describeCronInWords(cron), words);
  });

  // `*/45` fires at :00 and :45, so its runs are not 45 minutes apart.
  it.each([
    "*/45 * * * *",
    "*/7 * * * *",
    "0 7 1 */3 *",
    "0 9 * * 1,3",
    "0 9-17 * * *",
    "0 7 1 * 1",
    "@daily",
    "0 9 * *",
  ])("has no words for %s", (cron) => {
    assert.isUndefined(describeCronInWords(cron));
  });
});

describe("describeSchedule", () => {
  it("describes a schedule in words", () => {
    assert.strictEqual(describeSchedule({ schedule: "0 1 * * *" }), "Daily at 01:00");
  });

  it("follows the words with the schedule's own time zone, without converting the time", () => {
    assert.strictEqual(
      describeSchedule({ schedule: "0 1 * * *", timezone: "Europe/Amsterdam" }),
      "Daily at 01:00 (Europe/Amsterdam)",
    );
  });

  it("shows a schedule with no words as its cron expression", () => {
    assert.strictEqual(
      describeSchedule({ schedule: "0 7 1 */3 *", timezone: "UTC" }),
      "0 7 1 */3 * (UTC)",
    );
  });
});
