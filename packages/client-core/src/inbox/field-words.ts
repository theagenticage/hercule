/**
 * The words of one face field of a thing, shared by the Inbox row and the
 * card under a message, so the two never draw a field differently.
 */
import type { EntityFieldValue } from "@hercule/contract";
import { measureSpan } from "./card-wait";

/** Returns a number as the row writes it: "950", "1.2k", "34k", "1.5M". */
export const formatCompactNumber = (value: number): string => {
  if (Math.abs(value) < 1000) return String(value);
  const scaled = (value / (Math.abs(value) < 1e6 ? 1000 : 1e6)).toFixed(
    Math.abs(value) < 10_000 || Math.abs(value) >= 1e6 ? 1 : 0,
  );
  return `${scaled.replace(/\.0$/, "")}${Math.abs(value) < 1e6 ? "k" : "M"}`;
};

/** Returns a number written whole, as the card writes it: "1,211". */
export const formatWholeNumber = (value: number): string => value.toLocaleString("en-GB");

const currencyFormats = new Map<string, Intl.NumberFormat>();

/** Returns an amount in its currency, such as "£1,200.00". Builds each currency's formatter once, because building one is slow and a list formats many rows. */
const formatMoney = (amount: number, currency: string): string => {
  let format = currencyFormats.get(currency);
  if (format === undefined) {
    format = new Intl.NumberFormat("en-GB", { style: "currency", currency });
    currencyFormats.set(currency, format);
  }
  return format.format(amount);
};

/**
 * Returns what a field value says in one short phrase, or `undefined` when it
 * says nothing: a `false` flag, or text with no characters. A number comes
 * with its label ("1.2k events") written by `formatNumber`, a flag is its
 * label, an age is its time ("3d").
 *
 * An age changes with the clock, so it has words only when `now` is given. A
 * card has no timer to redraw it, and passes no `now`.
 */
export const readFieldWords = (
  field: EntityFieldValue | undefined,
  formatNumber: (value: number) => string,
  now?: Date,
): string | undefined => {
  if (field === undefined) return undefined;
  switch (field.type) {
    case "text":
    case "person":
    case "enum":
      return field.text === "" ? undefined : field.text;
    case "number":
      return `${formatNumber(field.number)} ${field.label.toLowerCase()}`;
    case "money":
      return formatMoney(field.amount, field.currency);
    case "age":
      return now === undefined ? undefined : measureSpan(field.since, now).text;
    case "bool":
      return field.value ? field.label : undefined;
  }
};
