/**
 * PROTOTYPE. The Workflows ticket moves this into `@hercule/client-core`,
 * beside `describeTriggerOn`, which shows a schedule as its cron expression.
 */
import type { Schedule } from "@hercule/contract";

/** The names of the days of the week, by cron's day number: 0 and 7 are Sunday. */
const DAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
  "Sundays",
];

/** Returns the English ordinal of a day of the month: 1st, 2nd, 3rd, 4th, 11th, 21st. */
const formatOrdinal = (day: number): string => {
  const isTeen = day % 100 >= 11 && day % 100 <= 13;
  const suffix = isTeen ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${String(day)}${suffix}`;
};

/** Checks that a cron field is one whole number, such as `5`, and not a list, range or step. */
const isNumber = (field: string): boolean => /^\d+$/.test(field);

/**
 * Describes a five-field cron expression in words, such as "Fridays at 14:00"
 * for `0 14 * * 5`. Knows the shapes people write most:
 *
 * - every n minutes (`*\/15 * * * *`) and hourly (`5 * * * *`);
 * - daily, on weekdays, on weekends, and on one day of the week;
 * - monthly on one day of the month.
 *
 * Returns the expression as written for any other shape, so nothing is ever
 * described wrongly.
 */
const describeCron = (schedule: string): string => {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return schedule;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes !== null && [hour, dayOfMonth, month, dayOfWeek].every((f) => f === "*"))
    return everyMinutes[1] === "1" ? "Every minute" : `Every ${everyMinutes[1]!} minutes`;
  if (!isNumber(minute) || month !== "*") return schedule;
  if (hour === "*")
    return dayOfMonth === "*" && dayOfWeek === "*"
      ? `Hourly at :${minute.padStart(2, "0")}`
      : schedule;
  if (!isNumber(hour)) return schedule;
  const at = `at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dayOfMonth !== "*")
    return isNumber(dayOfMonth) && dayOfWeek === "*"
      ? `Monthly on the ${formatOrdinal(Number(dayOfMonth))} ${at}`
      : schedule;
  if (dayOfWeek === "*") return `Daily ${at}`;
  if (dayOfWeek === "1-5") return `Weekdays ${at}`;
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") return `Weekends ${at}`;
  const day = isNumber(dayOfWeek) ? DAY_NAMES[Number(dayOfWeek)] : undefined;
  return day === undefined ? schedule : `${day} ${at}`;
};

/**
 * Describes a trigger's schedule in words, such as "Fridays at 14:00", and
 * names its timezone after the time when the schedule has one: "Daily at
 * 01:00 (Europe/Amsterdam)". The time is not converted to the user's
 * timezone, because the schedule fires at that time in its own timezone.
 * Returns the cron expression as written when it has no shape the words know.
 */
export const describeSchedule = ({ schedule, timezone }: Schedule): string =>
  timezone === undefined ? describeCron(schedule) : `${describeCron(schedule)} (${timezone})`;
