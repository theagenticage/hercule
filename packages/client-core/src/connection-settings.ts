/**
 * Client-side rules that only the Connections settings screens use: how a
 * Connection's health and setup read, which other setup flows a form offers,
 * and when an OAuth setup has finished.
 *
 * They live apart from `connections.ts` because the app's first screen imports
 * `connections.ts` (for `connectionNeedsAttention`), and a bundler keeps a
 * module whole: everything in that file is loaded before the first screen
 * draws. Settings code loads only when the user opens Settings.
 */
import type { ConfigChoice, Connection } from "@hercule/contract";
import {
  listCredentialFields,
  listSetupFlows,
  showsPluginName,
  type ConnectionType,
  type SetupFlow,
} from "./connections";
import { readErrorMessage } from "./errors";

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
      return "paste a token";
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
 * Returns the label of the button that switches to the credentials flow, from
 * the fields that flow asks for:
 *
 * - one token field: "Paste a token instead";
 * - one other field: "Enter your API key instead";
 * - several fields, or none: "Enter credentials instead".
 */
const buildCredentialsSwitchLabel = (type: ConnectionType): string => {
  const fields = listCredentialFields(type);
  const [field] = fields;
  if (fields.length !== 1 || field === undefined) return "Enter credentials instead";
  return /\btoken\b/i.test(field.label)
    ? "Paste a token instead"
    : `Enter your ${lowerFirstWord(field.label)} instead`;
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
      case "credentials":
        return [{ flow, label: buildCredentialsSwitchLabel(type) }];
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
