/**
 * Client-side rules that only the Connections screens use: how a
 * Connection's health and setup read, which other setup flows a form offers,
 * when an OAuth setup has finished, and how the configure form reads and
 * saves topics, feed intervals and the controller's validation errors.
 *
 * They live apart from `connections.ts` because the app's first screen
 * imports `connections.ts` (for `connectionNeedsAttention`), and the bundler
 * loads a module the first screen imports whole, minus only the exports
 * nothing in the app uses. This module loads only with the screens that use it.
 */
import type { ConfigChoice, Connection } from "@hercule/contract";
import { listIssuesInGroup, matchConfigIssues, type ConfigIssues } from "./config-fields";
import {
  listCredentialFields,
  listSetupFlows,
  showsPluginName,
  type ConnectionFeed,
  type ConnectionType,
  type SetupFlow,
} from "./connection-types";
import { readErrorMessage, readValidationIssues } from "./errors";
import { parseWholeNumber } from "./whole-number";

/**
 * Topics a form suggests for a Connection. They are suggestions, not a closed
 * list: a topic is an ordinary label, so the user can type any other topic.
 */
export const SUGGESTED_TOPICS: ReadonlyArray<string> = ["Code", "Business", "Personal", "Ops"];

/**
 * How a screen shows a Connection's health: the words, and whether they are
 * drawn as a failure.
 */
export interface ConnectionHealth {
  readonly text: string;
  readonly failing: boolean;
}

/**
 * Returns how a screen shows the Connection's health. Only an `error` is
 * drawn as a failure, and its words are the controller's `statusDetail`,
 * because that says what went wrong; "error" stands in when the controller
 * gave no detail.
 */
export const describeConnectionHealth = (
  connection: Pick<Connection, "status" | "statusDetail">,
): ConnectionHealth => {
  switch (connection.status) {
    case "connected":
      return { text: "healthy", failing: false };
    case "needs-reauth":
      return { text: "needs sign-in", failing: false };
    case "disabled":
      return { text: "disabled", failing: false };
    case "error":
      return { text: connection.statusDetail?.trim() || "error", failing: true };
  }
};

/**
 * Returns the name a screen shows for the Connection's type: the type's
 * display name, such as "GitHub", or the raw type string, such as
 * `github/github`, when `type` is undefined because no plugin in the list
 * declares it any more.
 */
export const describeConnectionTypeName = (
  connection: Connection,
  type: ConnectionType | undefined,
): string => type?.displayName ?? connection.type;

/**
 * Returns a short description of one setup flow, short enough for a row, such
 * as "sign in with GitHub".
 */
export const describeSetupFlow = (flow: SetupFlow, type: ConnectionType): string => {
  switch (flow) {
    case "device":
    case "oauth":
      return `sign in with ${type.displayName}`;
    case "credentials":
      return describeCredentialsSetup(type);
    case "pairing":
      return "pair a chat account";
  }
};

/**
 * Returns the secondary line under a connection type's name: the plugin that
 * declares it, then what setting it up takes, such as "sign in with GitHub or
 * paste a token". The plugin comes first because two plugins may each declare
 * a type called Gmail, and the name above does not show which one this is.
 * A plugin named like its type is left out, because it would repeat the name.
 */
export const summarizeConnectionType = (type: ConnectionType): string => {
  // A device flow and a redirect flow read the same in a row, so one is enough.
  const descriptions = new Set(listSetupFlows(type).map((flow) => describeSetupFlow(flow, type)));
  // For a setup this build cannot show, the type's id stands in for a
  // description that may be wrong.
  const summary = descriptions.size === 0 ? type.type : [...descriptions].join(" or ");
  return showsPluginName(type) ? `${type.pluginName} · ${summary}` : summary;
};

/** One button that switches a setup form to another flow. */
export interface FlowSwitch {
  readonly flow: SetupFlow;
  readonly label: string;
}

/**
 * Returns the label's text as it reads in the middle of a sentence: the first
 * letter in lower case, unless the first word is an acronym such as "API".
 */
