/**
 * What the Initiative sheet works out: the values its fields start with, the
 * hue a new Initiative takes, the payloads it sends, and how the list of open
 * Initiatives changes when one is saved, closed or deleted.
 */
import {
  INITIATIVE_HUES,
  type Initiative,
  type InitiativeCreateInput,
  type InitiativeHue,
  type InitiativeUpdateInput,
} from "@hercule/contract";

/** What the fields of the Initiative sheet hold. */
export interface InitiativeDraft {
  readonly name: string;
  readonly intent: string;
  /** What finished looks like, or an empty string for no target. */
  readonly target: string;
  /** The target date as `YYYY-MM-DD` in the user's time zone, which is what a date field holds, or an empty string for none. */
  readonly targetDay: string;
  /** The Project whose lane the Initiative draws in, or `null` for No project. */
  readonly projectId: string | null;
  readonly hue: InitiativeHue;
}

/**
 * The name of each colour of an Initiative, for a screen reader and a hover.
 * Each name was chosen by looking at the colour at the lightness and chroma
 * of the dark themes and of the light ones, so it is the colour a person
 * would call it. A new hue in `INITIATIVE_HUES` needs a name here: the type
 * refuses a record without one.
 */
export const INITIATIVE_HUE_NAMES: Readonly<Record<InitiativeHue, string>> = {
  245: "Blue",
  150: "Green",
  300: "Violet",
  200: "Teal",
  345: "Rose",
  118: "Olive",
  270: "Indigo",
  175: "Jade",
  325: "Orchid",
  222: "Sky",
  135: "Leaf",
  100: "Gold",
};

/** Matches the text of a date field. */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Returns the hue that the fewest of `openInitiatives` use. On a tie it
 * returns the first of those in `INITIATIVE_HUES`. The controller picks a hue
 * by the same rule when a create names none, so the sheet can show the colour
 * the Initiative will get.
 */
export const chooseNewInitiativeHue = (
  openInitiatives: readonly Pick<Initiative, "hue">[],
): InitiativeHue => {
  const uses = new Map<number, number>();
  for (const { hue } of openInitiatives) uses.set(hue, (uses.get(hue) ?? 0) + 1);
  let chosen: InitiativeHue = INITIATIVE_HUES[0];
  for (const hue of INITIATIVE_HUES) {
    if ((uses.get(hue) ?? 0) < (uses.get(chosen) ?? 0)) chosen = hue;
  }
  return chosen;
};

/**
 * Converts a date field's text, such as `2026-03-14`, to the `Timestamp` of
 * the start of that day in the user's time zone. Returns `undefined` for an
 * empty or malformed text, which is what a date field holds while it is
 * incomplete.
 */
export const convertDayToTimestamp = (day: string): string | undefined => {
  const parts = DAY_PATTERN.exec(day);
  if (parts === null) return undefined;
  const [, year, month, date] = parts;
  const start = new Date(Number(year), Number(month) - 1, Number(date));
  return Number.isNaN(start.getTime()) ? undefined : start.toISOString();
};

/**
 * Converts a `Timestamp` to the date field's text: the day it falls on in
 * the user's time zone. The inverse of `convertDayToTimestamp`, for a
 * timestamp that one made.
 */
export const readTimestampDay = (timestamp: string): string => {
  const moment = new Date(timestamp);
  const month = String(moment.getMonth() + 1).padStart(2, "0");
  const date = String(moment.getDate()).padStart(2, "0");
  return `${String(moment.getFullYear()).padStart(4, "0")}-${month}-${date}`;
};

/**
 * Returns the fields of a new Initiative: no text, the hue `chooseNewInitiativeHue`
 * picks, and the Project `projectId` when it is one of `projects` (the lane
 * the sheet was opened from), else none.
 */
