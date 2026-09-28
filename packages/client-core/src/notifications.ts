/**
 * How the notification center shows a notification: who produced it, which
 * mark it gets, what each answer of a decision does, how a resolved decision
 * was resolved, and whether its producer is muted. Spec 10 §7 owns the
 * record; spec 14 §Notification center owns the screen.
 */
import type {
  CoreNotificationKind,
  DescribeLine,
  MuteKey,
  Notification,
  NotificationAction,
  NotificationProducer,
  Resolution,
  ResolutionOrigin,
} from "@hercule/contract";
import { toIdTail } from "./id-tail";

/**
 * Returns the label that says who produced a notification. The core is shown
 * as the product, and a plugin by its id, which is also its name.
 */
export const describeProducer = (producer: NotificationProducer): string => {
  switch (producer.type) {
    case "core":
      return "Hercule";
    case "run":
      return "Workflow run";
    case "session":
      return "Session";
    case "plugin":
      return producer.pluginId;
  }
};

/**
 * The mark a notification's row shows:
 *
 * - `decision`: a decision still waiting on the user.
 * - `failed`: the core's report that a run failed.
 * - `done`: a decision that was answered or handled.
 * - `withdrawn`: a decision that stopped existing before anyone answered it.
 * - `none`: any other informational notification.
 */
export type NotificationMark = "decision" | "failed" | "done" | "withdrawn" | "none";

/** The kind of the notification the core creates when a run fails. */
const RUN_FAILED_KIND: CoreNotificationKind = "core.run-failed";

/** Returns the mark for a notification's row. */
export const chooseNotificationMark = (notification: Notification): NotificationMark => {
  if (notification.status === "open") return "decision";
  if (notification.kind === RUN_FAILED_KIND) return "failed";
  if (notification.resolution === undefined) return "none";
  return notification.resolution.kind === "withdrawn" ? "withdrawn" : "done";
};

/**
 * Returns where a decision was answered, as the words after "decided": "in the
 * web app", "through the API" for a client with an API key such as the CLI,
 * "in a chat channel", "in session 7c82ebeb", "in the gmail plugin", or "by
 * Hercule" for the core. A chat channel is not named, because the resolution
 * holds only the Connection's id.
 */
const describeOrigin = (origin: ResolutionOrigin): string => {
  if (origin === "web") return "in the web app";
  if (origin === "api") return "through the API";
  if (origin.startsWith("connection:")) return "in a chat channel";
  if (origin.startsWith("session:"))
    return `in session ${toIdTail(origin.slice("session:".length))}`;
  if (origin.startsWith("plugin:")) return `in the ${origin.slice("plugin:".length)} plugin`;
  return "by Hercule";
};

/**
 * Returns the line a resolved decision shows under its title: "decided in the
 * web app", "handled by an assistant", or "withdrawn: token refreshed". The
 * record does not name the assistant or its channel, so a handled decision
 * says only that an assistant covered it.
 */
export const describeResolution = (resolution: Resolution): string => {
  switch (resolution.kind) {
    case "decided":
      return `decided ${describeOrigin(resolution.origin)}`;
    case "handled":
      return "handled by an assistant";
    case "withdrawn":
      return resolution.reason === undefined ? "withdrawn" : `withdrawn: ${resolution.reason}`;
  }
};

/**
 * One answer of a decision as the answer ledger shows it (spec 14 §Answers as
 * a ledger): the label, what taking the answer does, and the producer's
 * description of it.
 */
export interface BoundActionRow {
  /** The answer's id, which `notification.act` takes. */
  readonly id: string;
  readonly label: string;
  /** Whether this is the decision's primary answer, which the ledger sets apart. */
  readonly primary: boolean;
  /**
   * What taking the answer does, as the core wrote it, with the names of the
   * entities it acts on marked. Empty when the core sent none, which it does
   * only for a resolved decision.
   */
  readonly describeLine: DescribeLine;
  /** Whether the answer runs nothing. Its describe line then reads "Does nothing". */
  readonly runsNothing: boolean;
  /** The producer's description of the answer, when it wrote one. */
  readonly description: string | undefined;
}

/** Builds the ledger rows of a decision's answers, in the order the producer gave them. */
export const buildBoundActionRows = (
  actions: ReadonlyArray<NotificationAction>,
): ReadonlyArray<BoundActionRow> =>
  actions.map((action) => ({
    id: action.id,
    label: action.label,
    primary: action.primary === true,
    describeLine: action.describeLine ?? [],
    runsNothing: action.operation === null,
    description: action.description,
  }));

/**
 * Formats a describe line as plain text, such as "Start a run of «Bugfix»",
 * for a place that cannot set names apart by style, such as a terminal. Each
 * name is quoted in guillemets. Names are written by whoever named the
 * entity, often an agent, so without the marks a name such as "ok to session
 * Chat" would read as part of the core's own words. The core writes the
 * spaces between parts into the text parts, so the parts are joined as they
 * are.
 */
export const formatDescribeLine = (line: DescribeLine): string =>
  line.map((part) => (part.kind === "name" ? `«${part.text}»` : part.text)).join("");

/** The kind of producer a mute key names. */
export type MuteKind = "workflow" | "plugin" | "assistant";

/**
 * Parses the kind of producer out of a mute key: the part before the first
 * colon. The contract only accepts keys that start with one of the three
 * kinds, so the part before the colon is always one of them.
 */
export const parseMuteKind = (key: MuteKey): MuteKind => key.slice(0, key.indexOf(":")) as MuteKind;

/** Checks whether a notification's producer is in the user's mute list. */
export const isNotificationMuted = (
  notification: Notification,
  muted: ReadonlyArray<MuteKey>,
): boolean => notification.muteKey !== undefined && muted.includes(notification.muteKey);

/**
 * Returns the mute list with `key` removed when it is in the list, or added at
 * the end when it is not. The settings store takes the whole list, so a toggle
 * writes the list this returns.
 */
export const toggleMuteKey = (muted: ReadonlyArray<MuteKey>, key: MuteKey): MuteKey[] =>
  muted.includes(key) ? muted.filter((kept) => kept !== key) : [...muted, key];

/** The largest count the sidebar shows as a number; above it, the count reads "99+". */
const MAX_SHOWN_COUNT = 99;

/**
 * How many notifications the sidebar reads to count the new ones: one more
 * than the largest count it shows as a number, so it can tell 99 from more.
 */
export const UNSEEN_COUNT_READ_LIMIT = MAX_SHOWN_COUNT + 1;

/**
 * Formats the sidebar's count of new notifications: `undefined` for none, so
 * no count shows, "99+" above 99, and the number otherwise.
 */
export const formatUnseenCount = (count: number): string | undefined => {
  if (count === 0) return undefined;
  return count > MAX_SHOWN_COUNT ? `${MAX_SHOWN_COUNT}+` : String(count);
};