const lowerFirstWord = (label: string): string =>
  /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);

/**
 * Returns what the credentials flow asks of the user, worded for the middle
 * of a sentence, from the fields that flow asks for:
 *
 * - one token field: "paste a token";
 * - one other field: "enter your API key";
 * - several fields, or none: "enter credentials".
 */
const describeCredentialsSetup = (type: ConnectionType): string => {
  const fields = listCredentialFields(type);
  const [field] = fields;
  if (fields.length !== 1 || field === undefined) return "enter credentials";
  return /\btoken\b/i.test(field.label)
    ? "paste a token"
    : `enter your ${lowerFirstWord(field.label)}`;
};

/**
 * Returns the buttons a setup form shows to switch from the `current` flow to
 * each other flow the type offers, in the order the type declares them.
 *
 * - The `pairing` flow is left out, because no screen can run it yet, so
 *   offering it would lead to a dead end.
 * - When the type offers both sign-in flows, their labels tell them apart:
 *   "Sign in with a code instead" for the device flow, and "Sign in with
 *   GitHub in the browser instead" for the redirect flow. A type with one
 *   sign-in flow reads "Sign in with GitHub instead".
 */
export const listFlowSwitches = (
  type: ConnectionType,
  current: SetupFlow,
): ReadonlyArray<FlowSwitch> => {
  const flows = listSetupFlows(type);
  const offersBothSignIns = flows.includes("device") && flows.includes("oauth");
  return flows.flatMap((flow): ReadonlyArray<FlowSwitch> => {
    if (flow === current) return [];
    switch (flow) {
      case "pairing":
        return [];
      case "credentials": {
        const setup = describeCredentialsSetup(type);
        return [{ flow, label: `${setup.charAt(0).toUpperCase()}${setup.slice(1)} instead` }];
      }
      case "device":
        return [
          {
            flow,
            label: offersBothSignIns
              ? "Sign in with a code instead"
              : `Sign in with ${type.displayName} instead`,
          },
        ];
      case "oauth":
        return [
          {
            flow,
            label: offersBothSignIns
              ? `Sign in with ${type.displayName} in the browser instead`
              : `Sign in with ${type.displayName} instead`,
          },
        ];
    }
  });
};

/**
 * Checks whether `after` holds a credential that was replaced since `before`
 * was read: one whose `rotatedAt` differs from the same credential's in
 * `before`, or one whose name `before` did not have. `before` is undefined
 * when the Connection was not in the earlier list.
 */
const hasReplacedCredential = (before: Connection | undefined, after: Connection): boolean =>
  after.credentials.some((credential) => {
    const old = before?.credentials.find((held) => held.name === credential.name);
    return old === undefined || old.rotatedAt !== credential.rotatedAt;
  });

/**
 * Finds the Connection an OAuth setup wrote, by comparing the Connections
 * read when the setup started (`before`) with the ones read now (`after`).
 * The setup finishes in the browser, so a client that did not open the
 * browser's page learns of it only from the list. Returns `undefined` while
 * the setup has written nothing yet.
 *
 * - A new Connection (`connectionId` absent) is one of the type whose id was
 *   not in `before`.
 * - A reconnect (`connectionId` given) is that Connection, `connected`, with
 *   at least one credential replaced since `before`: its `rotatedAt` differs,
 *   or its name is new. The controller stamps `rotatedAt` only when a
 *   credential is replaced, so a rename, a config edit or a status recovery
 *   alone does not count.
 *
 * One false positive remains: a background token refresh that rotates the
 * Connection's credential while the user is still in the browser reads as the
 * reconnect finishing. Telling the two apart exactly needs the controller to
 * report which setup wrote the credential, by its setup id.
 */