export const buildNewInitiativeDraft = (
  openInitiatives: readonly Pick<Initiative, "hue">[],
  projects: readonly { readonly id: string }[],
  projectId: string | null,
): InitiativeDraft => ({
  name: "",
  intent: "",
  target: "",
  targetDay: "",
  projectId: projects.some((project) => project.id === projectId) ? projectId : null,
  hue: chooseNewInitiativeHue(openInitiatives),
});

/**
 * Returns the fields `initiative` has now. A Project that is no longer in
 * `projects` reads as no Project, as Work draws it in the No project lane.
 */
export const buildInitiativeDraft = (
  initiative: Initiative,
  projects: readonly { readonly id: string }[],
): InitiativeDraft => ({
  name: initiative.name,
  intent: initiative.intent,
  target: initiative.target ?? "",
  targetDay: initiative.targetDate === undefined ? "" : readTimestampDay(initiative.targetDate),
  projectId: projects.some((project) => project.id === initiative.projectId)
    ? (initiative.projectId ?? null)
    : null,
  hue: initiative.hue,
});

/**
 * Returns the payload of `initiative.create` for `draft`: the texts trimmed,
 * and a field with nothing in it left out. The hue is always sent, so the
 * Initiative takes the colour the sheet showed.
 */
export const buildInitiativeCreateInput = (draft: InitiativeDraft): InitiativeCreateInput => {
  const intent = draft.intent.trim();
  const target = draft.target.trim();
  const targetDate = convertDayToTimestamp(draft.targetDay);
  return {
    name: draft.name.trim(),
    ...(intent === "" ? {} : { intent }),
    ...(target === "" ? {} : { target }),
    ...(targetDate === undefined ? {} : { targetDate }),
    ...(draft.projectId === null ? {} : { projectId: draft.projectId }),
    hue: draft.hue,
  };
};

/**
 * Returns the payload of `initiative.update` that turns `initiative` into
 * `draft`, or `null` when nothing changed, because the controller refuses an
 * update with no field.
 *
 * - Only the fields the user changed go in. An untouched target date is not
 *   written again, so a date set with a time of day keeps it.
 * - An emptied target, target date or Project goes as `null`, which removes it.
 * - `projects` decides what the Project field showed (see `buildInitiativeDraft`).
 */
export const buildInitiativeUpdateInput = (
  initiative: Initiative,
  draft: InitiativeDraft,
  projects: readonly { readonly id: string }[],
): InitiativeUpdateInput | null => {
  const before = buildInitiativeDraft(initiative, projects);
  const name = draft.name.trim();
  const intent = draft.intent.trim();
  const target = draft.target.trim();
  const targetDate = convertDayToTimestamp(draft.targetDay);
  const update: InitiativeUpdateInput = {
    ...(name === before.name ? {} : { name }),
    ...(intent === before.intent ? {} : { intent }),
    ...(target === before.target ? {} : { target: target === "" ? null : target }),
    ...(draft.targetDay === before.targetDay
      ? {}
      : { targetDate: targetDate === undefined ? null : targetDate }),
    ...(draft.projectId === before.projectId ? {} : { projectId: draft.projectId }),
    ...(draft.hue === before.hue ? {} : { hue: draft.hue }),
  };
  return Object.keys(update).length === 0 ? null : update;
};

/**
 * Returns the list of open Initiatives after `saved` was written. A closed
 * `saved` leaves the list. An open one takes the place of the one with its id,
 * or joins the list in creation order (`createdAt`, then `id`), which is the
 * order the controller reads them in.
 */
export const putInitiative = (
  list: readonly Initiative[],
  saved: Initiative,
): readonly Initiative[] => {
  const others = list.filter((each) => each.id !== saved.id);
  if (saved.closedAt !== undefined) return others;
  if (others.length < list.length) return list.map((each) => (each.id === saved.id ? saved : each));
  const after = others.findIndex(
    (each) =>
      each.createdAt > saved.createdAt ||
      (each.createdAt === saved.createdAt && each.id > saved.id),
  );
  return after < 0
    ? [...others, saved]
    : [...others.slice(0, after), saved, ...others.slice(after)];
};
