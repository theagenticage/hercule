/**
 * Describes a cron trigger's schedule in words, such as "Fridays at 14:00",
 * for the screens that say what starts a workflow. `describeTriggerOn` shows
 * the same schedule as its cron expression, for the screens that show it in
 * full.
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
 * Returns `undefined` for any other shape, so nothing is ever described
 * wrongly: the caller shows the expression as written instead.
 */
export const describeCronInWords = (cron: string): string | undefined => {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes !== null && [hour, dayOfMonth, month, dayOfWeek].every((f) => f === "*")) {
    return everyMinutes[1] === "1" ? "Every minute" : `Every ${everyMinutes[1]!} minutes`;
  }
  if (!isNumber(minute) || month !== "*") return undefined;
  if (hour === "*") {
    return dayOfMonth === "*" && dayOfWeek === "*"
      ? `Hourly at :${minute.padStart(2, "0")}`
      : undefined;
  }
  if (!isNumber(hour)) return undefined;
  const at = `at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dayOfMonth !== "*") {
    return isNumber(dayOfMonth) && dayOfWeek === "*"
      ? `Monthly on the ${formatOrdinal(Number(dayOfMonth))} ${at}`
      : undefined;
  }
  if (dayOfWeek === "*") return `Daily ${at}`;
  if (dayOfWeek === "1-5") return `Weekdays ${at}`;
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") return `Weekends ${at}`;
  const day = isNumber(dayOfWeek) ? DAY_NAMES[Number(dayOfWeek)] : undefined;
  return day === undefined ? undefined : `${day} ${at}`;
};

/**
 * Describes a trigger's schedule in words, such as "Fridays at 14:00", or as
 * its cron expression when `describeCronInWords` has no words for it. When the
 * schedule has a time zone of its own, the zone follows: "Daily at 01:00
 * (Europe/Amsterdam)". The time is not converted to the user's timezone,
 * because the schedule fires at that time in its own zone.
 */
export const describeSchedule = ({ schedule, timezone }: Schedule): string => {
  const text = describeCronInWords(schedule) ?? schedule;
  return timezone === undefined ? text : `${text} (${timezone})`;
};