export const findOAuthConnection = (
  before: readonly Connection[],
  after: readonly Connection[],
  setup: { readonly type: string; readonly connectionId?: string },
): Connection | undefined => {
  const { connectionId } = setup;
  if (connectionId === undefined) {
    const known = new Set(before.map((connection) => connection.id));
    return after.find((connection) => connection.type === setup.type && !known.has(connection.id));
  }
  const old = before.find((connection) => connection.id === connectionId);
  return after.find(
    (connection) =>
      connection.id === connectionId &&
      connection.status === "connected" &&
      hasReplacedCredential(old, connection),
  );
};

/**
 * The choices of a setting that loads them from the account, as the form row
 * shows them: still loading, loaded, or failed with the reason.
 */
export type FieldChoices =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly choices: ReadonlyArray<ConfigChoice> }
  | { readonly status: "failed"; readonly message: string };

/**
 * Returns the `FieldChoices` of a choices read, from the read's state: failed
 * with its error's message, loaded once its data is there, and loading until
 * then.
 */
export const decideFieldChoices = (read: {
  readonly isError: boolean;
  readonly error: unknown;
  readonly data: ReadonlyArray<ConfigChoice> | undefined;
}): FieldChoices => {
  if (read.isError) return { status: "failed", message: readErrorMessage(read.error) };
  return read.data === undefined ? { status: "loading" } : { status: "loaded", choices: read.data };
};

/**
 * Builds the connection's topics after the user edits the first one, the only
 * topic the settings form shows. Returns `undefined` when the first topic is
 * unchanged, so a save that leaves it alone sends no topics at all.
 *
 * The typed topic is trimmed, so stray spaces never make a topic of their
 * own, and text of only spaces clears the first topic. The topics after the
 * first, which only the CLI or the API can set, are kept. A kept topic that
 * equals the new first topic is dropped, so no topic is listed twice.
 */
export const buildTopicsUpdate = (
  topics: readonly string[],
  firstTopic: string,
): readonly string[] | undefined => {
  const typed = firstTopic.trim();
  if (typed === (topics[0] ?? "")) return undefined;
  const rest = topics.slice(1);
  return typed === "" ? rest : [typed, ...rest.filter((topic) => topic !== typed)];
};

/** The path the controller serves the provider's redirect on. */
const CALLBACK_PATH = "/oauth/callback";

/** Returns the redirect URI to register for this origin, without a double slash. */
export const buildRedirectUri = (origin: string): string =>
  `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`;

/**
 * Returns the feed's name as a form shows it: the first letter in upper case,
 * and dashes and underscores as spaces, so `pull_requests` reads "Pull requests".
 */
export const describeFeedName = (feed: ConnectionFeed): string => {
  const words = feed.name.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * Returns the help line of a feed's interval field: how often the feed is
 * polled when the user sets nothing, and the shortest interval allowed.
 * `typeName` is the connection type's display name, such as "GitHub".
 *
 * When the default is already the shortest interval, the line says so in one
 * sentence, because "Every 60 seconds. At least 60 seconds." repeats itself.
 */
export const describeFeedInterval = (feed: ConnectionFeed, typeName: string): string =>
  feed.defaultIntervalSeconds === feed.minIntervalSeconds
    ? `Every ${feed.defaultIntervalSeconds} seconds by default, the shortest ${typeName} allows.`
    : `Every ${feed.defaultIntervalSeconds} seconds by default. At least ${feed.minIntervalSeconds} seconds.`;

/**
 * What the user typed into each feed's interval field, keyed by feed name.
 * An empty string means the feed polls at its default.
 */
export type FeedIntervalsDraft = Readonly<Record<string, string>>;

/**
 * Returns the draft a form starts from: the stored interval of each feed the
 * type declares, as text, or an empty string for a feed on its default.
 */
export const buildFeedIntervalsDraft = (
  feeds: ReadonlyArray<ConnectionFeed>,
  stored: Connection["feedIntervals"],
): FeedIntervalsDraft =>
  Object.fromEntries(
    feeds.map((feed) => {
      const seconds = stored[feed.name];
      return [feed.name, seconds === undefined ? "" : String(seconds)];
    }),
  );

/** The message under a feed's interval field when its text is not a whole number of seconds. */
export const FEED_INTERVAL_UNREADABLE = "Enter a whole number of seconds.";

/** The result of reading the interval fields: the intervals to save, or the feeds whose text cannot be read. */
export type FeedIntervalsReading =
  | { readonly feedIntervals: Connection["feedIntervals"] }
  | { readonly errors: Readonly<Record<string, string>> };

/**
 * Converts the draft into the `feedIntervals` to save. A field left empty, or
 * holding only spaces, is left out, so that feed polls at its default. A field
 * holding anything `parseWholeNumber` cannot read, such as "abc", "1.5" or
 * "-5", is an error on that feed, and nothing is saved. Sending such text
 * would fail with a message about types rather than about the field.
 *
 * The map is sent whole and replaces the stored one, so an interval stored
 * for a feed the type no longer declares is dropped; the controller would
 * refuse it anyway. The numbers are not checked against each feed's minimum
 * here. The controller checks them, and the form shows its errors under the
 * fields, so the two can never disagree.
 */
export const buildFeedIntervalsPayload = (
  feeds: ReadonlyArray<ConnectionFeed>,
  draft: FeedIntervalsDraft,
): FeedIntervalsReading => {
  const feedIntervals: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const feed of feeds) {
    const typed = draft[feed.name] ?? "";
    if (typed.trim() === "") continue;
    const seconds = parseWholeNumber(typed);
    if (seconds === undefined) errors[feed.name] = FEED_INTERVAL_UNREADABLE;
    else feedIntervals[feed.name] = seconds;
  }
  return Object.keys(errors).length === 0 ? { feedIntervals } : { errors };
};

