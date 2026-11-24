/**
 * The `connection.*` operations. A connection is one external account, as the
 * user set it up.
 *
 * The core owns the connection and a plugin provides its type, so every write
 * here asks the type two questions the core cannot answer itself:
 *
 * - is this config valid for the type?
 * - do these credentials work, and which account do they belong to?
 *
 * `validate` calls the external service. It runs before the transaction and
 * never inside one: a transaction that waited on the network would hold the
 * database for as long as the service takes to respond. As a result, a
 * connection is written only once its account is known.
 *
 * A reconnect keeps the connection's id, so its triggers and resources stay
 * attached, and it must therefore sign in to the same account. `validate`
 * returns the provider's stable id for the account, and a reconnect whose
 * credentials belong to another id is refused with nothing written.
 *
 * Credentials are stored in the secrets table under the owner
 * `connection/<id>`. The API returns only references to them: each name, and
 * when the value was last replaced.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import type * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  decodeAgainst,
  listChoiceFields,
  type ConnectionValidationFailed,
  type CreatedOAuthClient,
  type CredentialField,
  type ExternalAccount,
} from "@hercule/plugin-host";
import {
  CONNECTION_SORT_FIELDS,
  ConnectionCreateInput,
  ConnectionCredentialsInput,
  ConnectionDevicePollInput,
  ConnectionDeviceStartInput,
  ConnectionOAuthFinishInput,
  ConnectionOAuthStartInput,
  ConnectionStatus,
  ConnectionUpdateInput,
  DEFAULT_PAGE_LIMIT,
  ConfigChoice,
  Id,
  MAX_CONFIG_CHOICES,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  formatIssue,
  isRedirectAddress,
  listDecodeIssues,
  MAX_PLUGIN_MESSAGE_LENGTH,
  parseCallbackQuery,
  summarizeCause,
  truncateMessage,
  type Connection,
  type ConnectionChoices,
  type ConnectionDetail,
  type ConnectionDevicePoll,
  type ConnectionDeviceStart,
  type ConnectionOAuthStart,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { CurrentActor, currentStamp, requireGrant, USER_ACTOR, type Actor } from "../actor";
import { mintToken } from "../credentials";
import {
  afterCommit,
  nowIso,
  buildPageInputFields,
  refuseCursor,
  resolveSortKeys,
  withTransaction,
  type ResolvedSortKey,
} from "../db";
import { AuditLog } from "../events";
import { applyIntakeOverrides, normalizeIntakeOverrides, PluginIntake } from "../intake-settings";
import { computeChallenge, exchangeCode, serializeTokens, type TokenSet } from "../oauth";
import { Secrets, type SecretNameRef, type SecretOwner } from "../secrets";
import { ActivePlugins } from "./active-plugins";
import { deviceSetupRepository } from "./device-setups";
import {
  buildAuthorizationUrl,
  exchangeDeviceCode,
  isRegisteredRedirectUri,
  oauthClients,
  OAUTH_TOKENS,
  buildRedirectUri,
  CATCHER_PATH,
  requestDeviceCode,
  SETUP_LIFETIME_MS,
  SLOW_DOWN_STEP_SECONDS,
  type Outcome,
} from "./oauth";
import { buildDefaultLabel } from "./default-label";
import { PluginConfigs } from "./plugin-configs";
import { ConnectionEntityFacts } from "./entity-facts";
import { ConnectionObserver } from "./observer";
import { ConnectionReferences, type ConnectionReference } from "./references";
import {
  connectionRepository,
  type ConnectionSortField,
  type StoredConnection,
} from "./repository";
import { ConnectionTypes, type RegisteredConnectionType } from "./runtime";
import type { StoredSetup } from "./oauth-setups";
import { pendingOAuthSetups } from "./pending-oauth-setups";
import { PromotionState } from "../promotion";
import type { SetupTarget, StoredSetupTarget } from "./setup-target";

/** The input of `connection.query`: filters, page size and sort order. */
const QueryInput = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(ConnectionStatus),
  ...buildPageInputFields(CONNECTION_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...ConnectionUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const CredentialsInput = Schema.Struct({ id: Id, ...ConnectionCredentialsInput.fields });

export type CredentialsInput = Schema.Schema.Type<typeof CredentialsInput>;

/** The input of `connection.listChoices`: the connection and the name of one config field. */
const ListChoicesInput = Schema.Struct({ id: Id, field: Schema.String });

export type ListChoicesInput = Schema.Schema.Type<typeof ListChoicesInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeListChoices = Schema.decodeUnknownEffect(ListChoicesInput);
const decodeChoices = Schema.decodeUnknownEffect(Schema.Array(ConfigChoice));
const decodeCreate = Schema.decodeUnknownEffect(ConnectionCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeCredentials = Schema.decodeUnknownEffect(CredentialsInput);

/** One page of connections, in the contract's shape. */
export interface ConnectionPage {
  readonly items: ReadonlyArray<Connection>;
  readonly nextCursor?: string;
}

/** Oldest first, so the Connections screen lists connections in the order the user added them. */
const DEFAULT_SORT: Arr.NonEmptyReadonlyArray<ResolvedSortKey<ConnectionSortField>> = [
  { field: "createdAt", direction: "asc" },
];

const NO_SUCH_CONNECTION = "no such connection";

/**
 * The refusal of a reconnect that was given a label, topics or config. A
 * reconnect only replaces the connection's credentials, so it would otherwise
 * drop those fields without a word.
 */
const RECONNECT_KEEPS_SETTINGS =
  "a reconnect keeps the connection's label, topics and config, so it takes none of them: " +
  "change them with connection.update instead";

/** The setting each field of a reconnect refusal names, as its issue message spells it. */
const RECONNECT_KEPT_SETTING = { label: "label", labels: "topics", config: "config" } as const;

/**
 * Builds the refusal for a connection that other records still name. It lists
 * every one of them, so the user can change them all before trying again.
 */
const buildNamedByMessage = (named: ReadonlyArray<ConnectionReference>): string => {
  // A resource is named by its id too, because the id is what the user
  // passes to update it, and because a folder's label can be cleared.
  const resources = named.flatMap((each) =>
    each.kind === "resource"
      ? [each.resourceName === null ? each.resourceId : `${each.resourceName} (${each.resourceId})`]
      : [],
  );
  const triggers = named.flatMap((each) =>
    each.kind === "trigger" ? [`${each.triggerId} in the workflow ${each.workflowName}`] : [],
  );
  const steps = named.flatMap((each) =>
    each.kind === "step" ? [`${each.stepId} in the workflow ${each.workflowName}`] : [],
  );
  const mcpServers = named.flatMap((each) =>
    each.kind === "mcpServer" ? [`${each.mcpServerName} (${each.mcpServerId})`] : [],
  );
  const parts: Array<string> = [];
  if (resources.length > 0) {
    parts.push(
      `resources act through this connection: ${resources.join(", ")}; ` +
        "point those resources at another connection before deleting this one",
    );
  }
  if (triggers.length > 0) {
    parts.push(
      `workflow triggers match only events from this connection: ${triggers.join(", ")}; ` +
        "point those triggers at another connection, or delete them, before deleting this one",
    );
  }
  if (steps.length > 0) {
    parts.push(
      `workflow steps act through this connection: ${steps.join(", ")}; ` +
        "point those steps at another connection, or delete them, before deleting this one",
    );
  }
  if (mcpServers.length > 0) {
    parts.push(
      `MCP servers call out with this connection's credentials: ${mcpServers.join(", ")}; ` +
        "remove each server first with `hercule mcp-server delete <id>`, then delete this connection",
    );
  }
  return parts.join("; ");
};

/** A connection type as the host registered it: the catalog entry, plus its `validate` function. */
type Contribution = RegisteredConnectionType["contribution"];

/** Returns the names of the credential fields a type's setup asks for. */
const listCredentialFields = (contribution: Contribution): ReadonlyArray<string> =>
  contribution.setup.flatMap((step) =>
    step.kind === "credentials" ? step.fields.map((field) => field.name) : [],
  );

/**
 * Checks whether a type takes pasted credentials. A type may also offer a
 * token flow beside them; only a type with no `credentials` step refuses
 * pasted ones.
 */
const hasCredentialsStep = (contribution: Contribution): boolean =>
  contribution.setup.some((step) => step.kind === "credentials");

/** Whether a refused request was creating a connection or reconnecting one. */
type SetupPurpose = "create" | "reconnect";

/**
 * Builds the end of a refusal: the operations that do set up this type,
 * which the caller should use instead. Each setup step that obtains
 * credentials has its own operation:
 *
 * - `credentials`: `connection.create`, or `connection.setCredentials` for a
 *   reconnect;
 * - `oauth`: `connection.startOAuth`;
 * - `device`: `connection.startDeviceFlow`.
 *
 * A `checklist` or `pairing` step obtains no credentials, so a type with only
 * those steps has no operation to name, and the text says so.
 */
const describeSetupOperations = (contribution: Contribution, purpose: SetupPurpose): string => {
  const operations = contribution.setup.flatMap((step) => {
    switch (step.kind) {
      case "credentials":
        return [purpose === "create" ? "connection.create" : "connection.setCredentials"];
      case "oauth":
        return ["connection.startOAuth"];
      case "device":
        return ["connection.startDeviceFlow"];
      default:
        return [];
    }
  });
  const goal = purpose === "create" ? "set it up" : "reconnect it";
  return operations.length === 0
    ? `no operation can ${goal}, because its setup has no credentials, oauth or device step`
    : `${goal} with ${operations.join(" or ")} instead`;
};

/**
 * Returns the label's text as it reads in the middle of a sentence: the first
 * letter in lower case, unless the first word is an acronym such as "API".
 */
const lowerFirstWord = (label: string): string =>
  /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);

/**
 * Builds the refusal for a redirect flow started from an origin the type's
 * public client did not register, such as "Signing in with Linear works only
 * at http://127.0.0.1:4937 or http://localhost:4937, not at
 * http://n.tail.ts.net. Open Hercule at one of those addresses to sign in
 * with Linear, or paste your personal API key instead."
 *
 * The addresses are the registered redirect URIs without the callback path.
 * The only other flow the message can offer is the type's `credentials`
 * step, because registration refuses a type that offers a device flow beside
 * a redirect flow.
 */
const describeUnregisteredOrigin = (
  contribution: Contribution,
  redirectUris: ReadonlyArray<string>,
  origin: string,
): string => {
  const name = contribution.displayName;
  const addresses = redirectUris.map((uri) => URL.parse(uri)?.origin ?? uri);
  const labels = contribution.setup.flatMap((step) =>
    step.kind === "credentials" ? step.fields.map((field) => lowerFirstWord(field.label)) : [],
  );
  const otherFlow =
    labels.length === 0
      ? ""
      : `, or paste your ${new Intl.ListFormat("en", { type: "conjunction" }).format(labels)} instead`;
  // A client that registered the desktop app's catcher accepts any port of an
  // address on this computer, so its registered addresses name no port and
  // listing them would send the user to port 80.
  if (redirectUris.some((uri) => URL.parse(uri)?.pathname === CATCHER_PATH)) {
    return (
      `Signing in with ${name} works only when your browser comes back to an address on ` +
      `your own computer, and not to ${origin}. Use the Hercule desktop app, or start the ` +
      `sign-in from the command line with --redirect-uri and paste the address your browser ` +
      `ends on, or open Hercule at ${new Intl.ListFormat("en", { type: "disjunction" }).format(addresses)} ` +
      `with its own port${otherFlow}.`
    );
  }
  return (
    `Signing in with ${name} works only at ` +
    `${new Intl.ListFormat("en", { type: "disjunction" }).format(addresses)}, not at ${origin}. ` +
    `Open Hercule at ${addresses.length === 1 ? "that address" : "one of those addresses"} ` +
    `to sign in with ${name}${otherFlow}.`
  );
};

/**
 * Builds the refusal for a flow that asked to return to an address on the
 * user's machine that the type's public client did not register, or whose
 * type has no public client at all. The message names what works.
 */
const describeUnregisteredReturnAddress = (
  contribution: Contribution,
  redirectUris: ReadonlyArray<string> | undefined,
  redirectUri: string,
): string => {
  const name = contribution.displayName;
  if (redirectUris === undefined) {
    return (
      `Signing in with ${name} cannot return to ${redirectUri}: the type has no OAuth client ` +
      `that registered an address on your computer. Start the sign-in with the origin of the ` +
      `browser instead, so that the provider sends it back to Hercule.`
    );
  }
  const addresses = redirectUris.map((uri) => `${uri} (on any port, when it names none)`);
  return (
    `Signing in with ${name} cannot return to ${redirectUri}: its OAuth client registered only ` +
    `${new Intl.ListFormat("en", { type: "disjunction" }).format(addresses)}.`
  );
};

/**
 * Builds the refusal for a start that has no OAuth client to sign in with.
 * `clientFields` is the fields a type that creates its own client declares,
 * and `undefined` for any other type, whose client is its plugin's settings.
 */
const describeMissingClient = (
  pluginId: string,
  clientFields: ReadonlyArray<CredentialField> | undefined,
): string => {
  if (clientFields === undefined) {
    return (
      `the plugin ${pluginId} has no OAuth client credentials: set its clientId ` +
      `config field and its clientSecret secret before connecting`
    );
  }
  const labels = clientFields.map((field) => lowerFirstWord(field.label));
  return (
    `this Connection has no app yet: paste a new ` +
    `${new Intl.ListFormat("en", { type: "conjunction" }).format(labels)} to set it up again`
  );
};

/**
 * Why a redirect flow ended without a Connection, as a word of its own. The
 * six `Outcome` words are what the controller's callback page shows, and
 * these are what `connection.finishOAuth` refuses with, so they tell apart the
 * ways it refuses before it claims a flow from the ways a claimed flow ends.
 *
 * - `no-live-attempt`: no flow of this caller waits for the answer: its
 *   `state` is unknown, ran out, was finished already, or belongs to a flow
 *   that returns elsewhere or was started by another caller. Nothing was
 *   claimed.
 * - `wrong-address`: the pasted address is not the redirect address the flow
 *   started with. Nothing was claimed.
 * - `connection-changed`: the Connection being reconnected was deleted, or its
 *   credentials were replaced, while the user was at the provider.
 * - The other four are the `Outcome` words of the same name.
 */
type FinishFailure =
  | "no-live-attempt"
  | "wrong-address"
  | "connection-changed"
  | "denied"
  | "exchange-failed"
  | "rejected"
  | "other-account";

/**
 * How a finish failed, with what a refusal needs to know about the flow:
 * `reusedApp` holds the fields of the type's app when the flow was a
 * reconnect that signed in with the Connection's own app, and is `undefined`
 * for any other flow.
 */
interface FinishError {
  readonly failure: FinishFailure;
  readonly reusedApp: ReadonlyArray<CredentialField> | undefined;
}

/** Converts a failed finish to the `Outcome` word the callback page's URL carries. */
const decideCallbackOutcome = (failure: FinishFailure): Outcome =>
  failure === "no-live-attempt" || failure === "wrong-address" || failure === "connection-changed"
    ? "expired"
    : failure;

/**
 * Returns the sentence that tells the user what to do when the app a
 * reconnect signs in with may be gone: the user may have deleted it at the
 * provider, and signing in again would reuse it. Starting with new values
 * creates a new app.
 */
const describeAppSetUpAgain = (fields: ReadonlyArray<CredentialField>): string => {
  const labels = fields.map((field) => lowerFirstWord(field.label));
  return (
    ` If the app was deleted at the provider, set it up again: start the sign-in with a new ` +
    `${new Intl.ListFormat("en", { type: "conjunction" }).format(labels)} ` +
    `(on the command line, add --client-values-stdin to hercule connection start-oauth)`
  );
};

/**
 * Builds the refusal `connection.finishOAuth` answers a failed finish with:
 * what happened, and what to do. `reusedApp` holds the fields of the type's
 * app when the flow was a reconnect that signed in with the Connection's own
 * app, which a refusal of the code may mean was deleted.
 */
const buildFinishRefusal = (
  failure: FinishFailure,
  reusedApp: ReadonlyArray<CredentialField> | undefined,
): Validation | InvalidState => {
  const appHint = reusedApp === undefined ? "" : describeAppSetUpAgain(reusedApp);
  switch (failure) {
    case "no-live-attempt":
      return createValidationError(
        [
          {
            path: ["callbackQuery"],
            message:
              "no sign-in of yours is waiting for this answer: it was finished already, it " +
              "ran out after 10 minutes, or someone else started it. Start the sign-in again",
          },
        ],
        "no sign-in of yours is waiting for this answer",
      );
    case "wrong-address":
      return createValidationError([
        {
          path: ["callbackQuery"],
          message:
            "this is not the address the sign-in was to return to: paste the address your " +
            "browser ended on after you approved the sign-in",
        },
      ]);
    case "connection-changed":
      return createInvalidStateError(
        "the Connection was deleted, or signed in again, while you were at the provider, so " +
          "nothing was changed. Start the sign-in again if you still want it",
      );
    case "denied":
      return createInvalidStateError(
        "the provider ended the sign-in without a code: you declined it, or the provider " +
          `reported an error. Start the sign-in again to try again.${appHint}`,
      );
    case "exchange-failed":
      return createInvalidStateError(
        "the provider did not accept the code, or could not be reached, so nothing was " +
          `changed. Start the sign-in again.${appHint}`,
      );
    case "rejected":
      return createInvalidStateError(
        "the provider issued tokens, but the check of the account refused them, so nothing " +
          "was changed. Start the sign-in again, and check that you approve it with the " +
          "account you mean to use",
      );
    case "other-account":
      return createInvalidStateError(
        "you signed in with another account than the one this Connection belongs to, so " +
          "nothing was changed. A reconnect must stay with the same account, because the " +
          "Connection's triggers and resources are tied to it: sign in with that account, " +
          "or create a new Connection for the other one",
      );
  }
};

/** Returns the redirect URI a stored flow used: its own, or the controller's callback for the flow's origin. */
const buildSetupRedirectUri = (setup: StoredSetup): string =>
  setup.redirectUri ?? buildRedirectUri(setup.origin);

/** What replaces a value the user pasted where a plugin's message quotes it. */
const REMOVED = "[removed]";

/**
 * The shortest pasted value of a field not declared secret that is removed
 * from a plugin's message. A shorter value, such as `1`, would blank out
 * unrelated text.
 */
const MIN_REDACTED_LENGTH = 8;

/**
 * Returns `message` with every value the user pasted replaced by `[removed]`:
 * the values of the fields in `secretFields` at any length, and any other
 * value of `MIN_REDACTED_LENGTH` characters or more.
 * A plugin's refusal is shown to the user and may be stored in a log, and a
 * provider that echoes what it was sent would otherwise put the pasted token
 * there. The longest values go first, so a value that contains another is
 * removed whole.
 */
const redactPastedValues = (
  message: string,
  values: Record<string, string>,
  secretFields: ReadonlySet<string>,
): string =>
  Object.entries(values)
    .map(([name, value]) => ({ name, value: value.trim() }))
    // A field the type declares secret is removed at any length, because the
    // type says its value must never be shown. The other values are removed
    // only from `MIN_REDACTED_LENGTH`, as a short one would blank out text.
    .filter(({ name, value }) =>
      secretFields.has(name) ? value.length > 0 : value.length >= MIN_REDACTED_LENGTH,
    )
    .map(({ value }) => value)
    .sort((left, right) => right.length - left.length)
    .reduce((text, value) => text.split(value).join(REMOVED), message);

/**
 * The fixed message of a refused start whose plugin failed while creating the
 * OAuth client in a way it did not report. The failure itself is not quoted,
 * because the plugin handled what the user pasted.
 */
const CREATING_CLIENT_FAILED =
  "the plugin failed while creating the OAuth client, so nothing was set up. Try again";

const decodeStart = Schema.decodeUnknownEffect(ConnectionOAuthStartInput);
const decodeFinish = Schema.decodeUnknownEffect(ConnectionOAuthFinishInput);
const decodeDeviceStart = Schema.decodeUnknownEffect(ConnectionDeviceStartInput);
const decodeDevicePoll = Schema.decodeUnknownEffect(ConnectionDevicePollInput);

/** The answer to a poll of a device flow that is unknown, already ended, or expired. */
const DEVICE_FLOW_EXPIRED = "this device flow has ended or expired: start a new one";

/**
 * The longest a device flow is kept, in seconds, whatever the provider asks
 * for. A hostile or broken provider could otherwise keep a setup row alive
 * for years.
 *
 * The poll interval has no cap of its own: RFC 8628 section 3.5 forbids
 * polling sooner than the provider asks. A flow whose next poll would come
 * after it expires ends instead, so no client ever waits longer than this.
 */
const MAX_DEVICE_FLOW_SECONDS = 30 * 60;

/**
 * Builds the message for a device flow the provider wants polled so slowly
 * that it would expire before its next poll.
 */
const describeIntervalPastExpiry = (interval: number): string =>
  `the provider asks to wait ${interval} seconds before the next check, but the code expires ` +
  `before then, so the sign-in cannot finish: start again to get a new code`;

/**
 * How the account check is retried once a device flow's approval is spent:
 * three attempts in all, one second and then two seconds apart. The provider
 * cannot issue the token again, so a check that failed on a passing network
 * error would otherwise cost the user a new code.
 */
const ACCOUNT_CHECK_RETRY = { schedule: Schedule.exponential("1 second"), times: 2 };

/**
 * Returns the warning a Connection type's `validate` returned with the
 * account, cut to the length of a plugin message, or null when it returned
 * none. Null clears the warning a reconnect's earlier credentials left.
 */
const readAccountWarning = (account: ExternalAccount): string | null =>
  account.warning === undefined || account.warning === ""
    ? null
    : account.warning.slice(0, MAX_PLUGIN_MESSAGE_LENGTH);

/** Returns `{ warning }` for a new Connection's row, or nothing when the account has no warning. */
const buildWarningField = (account: ExternalAccount): { readonly warning?: string } => {
  const warning = readAccountWarning(account);
  return warning === null ? {} : { warning };
};

/**
 * Checks whether new credentials belong to another account than the one the
 * connection signs in as.
 */
const isOtherAccount = (account: ExternalAccount, connection: StoredConnection): boolean =>
  connection.accountId !== account.accountId;

/**
 * Builds the refusal of a reconnect that signed in to another account.
 * `connectionDisplayName` is the account name the connection stored at its
 * last sign-in. The account may have been renamed since, so the message
 * gives it as the last known name rather than as the name to sign in with.
 */
const describeOtherAccount = (account: ExternalAccount, connectionDisplayName: string): string =>
  `the account ${account.displayName} is not the account this connection belongs to ` +
  `(last signed in as ${connectionDisplayName}). A reconnect must stay with the same account, ` +
  `because the connection's triggers and resources are tied to it. Reconnect with that ` +
  `account, or create a new connection for ${account.displayName}`;

/**
 * How writing the connection at the end of a token flow ended:
 *
 * - `written`: the connection was created or reconnected, and is returned;
 * - `connection-gone`: the connection being reconnected was deleted while
 *   the user was at the provider;
 * - `credentials-replaced`: the connection's credentials were replaced by
 *   another sign-in or by pasted credentials after this flow started, so the
 *   first replacement stands;
 * - `other-account`: the tokens belong to another account than the
 *   connection being reconnected. `connectionDisplayName` is the name of the
 *   connection's own account, for the refusal.
 *
 * Nothing is written in the last three cases.
 */
type TokenFlowWriteResult =
  | { readonly _tag: "written"; readonly connection: Connection }
  | { readonly _tag: "connection-gone" }
  | { readonly _tag: "credentials-replaced" }
  | { readonly _tag: "other-account"; readonly connectionDisplayName: string };

/** The actor of a caller nobody knows. It holds no grant. */
const NO_ACTOR: Actor = { _tag: "none" };

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const deviceSetups = yield* deviceSetupRepository;
  const findOAuthClient = yield* oauthClients;
  const secrets = yield* Secrets;
  const types = yield* ConnectionTypes;
  const audit = yield* AuditLog;
  const references = yield* ConnectionReferences;
  const entityFacts = yield* ConnectionEntityFacts;
  const observer = yield* ConnectionObserver;
  const activePlugins = yield* ActivePlugins;
  const pluginIntake = yield* PluginIntake;

  const pending = yield* pendingOAuthSetups;
  const serviceScope = yield* Effect.scope;

  /**
   * Runs the `write` that creates a Connection and, in the same uninterruptible
   * step, starts the work `ConnectionObserver` does for it, so no interrupt can
   * land between the durable commit and that start. Without this, a client that
   * hangs up just as the commit finishes would leave a Connection that nothing
   * ever tells the observer about, and a reconnect never repairs that.
   *
   * `describeCreated` says, from the write's result, which Connection was
   * created and who created it, or `undefined` when the write created none.
   * The observer's work runs in a fiber of the service's own scope and never
   * fails. Returns the write's result and that fiber. The caller waits for it
   * with `awaitObserver`, and a cancelled caller stops waiting without stopping
   * the work.
   */
  const writeAndStartObserver = <A, E, R>(
    write: Effect.Effect<A, E, R>,
    describeCreated: (
      result: A,
    ) => Effect.Effect<{ readonly connection: Connection; readonly actor: Actor } | undefined>,
  ): Effect.Effect<
    { readonly result: A; readonly observer: Fiber.Fiber<void> | undefined },
    E,
    R
  > =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* write;
        const created = yield* describeCreated(result);
        const started =
          created === undefined
            ? undefined
            : yield* Effect.forkIn(
                observer.connectionCreated({
                  connectionId: created.connection.id,
                  type: created.connection.type,
                  actor: created.actor,
                }),
                serviceScope,
              );
        return { result, observer: started };
      }),
    );

  /** Waits for the observer's work that `writeAndStartObserver` started, if any. */
  const awaitObserver = (started: Fiber.Fiber<void> | undefined): Effect.Effect<void> =>
    started === undefined ? Effect.void : Fiber.join(started);

  const buildSecretOwner = (id: string): SecretOwner => ({ kind: "connection", id });

  /** Returns the registered connection type with this name, or fails with `validation`. */
  const readTypeOrFail = (type: string): Effect.Effect<RegisteredConnectionType, Validation> =>
    Effect.flatMap(
      types.named(type),
      Option.match({
        onNone: () =>
          Effect.fail(
            createValidationError([
              { path: ["type"], message: `no plugin defines the type ${type}` },
            ]),
          ),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Returns the registered type of a stored connection. Fails with
   * `invalid_state` when no plugin in this build defines the type: it was
   * registered when the row was written, so the build has changed, and the
   * caller cannot fix that by sending a different request.
   */
  const readStoredTypeOrFail = (
    row: StoredConnection,
  ): Effect.Effect<RegisteredConnectionType, InvalidState> =>
    Effect.flatMap(
      types.named(row.type),
      Option.match({
        onNone: () =>
          Effect.fail(
            createInvalidStateError(
              `the plugin that defines the type ${row.type} is not in this build`,
            ),
          ),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Validates a config against the type's config schema, and fails with
   * `validation` when it does not match. A type with no config schema accepts
   * only the empty config, because nothing would ever read any other value.
   */
  const readConfig = (
    contribution: Contribution,
    config: Record<string, Schema.Json>,
  ): Effect.Effect<void, Validation> => {
    const schema = contribution.configSchema;
    if (schema === undefined) {
      return Object.keys(config).length === 0
        ? Effect.void
        : Effect.fail(
            createValidationError([
              {
                path: ["config"],
                message: `the type ${contribution.type} takes no configuration`,
              },
            ]),
          );
    }
    return Effect.asVoid(
      Effect.mapError(decodeAgainst(schema, config), (error) =>
        createValidationError(
          listDecodeIssues(error).map((issue) => ({ ...issue, path: ["config", ...issue.path] })),
        ),
      ),
    );
  };

  /**
   * Checks the user's poll intervals against the feeds the type's event
   * source declares. Fails with `validation`, with one issue per refused feed
   * at `feedIntervals.<feed>`, when a feed is not declared, or when its
   * interval is shorter than the feed's shortest: its `minIntervalSeconds`, or
   * its default when it declares no minimum.
   *
   * A shorter interval is refused rather than raised to the shortest, because
   * the user would otherwise see a number stored that is not the one polled.
   */
  const checkFeedIntervals = (
    { contribution, feeds }: RegisteredConnectionType,
    intervals: Readonly<Record<string, number>>,
  ): Effect.Effect<void, Validation> =>
    Effect.gen(function* () {
      const issues = Object.entries(intervals).flatMap(([feed, seconds]) => {
        const declaration = feeds[feed];
        if (declaration === undefined) {
          const known = Object.keys(feeds);
          const message =
            known.length === 0
              ? `${contribution.displayName} has no feeds to poll, so it takes no poll intervals.`
              : `${contribution.displayName} has no feed named ${feed}. Its feeds are ${known.join(", ")}.`;
          return [{ path: ["feedIntervals", feed], message }];
        }
        const shortest = declaration.minIntervalSeconds ?? declaration.defaultIntervalSeconds;
        if (seconds >= shortest) return [];
        return [
          {
            path: ["feedIntervals", feed],
            message: `Poll ${feed} every ${String(shortest)} seconds or slower; ${contribution.displayName} does not allow a shorter interval.`,
          },
        ];
      });
      // Every message is also in the top-level message, which is the line
      // the CLI prints.
      if (issues.length > 0) {
        const message = issues.map((issue) => issue.message).join(" ");
        return yield* Effect.fail(createValidationError(issues, message));
      }
    });

  /**
   * Checks that the credentials have exactly the fields the type declares, and
   * returns them. Fails with `validation` for a missing field or an unknown
   * one: an unknown field would be stored as a secret that nothing ever reads.
   */
  const checkCredentialFields = (
    contribution: Contribution,
    credentials: Record<string, string>,
  ): Effect.Effect<Record<string, string>, Validation> => {
    const declared = listCredentialFields(contribution);
    const issues = [
      ...declared
        .filter((name) => credentials[name] === undefined)
        .map((name) => ({ path: ["credentials", name], message: "this field is required" })),
      ...Object.keys(credentials)
        .filter((name) => !declared.includes(name))
        .map((name) => ({
          path: ["credentials", name],
          message: `the type ${contribution.type} declares no field named ${name}`,
        })),
    ];
    return issues.length === 0
      ? Effect.succeed(Object.fromEntries(declared.map((name) => [name, credentials[name]!])))
      : Effect.fail(createValidationError(issues));
  };

  /**
   * Asks the type whether these credentials work, and returns the account
   * they belong to. When they do not work, fails with `validation` at the first
   * credential field: the error is about the credentials as a whole, but a form
   * needs a field to show the message under. A type with no credential fields,
   * such as an OAuth type, gets the error at `credentials` itself.
   */
  const validateCredentials = (
    contribution: Contribution,
    credentials: Record<string, string>,
  ): Effect.Effect<ExternalAccount, Validation> =>
    Effect.mapError(
      Effect.provide(contribution.validate(credentials), FetchHttpClient.layer),
      (failure: ConnectionValidationFailed) => {
        const field = listCredentialFields(contribution)[0];
        return createValidationError(
          [
            {
              path: field === undefined ? ["credentials"] : ["credentials", field],
              message: failure.message,
            },
          ],
          failure.message,
        );
      },
    );

  /** Builds a connection as the API returns it: the row, plus references to its secrets. */
  const buildConnectionRecord = (
    row: StoredConnection,
    refs: ReadonlyArray<SecretNameRef>,
  ): Connection => ({
    id: row.id,
    type: row.type,
    label: row.label,
    displayName: row.displayName,
    status: row.status,
    ...(row.statusDetail === undefined ? {} : { statusDetail: row.statusDetail }),
    ...(row.warning === undefined ? {} : { warning: row.warning }),
    labels: row.labels,
    config: row.config,
    feedIntervals: row.feedIntervals,
    credentials: refs.map((ref) => ({
      name: ref.name,
      ...(ref.rotatedAt === null ? {} : { rotatedAt: ref.rotatedAt }),
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const readStoredConnectionOrFail = (
    id: string,
  ): Effect.Effect<StoredConnection, NotFound | SqlError> =>
    Effect.flatMap(
      connections.one(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_CONNECTION)),
        onSome: Effect.succeed,
      }),
    );

  const readConnectionRecord = (row: StoredConnection): Effect.Effect<Connection, SqlError> =>
    Effect.map(secrets.refs("connection", [row.id]), (refs) =>
      buildConnectionRecord(row, refs.get(row.id) ?? []),
    );

  const readConnectionOrFail = (id: string): Effect.Effect<Connection, NotFound | SqlError> =>
    Effect.flatMap(readStoredConnectionOrFail(id), readConnectionRecord);

  /**
   * Reads a Connection with its Intake settings: for every kind its plugin
   * declares, the value in effect from the plugin's default, the plugin's
   * level or the Connection's own choice. Fails with `not_found` when there
   * is no such Connection.
   */
  const readConnectionDetailOrFail = (
    id: string,
  ): Effect.Effect<ConnectionDetail, NotFound | SqlError> =>
    Effect.gen(function* () {
      const row = yield* readStoredConnectionOrFail(id);
      const record = yield* readConnectionRecord(row);
      const pluginLevel = yield* pluginIntake.read(row.pluginId);
      return { ...record, intake: applyIntakeOverrides(pluginLevel, row.intake, "connection") };
    });

  /**
   * Makes the connection's secrets exactly these credentials: stores each
   * value, and deletes every secret the connection holds under another name.
   * A connection that switches from a pasted token to a token flow, or back,
   * so keeps nothing of the way it was set up before.
   *
   * Field names were checked for the `|` separator when the plugin declared
   * them, and a connection id is a UUID, so the secrets repository never
   * rejects them.
   */
  const replaceSecrets = (
    id: string,
    credentials: Record<string, string>,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const owner = buildSecretOwner(id);
      const held = (yield* secrets.refs("connection", [id])).get(id) ?? [];
      yield* Effect.forEach(
        held.filter((ref) => !Object.hasOwn(credentials, ref.name)),
        (ref) => secrets.delete(owner, ref.name),
        { discard: true },
      );
      yield* Effect.forEach(
        Object.entries(credentials),
        ([name, value]) => secrets.set(owner, name, Redacted.make(value)),
        { discard: true },
      );
    }).pipe(Effect.catchTag("SecretNameError", Effect.die));

  /**
   * Checks the input that starts a token flow, and returns what the flow does
   * once it has tokens, with the connection a reconnect names as it was read
   * (`undefined` for a new connection), so its id and credentials generation
   * travel together.
   *
   * - A new connection takes its label, topics and config from the input. The
   *   topics default to none and the config to empty; a missing label is
   *   decided when the connection is written, from the account name.
   * - A reconnect keeps the connection's own label, topics and config.
   *
   * Fails with `validation` when the config does not suit the type, when the
   * reconnected connection does not exist or has another type, or when a
   * reconnect is given a label, topics or config. That last refusal has one
   * issue per field given.
   */
  const buildSetupTarget = (
    input: {
      readonly type: string;
      readonly label?: string;
      readonly labels?: ReadonlyArray<string>;
      readonly config?: Record<string, Schema.Json>;
      readonly connectionId?: string;
    },
    contribution: Contribution,
  ): Effect.Effect<
    { readonly target: SetupTarget; readonly reconnected: StoredConnection | undefined },
    Validation | SqlError
  > =>
    Effect.gen(function* () {
      if (input.connectionId === undefined) {
        const config = input.config ?? {};
        yield* readConfig(contribution, config);
        return {
          target: { kind: "create", label: input.label, labels: input.labels ?? [], config },
          reconnected: undefined,
        } as const;
      }
      const existing = Option.getOrUndefined(yield* connections.one(input.connectionId));
      if (existing === undefined) {
        return yield* Effect.fail(
          createValidationError([{ path: ["connectionId"], message: NO_SUCH_CONNECTION }]),
        );
      }
      // A reconnect replaces the connection's tokens, so it must use the
      // connection's own type: tokens from another type's provider would not
      // belong to this connection's account.
      if (existing.type !== input.type) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["connectionId"],
              message: `that connection has the type ${existing.type}, not ${input.type}`,
            },
          ]),
        );
      }
      const given = (["label", "labels", "config"] as const).filter(
        (field) => input[field] !== undefined,
      );
      if (given.length > 0) {
        return yield* Effect.fail(
          createValidationError(
            given.map((field) => ({
              path: [field],
              message: `a reconnect keeps the connection's ${RECONNECT_KEPT_SETTING[field]}`,
            })),
            RECONNECT_KEEPS_SETTINGS,
          ),
        );
      }
      return {
        target: { kind: "reconnect", connectionId: input.connectionId },
        reconnected: existing,
      } as const;
    });

  /**
   * Writes the connection a token flow set up, in one transaction: a new
   * connection, or new tokens for the one a reconnect names. The connection's
   * secrets become the token set alone. Returns how the write ended (see
   * `TokenFlowWriteResult`); a reconnect writes nothing when its connection was
   * deleted while the user was at the provider, or when the tokens belong to
   * another account.
   *
   * A new connection the user did not name gets the account name as its
   * label. A reconnect changes only the account name, which may have been
   * renamed, and the status. It keeps the connection's label, topics and
   * config.
   *
   * `actor` is passed in rather than read, because the redirect flow's
   * callback arrives without a credential.
   *
   * `oauthClientId` is the OAuth client the plugin created for these tokens,
   * stored with them in the same transaction. Without one, the connection
   * keeps no client id, so a reconnect that signs in with a shipped or
   * configured client, or a device flow, clears the id of an earlier created
   * client together with the tokens it belonged to.
   *
   * `credentialsGeneration` is the connection's generation when the
   * reconnect started. A reconnect writes nothing when the generation has
   * moved, so of two sign-ins started from the same credentials the first to
   * finish wins, and a client created for the second is not stored over the
   * first's tokens.
   */
  const writeConnectionFromTokens = ({
    setup,
    connectionType,
    account,
    tokens,
    actor,
    oauthClientId,
    credentialsGeneration,
    onCommitted,
  }: {
    readonly setup: StoredSetupTarget;
    readonly connectionType: RegisteredConnectionType;
    /** The account the type's `validate` returned for the new tokens. */
    readonly account: ExternalAccount;
    readonly tokens: TokenSet;
    readonly actor: string;
    readonly oauthClientId: string | undefined;
    readonly credentialsGeneration: number | undefined;
    /**
     * Runs once the transaction that writes the connection has committed, and
     * never when it rolls back. The caller learns from it that the write is
     * durable even when an interrupt keeps the result from reaching it.
     */
    readonly onCommitted?: () => void;
  }): Effect.Effect<TokenFlowWriteResult, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const now = yield* nowIso;
        const { pluginId, contribution } = connectionType;
        let id: string;
        if (setup.kind === "create") {
          const row = yield* connections.insert({
            pluginId,
            type: setup.type,
            label: setup.label ?? buildDefaultLabel(account.displayName, contribution.displayName),
            displayName: account.displayName,
            accountId: account.accountId,
            ...buildWarningField(account),
            labels: setup.labels,
            config: setup.config,
            ...(oauthClientId === undefined ? {} : { oauthClientId }),
            at: now,
          });
          id = row.id;
        } else {
          // A reconnect keeps the connection's id, so anything that refers to
          // it stays attached; only the account name and the tokens are
          // replaced. The check runs inside the transaction, so nothing is
          // written under an id that no longer exists.
          id = setup.connectionId;
          const existing = Option.getOrUndefined(yield* connections.one(id));
          if (existing === undefined) return { _tag: "connection-gone" } as const;
          if (
            credentialsGeneration !== undefined &&
            existing.credentialsGeneration !== credentialsGeneration
          ) {
            return { _tag: "credentials-replaced" } as const;
          }
          if (isOtherAccount(account, existing)) {
            return {
              _tag: "other-account",
              connectionDisplayName: existing.displayName,
            } as const;
          }
          yield* connections.update(
            id,
            {
              displayName: account.displayName,
              status: "connected",
              statusDetail: null,
              warning: readAccountWarning(account),
              replacesCredentials: true,
              oauthClientId: oauthClientId ?? null,
            },
            now,
          );
        }
        yield* replaceSecrets(id, { [OAUTH_TOKENS]: serializeTokens(tokens) });
        if (onCommitted !== undefined) yield* afterCommit(onCommitted);
        yield* audit.append({
          kind: setup.kind === "create" ? "connection.created" : "connection.credentialsSet",
          actor,
          payload: { connectionId: id, pluginId, type: setup.type, credentials: [OAUTH_TOKENS] },
          record: { topic: "connection", id },
          at: now,
        });
        return {
          _tag: "written",
          connection: yield* Effect.orDie(readConnectionOrFail(id)),
        } as const;
      }),
    );

  /**
   * Checks the values the user pasted for the client a type creates, and
   * returns them, or `undefined` when there is nothing to create a client from.
   *
   * - A type that creates no client takes no values.
   * - A new Connection of a type that creates a client must give a value for
   *   each declared field, and no other. A value that is only whitespace is
   *   empty.
   * - A reconnect may give none, and then uses the Connection's own client. If
   *   it gives values, they are checked like a new Connection's.
   *
   * Fails with `validation`, naming each field that is missing, unknown or
   * empty, and never quoting a value.
   */
  const checkClientValues = (
    contribution: Contribution,
    fields: ReadonlyArray<CredentialField> | undefined,
    given: Record<string, string> | undefined,
    isNew: boolean,
  ): Effect.Effect<Record<string, string> | undefined, Validation> => {
    if (fields === undefined) {
      return given === undefined
        ? Effect.succeed(undefined)
        : Effect.fail(
            createValidationError([
              {
                path: ["clientValues"],
                message: `the type ${contribution.type} creates no OAuth client, so it takes no clientValues`,
              },
            ]),
          );
    }
    const declared = fields.map((field) => field.name);
    if (given === undefined) {
      return isNew
        ? Effect.fail(
            createValidationError([
              {
                path: ["clientValues"],
                message: `give a value for each of ${declared.join(", ")}: ${contribution.displayName} sets up an app of its own for each new Connection`,
              },
            ]),
          )
        : Effect.succeed(undefined);
    }
    const issues = [
      ...fields.flatMap((field) => {
        const value = Object.hasOwn(given, field.name) ? given[field.name] : undefined;
        if (value === undefined) {
          return [
            { path: ["clientValues", field.name], message: `give a value for ${field.label}` },
          ];
        }
        return value.trim() === ""
          ? [{ path: ["clientValues", field.name], message: `${field.label} cannot be empty` }]
          : [];
      }),
      // A key the type does not declare may be a token pasted in the wrong
      // place, so it is never put in a path or a message.
      ...(Object.keys(given).some((name) => !declared.includes(name))
        ? [
            {
              path: ["clientValues"],
              message: `the type ${contribution.type} takes only these fields: ${declared.join(", ")}`,
            },
          ]
        : []),
    ];
    return issues.length === 0 ? Effect.succeed(given) : Effect.fail(createValidationError(issues));
  };

  /**
   * Asks the type's plugin to create the OAuth client for a Connection, from
   * the values the user pasted, and returns it. Runs outside any transaction,
   * because it calls the provider.
   *
   * Fails with `invalid_state` carrying the plugin's own message when the
   * plugin refuses, because the plugin says what to do (a configuration token
   * that has expired, for one). Every value the user pasted is removed from
   * that message first (the fields in `secretFields` at any length, the others
   * from 8 characters), because a provider may echo what it was sent. A plugin
   * that throws, or answers without a client id, fails with a fixed message
   * instead, because the failure may quote what the user pasted.
   */
  const createClient = (
    contribution: Contribution,
    values: Record<string, string>,
    secretFields: ReadonlySet<string>,
  ): Effect.Effect<CreatedOAuthClient, InvalidState> => {
    const create = contribution.createOAuthClient;
    if (create === undefined) {
      return Effect.die(
        new Error(`the type ${contribution.type} creates clients but has no createOAuthClient`),
      );
    }
    return Effect.suspend(() => create(values)).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError((failure) =>
        createInvalidStateError(
          truncateMessage(redactPastedValues(failure.message, values, secretFields)),
        ),
      ),
      Effect.catchDefect(() => Effect.fail(createInvalidStateError(CREATING_CLIENT_FAILED))),
      Effect.filterOrFail(
        (client) => client.clientId !== "",
        () => createInvalidStateError(CREATING_CLIENT_FAILED),
      ),
    );
  };

  /**
   * Finishes a redirect flow from what the browser came back with, and
   * returns the written Connection. It is the one body behind both the
   * controller's callback page and `connection.finishOAuth`. Every way the
   * flow can end without a Connection fails with a `FinishFailure`.
   *
   * `claimant` says who finishes, and so which flows are theirs:
   *
   * - `controller`: the callback page. It has no credential, and finishes only
   *   flows that return to the controller, never one that returns to the
   *   user's machine.
   * - `user-machine`: `connection.finishOAuth`. It finishes only a flow that
   *   returns to the user's machine, and only for the caller that started it,
   *   so a caller who learned a `state` cannot end someone else's sign-in.
   *
   * The caller has already checked that the answer is well formed, so a
   * malformed answer never claims a flow. A flow that is not the claimant's
   * stays open. `callback.address`, when the user pasted a whole address, must
   * be the flow's own redirect address, which is checked before the claim too.
   *
   * The claim deletes the setup row in its own transaction, before anything
   * waits on the provider, so a `state` presented twice finds nothing the
   * second time. The code exchange and the type's `validate` call the
   * provider, so they run outside any transaction. They use the flow's own
   * redirect URI and client, exactly as stored.
   *
   * When the flow created an OAuth client and does not end in a Connection, the
   * client is deleted at the provider.
   */
  const finishSetup = (
    callback: {
      readonly state: string;
      readonly code: string | undefined;
      readonly error: string | undefined;
      readonly address: URL | undefined;
    },
    claimant:
      | { readonly kind: "controller" }
      | { readonly kind: "user-machine"; readonly actor: string },
  ): Effect.Effect<Connection, FinishError> =>
    // The claim, the take of the created client's cleanup and the installing
    // of the cleanup run uninterruptibly, and only the work that waits on the
    // provider is restored to the caller's interruptibility. An interrupt can
    // then never land between the claim and the code that owns the cleanup.
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claim = yield* Effect.orDie(
          pending.claim(callback.state, (setup): FinishFailure | undefined => {
            if (claimant.kind === "controller") {
              return setup.redirectUri === undefined ? undefined : "no-live-attempt";
            }
            if (setup.redirectUri === undefined) return "no-live-attempt";
            if ((setup.actor ?? USER_ACTOR) !== claimant.actor) return "no-live-attempt";
            return callback.address === undefined ||
              isRedirectAddress(callback.address, setup.redirectUri)
              ? undefined
              : "wrong-address";
          }),
        );
        if (claim._tag === "none" || claim._tag === "refused") {
          return yield* Effect.fail({
            failure: claim._tag === "none" ? "no-live-attempt" : claim.reason,
            reusedApp: undefined,
          } as const);
        }
        const setup = claim.setup;
        // The claim deleted the row, so the cleanup of the client the plugin
        // created for it is this finish's now.
        const deleteClient = claim.cleanup;
        const registered = Option.getOrUndefined(yield* types.named(setup.type));
        const publicClient = registered?.contribution.oauth?.publicClient;
        // A reconnect that signs in with the Connection's own app, which the
        // user may have deleted at the provider.
        const reusedApp =
          setup.kind === "reconnect" &&
          deleteClient === undefined &&
          setup.clientId !== undefined &&
          publicClient !== undefined &&
          "createdAtSetup" in publicClient
            ? publicClient.createdAtSetup.fields
            : undefined;

        // Set when the transaction that writes the Connection commits. The
        // cleanup below reads it, because an interrupt can arrive after the
        // commit, and a client that a stored Connection signs in with must
        // never be deleted. A read of the database would not do: an open read
        // snapshot elsewhere can still show the state before the commit.
        let connectionCommitted = false;

        const exchangeAndWrite = Effect.gen(function* () {
          // The provider sent the user back with an error instead of a code:
          // either way there is no code to exchange.
          if (callback.error !== undefined || callback.code === undefined) {
            return yield* Effect.fail("denied" as const);
          }
          const oauth = registered?.contribution.oauth;
          const client =
            registered === undefined || oauth === undefined
              ? Option.none()
              : yield* Effect.orDie(findOAuthClient(registered.pluginId, oauth, setup.clientId));
          // The build no longer declares the type, or the type no longer declares
          // a redirect flow, or no client is left to exchange the code with: a
          // type without a public client keeps its client in its plugin's
          // settings, and those were cleared while the user was at the provider.
          // In every case the code cannot be exchanged.
          if (registered === undefined || oauth === undefined || Option.isNone(client)) {
            return yield* Effect.fail("exchange-failed" as const);
          }

          const tokens = yield* exchangeCode({
            tokenUrl: oauth.tokenUrl,
            client: client.value,
            code: callback.code,
            redirectUri: buildSetupRedirectUri(setup),
            codeVerifier: setup.codeVerifier,
            ...(oauth.resource === undefined ? {} : { resource: oauth.resource }),
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.catch(() => Effect.fail("exchange-failed" as const)),
          );
          const account = yield* registered.contribution
            .validate({ accessToken: tokens.accessToken })
            .pipe(
              Effect.provide(FetchHttpClient.layer),
              Effect.catchTag("ConnectionValidationFailed", () => Effect.fail("rejected" as const)),
            );

          const { result: written, observer: started } = yield* Effect.orDie(
            writeAndStartObserver(
              writeConnectionFromTokens({
                setup,
                connectionType: registered,
                account,
                tokens,
                // The caller that started this setup was authenticated. The browser
                // may come back without a credential, but the actor is still the one
                // who started it. A flow from before the actor was recorded was the
                // user's.
                actor: setup.actor ?? USER_ACTOR,
                oauthClientId: setup.clientId,
                credentialsGeneration: setup.credentialsGeneration,
                onCommitted: () => {
                  connectionCommitted = true;
                },
              }),
              (result) =>
                Effect.map(CurrentActor, (current) =>
                  result._tag === "written" && setup.kind === "create"
                    ? {
                        connection: result.connection,
                        // The controller's callback has no credential, so nobody's
                        // grants can be checked there: the observer is told the
                        // actor is unknown. The starter's own finish passes its own.
                        actor: claimant.kind === "controller" ? NO_ACTOR : current,
                      }
                    : undefined,
                ),
            ),
          );
          if (written._tag === "other-account") {
            return yield* Effect.fail("other-account" as const);
          }
          if (written._tag !== "written") return yield* Effect.fail("connection-changed" as const);
          yield* awaitObserver(started);
          return written.connection;
        });

        // A client the plugin created for this sign-in is useless unless the
        // Connection that stores it was written, so it is deleted at the
        // provider unless the write committed. The decision reads the flag the
        // commit sets and not the exit of this effect, because an interrupt can
        // arrive after the write committed. A reconnect that reused the
        // Connection's own client has nothing to delete.
        return yield* restore(exchangeAndWrite).pipe(
          Effect.mapError((failure): FinishError => ({ failure, reusedApp })),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || deleteClient === undefined || connectionCommitted
              ? Effect.void
              : deleteClient,
          ),
        );
      }),
    );

  return {
    /** Returns one page of connections, optionally filtered by type and by status. */
    query: (
      input: QueryInput,
    ): Effect.Effect<ConnectionPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.query");
        const { limit, cursor, sort, type, status } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const listing = yield* refuseCursor(
          connections.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            type,
            status,
            sort: resolveSortKeys(sort, DEFAULT_SORT),
          }),
        );
        const refs = yield* secrets.refs(
          "connection",
          listing.items.map((row) => row.id),
        );
        const items = listing.items.map((row) =>
          buildConnectionRecord(row, refs.get(row.id) ?? []),
        );
        return {
          items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (
      id: Id,
    ): Effect.Effect<ConnectionDetail, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.read");
        return yield* readConnectionDetailOrFail(id);
      }),

    /**
     * Creates a connection from credentials the user pasted, once the type has
     * validated them. With no label, the connection is named after the account
     * the credentials belong to; with no topics, it has none.
     *
     * Fails with `validation` for a type whose setup has no credentials step,
     * such as one that signs in only through a redirect flow: the message
     * names the operations that set that type up.
     */
    create: (
      input: ConnectionCreateInput,
    ): Effect.Effect<Connection, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const { pluginId, contribution } = yield* readTypeOrFail(decoded.type);
        if (!hasCredentialsStep(contribution)) {
          const message =
            `the type ${decoded.type} takes no pasted credentials, because its setup has no ` +
            `credentials step: ${describeSetupOperations(contribution, "create")}`;
          return yield* Effect.fail(createValidationError([{ path: ["type"], message }], message));
        }
        const config = decoded.config ?? {};
        yield* readConfig(contribution, config);
        const credentials = yield* checkCredentialFields(contribution, decoded.credentials);
        const account = yield* validateCredentials(contribution, credentials);

        const { result: created, observer: started } = yield* writeAndStartObserver(
          withTransaction(
            sql,
            Effect.gen(function* () {
              const at = yield* nowIso;
              const row = yield* connections.insert({
                pluginId,
                type: decoded.type,
                label:
                  decoded.label ?? buildDefaultLabel(account.displayName, contribution.displayName),
                displayName: account.displayName,
                accountId: account.accountId,
                ...buildWarningField(account),
                labels: decoded.labels ?? [],
                config,
                at,
              });
              yield* replaceSecrets(row.id, credentials);
              yield* audit.append({
                kind: "connection.created",
                actor: yield* currentStamp,
                // Credential names only, never values: the Intake views read the
                // audit log, and it is kept for 90 days.
                payload: {
                  connectionId: row.id,
                  pluginId,
                  type: row.type,
                  credentials: Object.keys(credentials),
                },
                record: { topic: "connection", id: row.id },
                at,
              });
              return yield* readConnectionRecord(row);
            }),
          ),
          (connection) => Effect.map(CurrentActor, (actor) => ({ connection, actor })),
        );
        yield* awaitObserver(started);
        return created;
      }),

    /**
     * Updates what the user chose: the label, topics, config, poll intervals
     * and Intake choices. Not the account or status. Returns the Connection
     * with its Intake settings.
     *
     * An Intake choice equal to what the plugin's level gives is dropped, so
     * that kind follows the plugin again. Fails with `validation` for a kind
     * the plugin does not declare, and for any write of Intake choices when
     * the plugin failed to load. Intake choices are not part of what an ingest
     * handle is opened with, so changing them leaves the handle open.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<
      ConnectionDetail,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.update");
        const { id, ...patch } = yield* Effect.mapError(
          decodeUpdate(input),
          createDecodeValidationError,
        );
        const row = yield* readStoredConnectionOrFail(id);
        if (patch.config !== undefined) {
          const { contribution } = yield* readStoredTypeOrFail(row);
          yield* readConfig(contribution, patch.config);
        }
        if (patch.feedIntervals !== undefined) {
          yield* checkFeedIntervals(yield* readStoredTypeOrFail(row), patch.feedIntervals);
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // The choices are checked against the plugin's level inside the
            // transaction, so a plugin write that commits in between cannot
            // make the check drop a choice that now differs from the level.
            const intake =
              patch.intake === undefined
                ? undefined
                : yield* normalizeIntakeOverrides(
                    patch.intake,
                    yield* pluginIntake.readBeforeWrite(row.pluginId),
                  );
            const at = yield* nowIso;
            yield* connections.update(
              id,
              { ...patch, ...(intake === undefined ? {} : { intake }) },
              at,
            );
            yield* audit.append({
              kind: "connection.updated",
              actor: yield* currentStamp,
              payload: { connectionId: id, fields: Object.keys(patch) },
              record: { topic: "connection", id },
              at,
            });
            return yield* readConnectionDetailOrFail(id);
          }),
        );
      }),

    /**
     * Replaces the credentials of an existing connection. This is how the user
     * reconnects a connection that needs reauthentication. The id stays the
     * same, so anything that refers to the connection stays attached.
     *
     * Fails with `invalid_state`, and writes nothing, when the new credentials
     * belong to another account than the connection's: the message names both
     * accounts and says to create a new connection instead.
     */
    setCredentials: (
      input: CredentialsInput,
    ): Effect.Effect<
      Connection,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.setCredentials");
        const decoded = yield* Effect.mapError(
          decodeCredentials(input),
          createDecodeValidationError,
        );
        const row = yield* readStoredConnectionOrFail(decoded.id);
        const { contribution } = yield* readStoredTypeOrFail(row);
        if (!hasCredentialsStep(contribution)) {
          const message =
            `the type ${row.type} takes no pasted credentials, because its setup has no ` +
            `credentials step: ${describeSetupOperations(contribution, "reconnect")}`;
          return yield* Effect.fail(
            createValidationError([{ path: ["credentials"], message }], message),
          );
        }
        const credentials = yield* checkCredentialFields(contribution, decoded.credentials);
        const account = yield* validateCredentials(contribution, credentials);
        if (isOtherAccount(account, row)) {
          return yield* Effect.fail(
            createInvalidStateError(describeOtherAccount(account, row.displayName)),
          );
        }

        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            yield* replaceSecrets(row.id, credentials);
            yield* connections.update(
              row.id,
              {
                displayName: account.displayName,
                status: "connected",
                statusDetail: null,
                warning: readAccountWarning(account),
                replacesCredentials: true,
                oauthClientId: null,
              },
              at,
            );
            yield* audit.append({
              kind: "connection.credentialsSet",
              actor: yield* currentStamp,
              payload: { connectionId: row.id, credentials: Object.keys(credentials) },
              record: { topic: "connection", id: row.id },
              at,
            });
            return yield* readConnectionOrFail(row.id);
          }),
        );
      }),

    /**
     * Loads the choices for one config field from the external account, with
     * the connection's credentials and stored config. Nothing is cached and
     * nothing is written: each call asks the plugin, which calls the account.
     *
     * Fails with:
     *
     * - `validation` when the field does not load its choices from the
     *   account;
     * - `invalid_state` when the plugin is not running (disabled, or failed
     *   to start), the credentials cannot be read, the plugin fails or dies
     *   while listing the choices, returns choices of the wrong shape, or
     *   returns more than `MAX_CONFIG_CHOICES`. The message is the plugin's
     *   own where the plugin failed or died.
     *
     * The choices are cleaned before they are returned: an entry with an empty
     * `value` is dropped, because it cannot be stored as a selection, and of
     * several entries with the same `value` only the first is kept, because a
     * picker with two identical values cannot tell them apart.
     *
     * The credentials are read through the same runtime an ingest read uses,
     * so an expired access token is refreshed first. The plugin is called
     * outside any transaction, because it waits on the network.
     */
    listChoices: (
      input: ListChoicesInput,
    ): Effect.Effect<
      ConnectionChoices,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.listChoices");
        const decoded = yield* Effect.mapError(
          decodeListChoices(input),
          createDecodeValidationError,
        );
        const row = yield* readStoredConnectionOrFail(decoded.id);
        const { contribution } = yield* readStoredTypeOrFail(row);
        const { configSchema, listChoices } = contribution;
        if (
          configSchema === undefined ||
          listChoices === undefined ||
          !listChoiceFields(configSchema).includes(decoded.field)
        ) {
          const message = `the config field ${decoded.field} of the type ${row.type} does not load its choices from the account`;
          return yield* Effect.fail(createValidationError([{ path: ["field"], message }], message));
        }
        if (!(yield* activePlugins.isActive(row.pluginId))) {
          return yield* Effect.fail(
            createInvalidStateError(
              `the plugin ${row.pluginId} is not running (disabled, or failed to start), so it cannot load choices: enable it, or see why it failed in Settings › Plugins`,
            ),
          );
        }
        const credentials = yield* types
          .runtimeFor(row.pluginId)
          .credentials(row.id)
          .pipe(Effect.mapError((error) => createInvalidStateError(error.message)));
        const config = yield* Effect.mapError(decodeAgainst(configSchema, row.config), (error) =>
          createInvalidStateError(
            `the connection's config does not fit its type: ${listDecodeIssues(error)
              .map((issue) => issue.message)
              .join("; ")}`,
          ),
        );
        // `suspend` turns a plugin that throws before it returns an effect
        // into a defect, which is handled like one inside the effect.
        const listed = yield* Effect.suspend(() =>
          listChoices(decoded.field, { credentials, config }),
        ).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError((error) => createInvalidStateError(truncateMessage(error.message))),
          Effect.catchDefect((defect) =>
            Effect.fail(createInvalidStateError(summarizeCause(Cause.die(defect)))),
          ),
        );
        if (listed.length > MAX_CONFIG_CHOICES) {
          return yield* Effect.fail(
            createInvalidStateError(
              `the account has ${String(listed.length)} choices for ${decoded.field}, and a picker holds at most ${String(MAX_CONFIG_CHOICES)}: the field should take a narrower list`,
            ),
          );
        }
        const choices = yield* Effect.mapError(decodeChoices(listed), (error) =>
          createInvalidStateError(
            truncateMessage(
              `the plugin ${row.pluginId} returned choices of the wrong shape: ${listDecodeIssues(error).map(formatIssue).join("; ")}`,
            ),
          ),
        );
        const seen = new Set<string>();
        return {
          choices: choices.filter(({ value }) => {
            if (value === "" || seen.has(value)) return false;
            seen.add(value);
            return true;
          }),
        };
      }),

    /**
     * Starts an OAuth flow: stores everything the finish will need, and
     * returns the authorization URL to send the browser to. No connection
     * exists yet. A flow the user abandons leaves a setup row, which its timer
     * deletes at its deadline when a client was created, and which the routine
     * purge deletes long after it expired otherwise.
     *
     * The browser returns to the redirect URI built from `origin` (the
     * controller's callback path), or to the `redirectUri` the caller gave,
     * which the caller finishes with `finishOAuth`. A type whose plugin ships
     * or creates a public client accepts only the redirect URIs that client
     * registered (`isRegisteredRedirectUri`).
     *
     * For a type whose plugin creates a client for each Connection, the start
     * creates it, from `clientValues` (all of them, for a new Connection; for a
     * reconnect, optional: without them the Connection's own client is used).
     * Everything that can be checked locally is checked first, and the plugin
     * is called outside any transaction. The client is deleted at the provider
     * if the sign-in ends without a Connection (see `pending-oauth-setups`).
     * `clientValues` are handed to the plugin and nowhere else: not to the
     * setup row, the audit log, a log line, an error or the answer.
     *
     * Fails with `validation` when the client values do not match what the
     * type declares. Fails with `invalid_state` when the redirect URI is not one
     * the client registered, when the plugin has no client of its own set up,
     * when a reconnect has no client and no values to create one, or when the
     * plugin could not create the client. In each case nothing is stored.
     */
    startOAuth: (
      input: ConnectionOAuthStartInput,
    ): Effect.Effect<
      ConnectionOAuthStart,
      Unauthenticated | Forbidden | Validation | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.startOAuth");
        const decoded = yield* Effect.mapError(decodeStart(input), createDecodeValidationError);
        const { pluginId, contribution } = yield* readTypeOrFail(decoded.type);
        const oauth = contribution.oauth;
        if (oauth === undefined) {
          const message =
            `the type ${decoded.type} has no redirect flow, because its setup has no oauth ` +
            `step: ${describeSetupOperations(contribution, decoded.connectionId === undefined ? "create" : "reconnect")}`;
          return yield* Effect.fail(createValidationError([{ path: ["type"], message }], message));
        }
        // The input decoded, so exactly one of the two is given.
        const redirectUri =
          decoded.redirectUri ??
          (decoded.origin === undefined
            ? yield* Effect.die(new Error("a start input has neither origin nor redirectUri"))
            : buildRedirectUri(decoded.origin));
        const returnsToUserMachine = decoded.redirectUri !== undefined;
        // A provider matches the redirect URI, and a public client registered
        // only a fixed few. Refusing here means the browser is never sent to a
        // provider that would refuse it.
        const publicClient = oauth.publicClient;
        if (
          publicClient !== undefined &&
          !publicClient.redirectUris.some((registered) =>
            isRegisteredRedirectUri(registered, redirectUri),
          )
        ) {
          return yield* Effect.fail(
            createInvalidStateError(
              returnsToUserMachine
                ? describeUnregisteredReturnAddress(
                    contribution,
                    publicClient.redirectUris,
                    redirectUri,
                  )
                : describeUnregisteredOrigin(
                    contribution,
                    publicClient.redirectUris,
                    decoded.origin ?? "",
                  ),
            ),
          );
        }
        if (publicClient === undefined && returnsToUserMachine) {
          return yield* Effect.fail(
            createInvalidStateError(
              describeUnregisteredReturnAddress(contribution, undefined, redirectUri),
            ),
          );
        }
        const { target, reconnected } = yield* buildSetupTarget(decoded, contribution);
        const clientFields =
          publicClient !== undefined && "createdAtSetup" in publicClient
            ? publicClient.createdAtSetup.fields
            : undefined;
        const clientValues = yield* checkClientValues(
          contribution,
          clientFields,
          decoded.clientValues,
          target.kind === "create",
        );
        // The client the flow signs in with is selected here, once: the client
        // that already exists (the plugin's own, or the Connection's), or, from
        // `clientValues`, one the plugin creates now. Everything that can be
        // refused is refused before the plugin is called.
        const knownClientId = clientFields === undefined ? undefined : reconnected?.oauthClientId;

        // The Connection's credentials generation comes with the connection read
        // above, before the plugin is called, so a sign-in that replaces them
        // while the client is being created makes this one write nothing.
        const credentialsGeneration = reconnected?.credentialsGeneration;
        const state = mintToken();
        // The sign-in's one deadline is sampled before the client is created and
        // is stored with the row, which is what the timer that retires the
        // sign-in waits for.
        const now = yield* nowIso;
        const expiresAt = new Date(Date.parse(now) + SETUP_LIFETIME_MS).toISOString();
        const secretFields = new Set(
          (clientFields ?? []).filter((field) => field.secret === true).map((field) => field.name),
        );
        const { client, created } = yield* clientValues === undefined
          ? Effect.flatMap(findOAuthClient(pluginId, oauth, knownClientId), (found) =>
              Option.isNone(found)
                ? Effect.fail(
                    createInvalidStateError(describeMissingClient(pluginId, clientFields)),
                  )
                : Effect.succeed({ client: found.value, created: undefined }),
            )
          : // The client is kept for cleanup in the same uninterruptible step as
            // its creation, so no interrupt can leave an app at the provider that
            // nothing will delete.
            Effect.uninterruptibleMask((restore) =>
              restore(createClient(contribution, clientValues, secretFields)).pipe(
                Effect.tap((made) => pending.keepCreatedClient(state, made.deleteClient)),
                Effect.map((made) => ({ client: { clientId: made.clientId }, created: made })),
              ),
            );
        const clientId = created?.clientId ?? knownClientId;

        const storeAndBuildUrl = Effect.gen(function* () {
          const codeVerifier = mintToken();
          const stamp = yield* currentStamp;
          yield* pending.publish({
            state,
            type: decoded.type,
            ...target,
            origin: returnsToUserMachine ? new URL(redirectUri).origin : (decoded.origin ?? ""),
            redirectUri: returnsToUserMachine ? redirectUri : undefined,
            clientId,
            actor: stamp,
            credentialsGeneration,
            codeVerifier,
            expiresAt,
            createdAt: now,
          });
          return {
            authorizationUrl: buildAuthorizationUrl(oauth, {
              clientId: client.clientId,
              redirectUri,
              state,
              challenge: computeChallenge(codeVerifier),
            }),
          };
        });

        // A client nothing can sign in with, because the start failed or was
        // interrupted before the sign-in was stored, is deleted at once.
        return yield* storeAndBuildUrl.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || created === undefined ? Effect.void : pending.abandon(state),
          ),
        );
      }),

    /**
     * Finishes the OAuth flow the browser came back from to the controller's
     * callback path, and returns the path to redirect the browser to. The path
     * carries one of the six `Outcome` words, never the provider's own error
     * text. A flow that returns to the user's machine is not finished here: it
     * ends with `finishOAuth`, by the caller that started it.
     *
     * `rawQuery` is the query string of the request, read by the same parser as
     * `finishOAuth` (`parseCallbackQuery`). A query that is not an answer to any
     * flow claims nothing, so a stray or blank request cannot end a flow that is
     * open: one with no `state` or a malformed one ends as `expired`, and one
     * with a blank or both of `code` and `error` as `denied`. The code exchange
     * and the type's `validate` call the provider, so they run outside any
     * transaction.
     */
    completeOAuth: (rawQuery: string): Effect.Effect<string> =>
      Effect.gen(function* () {
        const parsed = parseCallbackQuery(rawQuery);
        const outcome: Outcome =
          parsed._tag === "Refused"
            ? parsed.cause === "no-outcome"
              ? "denied"
              : "expired"
            : yield* finishSetup(parsed, { kind: "controller" }).pipe(
                Effect.as("ok" as const),
                Effect.catch((error) => Effect.succeed(decideCallbackOutcome(error.failure))),
              );
        return `/connections?oauth=${outcome}`;
      }),

    /**
     * Finishes the OAuth flow that `startOAuth` started with a `redirectUri`,
     * from what the browser was sent back with, and returns the Connection.
     * Only the caller that started the flow can finish it, and only once.
     *
     * Fails with `validation` when the text is not a redirect answer, is the
     * address of another flow, or names no flow this caller has open. Fails
     * with `invalid_state` when the flow ends without a Connection: the user
     * declined, the code could not be exchanged, the account was refused, it
     * is another account than the Connection's own, or the Connection changed
     * meanwhile. The messages never quote the text, because it holds a code.
     * Nothing is written in any of those cases.
     */
    finishOAuth: (
      input: ConnectionOAuthFinishInput,
    ): Effect.Effect<
      Connection,
      Unauthenticated | Forbidden | Validation | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.finishOAuth");
        const decoded = yield* Effect.mapError(decodeFinish(input), createDecodeValidationError);
        const parsed = parseCallbackQuery(decoded.callbackQuery);
        if (parsed._tag === "Refused") {
          return yield* Effect.fail(
            createValidationError([{ path: ["callbackQuery"], message: parsed.reason }]),
          );
        }
        return yield* finishSetup(parsed, {
          kind: "user-machine",
          actor: yield* currentStamp,
        }).pipe(Effect.mapError((error) => buildFinishRefusal(error.failure, error.reusedApp)));
      }),

    /**
     * Starts a device flow: asks the provider for a device code, stores it
     * with everything the flow will write, and returns the code the user
     * enters at the provider. No connection exists yet. A flow the user
     * abandons leaves a setup row, which a later start deletes once it has
     * expired.
     *
     * Fails with `validation` when the type has no device flow or the input
     * does not suit it, and with `invalid_state` when the provider refuses to
     * start a flow or cannot be reached. The provider is called before the
     * transaction, never inside it.
     *
     * The flow's lifetime is capped at 30 minutes and the poll interval at 60
     * seconds, whatever the provider sends.
     */
    startDeviceFlow: (
      input: ConnectionDeviceStartInput,
    ): Effect.Effect<
      ConnectionDeviceStart,
      Unauthenticated | Forbidden | Validation | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.startDeviceFlow");
        const decoded = yield* Effect.mapError(
          decodeDeviceStart(input),
          createDecodeValidationError,
        );
        const { contribution } = yield* readTypeOrFail(decoded.type);
        const device = contribution.device;
        if (device === undefined) {
          const message =
            `the type ${decoded.type} has no device flow, because its setup has no device ` +
            `step: ${describeSetupOperations(contribution, decoded.connectionId === undefined ? "create" : "reconnect")}`;
          return yield* Effect.fail(createValidationError([{ path: ["type"], message }], message));
        }
        const { target } = yield* buildSetupTarget(decoded, contribution);
        const code = yield* requestDeviceCode(device).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError((error) => createInvalidStateError(error.message)),
        );

        const now = yield* nowIso;
        const setupId = mintToken();
        const lifetime = Math.min(code.expiresIn, MAX_DEVICE_FLOW_SECONDS);
        const interval = code.interval;
        if (interval >= lifetime) {
          return yield* Effect.fail(createInvalidStateError(describeIntervalPastExpiry(interval)));
        }
        const expiresAt = new Date(Date.parse(now) + lifetime * 1000).toISOString();
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* deviceSetups.deleteExpired(now);
            yield* deviceSetups.insert({
              setupId,
              type: decoded.type,
              ...target,
              deviceCode: code.deviceCode,
              interval,
              // The provider wants one interval before the first poll too.
              nextPollAt: new Date(Date.parse(now) + interval * 1000).toISOString(),
              expiresAt,
              createdAt: now,
            });
          }),
        );
        return {
          setupId,
          userCode: code.userCode,
          verificationUri: code.verificationUri,
          expiresAt,
          interval,
        };
      }),

    /**
     * Returns where a device flow stands, asking the provider at most once.
     * Every way the flow can end is a status in the answer rather than an
     * error.
     *
     * The steps are ordered so that a flow ends only once, and no transaction
     * waits on the provider:
     *
     * 1. A transaction claims the poll. A poll that comes before the
     *    provider's interval has passed answers `pending` without calling the
     *    provider.
     * 2. The device code is exchanged, outside any transaction.
     * 3. When tokens come back, a transaction deletes the setup. If another
     *    poll deleted it first, this one answers `expired`.
     * 4. The type checks the account, up to three times, and the connection
     *    is written. If every check fails, the answer is `failed`: the
     *    approval is spent, so the user has to start again. A reconnect that
     *    signed in to another account also answers `failed`, and writes
     *    nothing.
     */
    pollDeviceFlow: (
      input: ConnectionDevicePollInput,
    ): Effect.Effect<ConnectionDevicePoll, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.pollDeviceFlow");
        const { setupId } = yield* Effect.mapError(
          decodeDevicePoll(input),
          createDecodeValidationError,
        );
        const expired = { status: "expired", message: DEVICE_FLOW_EXPIRED } as const;
        // One exchange per interval, however many polls arrive together:
        // `claimPoll` explains why its transaction makes that hold.
        const claim = yield* withTransaction(sql, deviceSetups.claimPoll(setupId, yield* nowIso));
        if (claim._tag === "expired") return expired;
        if (claim._tag === "early") return { status: "pending", interval: claim.interval } as const;
        const setup = claim.setup;
        const endFlow = withTransaction(sql, deviceSetups.delete(setupId));

        const registered = Option.getOrUndefined(yield* types.named(setup.type));
        const device = registered?.contribution.device;
        // The build no longer declares the type, or no longer gives it a
        // device flow. The device code cannot be exchanged.
        if (registered === undefined || device === undefined) {
          yield* endFlow;
          return {
            status: "failed",
            message: `the type ${setup.type} no longer has a device flow in this build`,
          } as const;
        }

        const exchange = yield* Effect.provide(
          exchangeDeviceCode(device, setup.deviceCode),
          FetchHttpClient.layer,
        );
        switch (exchange.status) {
          case "pending":
          case "unreachable":
            return { status: exchange.status, interval: setup.interval } as const;
          case "slow-down": {
            // RFC 8628 section 3.5: a slow_down adds five seconds for every
            // later poll. A provider that names a longer interval gets it.
            const interval = Math.max(
              exchange.interval ?? 0,
              setup.interval + SLOW_DOWN_STEP_SECONDS,
            );
            const now = yield* nowIso;
            if (Date.parse(now) + interval * 1000 >= Date.parse(setup.expiresAt)) {
              yield* endFlow;
              return { status: "failed", message: describeIntervalPastExpiry(interval) } as const;
            }
            yield* withTransaction(sql, deviceSetups.setInterval(setupId, interval, now));
            return { status: "slow-down", interval } as const;
          }
          case "expired":
          case "denied":
          case "failed":
            yield* endFlow;
            return { status: exchange.status, message: exchange.message } as const;
          case "done":
            break;
        }

        if (!(yield* endFlow)) return expired;
        // The provider will not issue this token again, so a check that fails
        // once is tried again before the approval is given up.
        const account = yield* registered.contribution
          .validate({ accessToken: exchange.tokens.accessToken })
          .pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.retry(ACCOUNT_CHECK_RETRY),
            Effect.result,
          );
        if (Result.isFailure(account)) {
          return {
            status: "failed",
            message:
              `the provider approved the sign-in, but checking the account failed: ` +
              `${account.failure.message}. Start again to get a new code`,
          } as const;
        }
        const { result: written, observer: started } = yield* writeAndStartObserver(
          writeConnectionFromTokens({
            setup,
            connectionType: registered,
            account: account.success,
            tokens: exchange.tokens,
            actor: yield* currentStamp,
            oauthClientId: undefined,
            credentialsGeneration: undefined,
          }),
          (result) =>
            Effect.map(CurrentActor, (actor) =>
              result._tag === "written" && setup.kind === "create"
                ? { connection: result.connection, actor }
                : undefined,
            ),
        );
        switch (written._tag) {
          case "connection-gone":
            return {
              status: "expired",
              message: "the connection this flow was reconnecting has been deleted",
            } as const;
          case "credentials-replaced":
            // Only a redirect flow records a generation to compare, so this
            // answer is for completeness.
            return {
              status: "expired",
              message: "the connection's credentials were replaced while this flow was open",
            } as const;
          case "other-account":
            return {
              status: "failed",
              message: describeOtherAccount(account.success, written.connectionDisplayName),
            } as const;
          case "written":
            yield* awaitObserver(started);
            return { status: "done", connection: written.connection } as const;
        }
      }),

    /**
     * Deletes the connection and every secret it owns, in one transaction,
     * and records the deletion in the audit log. Records the facts that
     * losing what the connection read makes about the things Tasks link
     * (`ConnectionEntityFacts`). Fails with `NotFound` when
     * no connection has the id, and with `InvalidState` while a resource, a
     * trigger or a workflow step still names the connection, because
     * deleting it would break that record.
     *
     * The check runs in the delete's transaction. Otherwise a resource or a
     * workflow saved between the check and the delete would name a
     * connection that no longer exists.
     *
     * The check does not look at every place a workflow can name a
     * Connection, so once the delete commits it tells `ConnectionObserver`,
     * and the stored workflows that still name it are marked invalid.
     */
    delete: (
      id: Id,
    ): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.delete");
        const row = yield* readStoredConnectionOrFail(id);
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const named = yield* references.list(id);
            if (named.length > 0) {
              return yield* Effect.fail(createInvalidStateError(buildNamedByMessage(named)));
            }
            const at = yield* nowIso;
            const owner = buildSecretOwner(id);
            const names =
              (yield* secrets.refs("connection", [id])).get(id)?.map((ref) => ref.name) ?? [];
            yield* Effect.forEach(names, (name) => secrets.delete(owner, name), {
              discard: true,
            });
            yield* entityFacts.recordFactsOfDeletion(id, connections.delete(id));
            yield* audit.append({
              kind: "connection.deleted",
              actor: yield* currentStamp,
              payload: {
                connectionId: id,
                pluginId: row.pluginId,
                type: row.type,
                credentials: names,
              },
              record: { topic: "connection", id },
              at,
            });
          }),
        );
        yield* observer.connectionDeleted();
        return {};
      }).pipe(Effect.catchTag("SecretNameError", Effect.die)),
  };
});

/** The connection service. */
export class ConnectionService extends Context.Service<
  ConnectionService,
  Effect.Success<typeof make>
>()("hercule/controller/connections/ConnectionService") {}

export const ConnectionServiceLayer: Layer.Layer<
  ConnectionService,
  never,
  | SqlClient.SqlClient
  | Secrets
  | AuditLog
  | ConnectionTypes
  | PluginConfigs
  | PluginIntake
  | ConnectionReferences
  | ConnectionEntityFacts
  | ConnectionObserver
  | ActivePlugins
  | PromotionState
> = Layer.effect(ConnectionService)(make);