/**
 * The validation errors of a refused `connection.update`, split by the part
 * of the configure form that shows them.
 */
export interface ConnectionIssues {
  /** The error for each setting of the type's config schema, keyed by field name. */
  readonly config: Readonly<Record<string, string>>;
  /**
   * The error for each entry of a list setting, keyed by field name and then
   * by the entry's position, counted from 0.
   */
  readonly configEntries: ConfigIssues["perEntry"];
  /** The error for each feed's poll interval, keyed by feed name. */
  readonly feedIntervals: Readonly<Record<string, string>>;
  /**
   * Whether any error belongs to no field the form renders, or the failure is
   * not a validation error at all. The form must then show a general error,
   * or the save fails and the user is told nothing.
   */
  readonly rest: boolean;
}

const NO_CONNECTION_ISSUES: ConnectionIssues = {
  config: {},
  configEntries: {},
  feedIntervals: {},
  rest: false,
};

/**
 * Returns the errors of a failed `connection.update`, matched to the config
 * fields and the feeds the configure form renders.
 *
 * - An issue under `config` is matched as `matchConfigIssues` describes, so
 *   `config.repos.2` goes under the third entry of the `repos` list.
 * - An issue at `feedIntervals.<feed>` goes under that feed's field.
 * - Any other issue sets `rest`.
 *
 * Only the first issue of each field, and of each entry, is kept.
 */
export const readConnectionIssues = (
  error: unknown,
  configFields: ReadonlyArray<{ readonly name: string }>,
  feeds: ReadonlyArray<ConnectionFeed>,
): ConnectionIssues => {
  if (error === null || error === undefined) return NO_CONNECTION_ISSUES;
  const issues = readValidationIssues(error);
  if (issues === undefined) return { ...NO_CONNECTION_ISSUES, rest: true };

  const config = matchConfigIssues(listIssuesInGroup(issues, "config"), configFields);
  const feedNames = new Set(feeds.map((feed) => feed.name));
  const feedIntervals: Record<string, string> = {};
  let rest = config.rest;
  for (const { path, message } of issues) {
    const [part, feed] = path;
    if (part === "config") continue;
    if (part === "feedIntervals" && path.length === 2 && feed !== undefined && feedNames.has(feed))
      feedIntervals[feed] ??= message;
    else rest = true;
  }
  return { config: config.perField, configEntries: config.perEntry, feedIntervals, rest };
};
