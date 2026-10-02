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
 * Credentials are stored in the secrets table under the owner
 * `connection/<id>`. The API returns only references to them: each name, and
 * when the value was last replaced.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { decodeAgainst, type ConnectionValidationFailed } from "@hercule/plugin-host";
import {
  CONNECTION_SORT_FIELDS,
  ConnectionCreateInput,
  ConnectionCredentialsInput,
  ConnectionDevicePollInput,
  ConnectionDeviceStartInput,
  ConnectionOAuthStartInput,
  ConnectionStatus,
  ConnectionUpdateInput,
  DEFAULT_PAGE_LIMIT,
  Id,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  listDecodeIssues,
  type Connection,
  type ConnectionDevicePoll,
  type ConnectionDeviceStart,
  type ConnectionOAuthStart,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant, USER_ACTOR } from "../actor";
import { mintToken } from "../credentials";
import { nowIso, buildPageInputFields, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { Secrets, type SecretNameRef, type SecretOwner } from "../secrets";
import { deviceSetupRepository } from "./device-setups";
import {
  buildAuthorizationUrl,
  computeChallenge,
  decodeCallback,
  exchangeCode,
  exchangeDeviceCode,
  oauthClients,
  OAUTH_TOKENS,
  buildRedirectUri,
  requestDeviceCode,
  serializeTokens,
  SETUP_LIFETIME_MS,
  SLOW_DOWN_STEP_SECONDS,
  type Outcome,
  type TokenSet,
} from "./oauth";
import { PluginConfigs } from "./plugin-configs";
import { ConnectionReferences, type ConnectionReference } from "./references";
import {
  connectionRepository,
  type ConnectionSortField,
  type StoredConnection,
} from "./repository";
import { ConnectionTypes, type RegisteredConnectionType } from "./runtime";
import { oauthSetupRepository } from "./oauth-setups";

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

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(ConnectionCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeCredentials = Schema.decodeUnknownEffect(CredentialsInput);

/** One page of connections, in the contract's shape. */
export interface ConnectionPage {
  readonly items: ReadonlyArray<Connection>;
  readonly nextCursor?: string;
}

/** Oldest first, so the Connections screen lists connections in the order the user added them. */
const DEFAULT_SORT: { field: ConnectionSortField; direction: SortDirection } = {
  field: "createdAt",
  direction: "asc",
};

const NO_SUCH_CONNECTION = "no such connection";

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

/** Returns the operation that starts a type's token flow, for a refusal to point the user to. */
const nameTokenFlowStart = (contribution: Contribution): string =>
  contribution.device === undefined ? "connection.startOAuth" : "connection.startDeviceFlow";

const decodeStart = Schema.decodeUnknownEffect(ConnectionOAuthStartInput);
const decodeDeviceStart = Schema.decodeUnknownEffect(ConnectionDeviceStartInput);
const decodeDevicePoll = Schema.decodeUnknownEffect(ConnectionDevicePollInput);

/** What a token flow writes when it creates a connection, or keeps when it reconnects one. */
interface SetupTarget {
  readonly label: string;
  readonly labels: ReadonlyArray<string>;
  readonly config: Record<string, Schema.Json>;
}

/** The answer to a poll of a device flow that is unknown, already ended, or expired. */
const DEVICE_FLOW_EXPIRED = "this device flow has ended or expired: start a new one";

/** Fails an OAuth callback with the outcome to show the user. */
const failWithOutcome = (outcome: Outcome): Effect.Effect<never, Outcome> => Effect.fail(outcome);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const setups = yield* oauthSetupRepository;
  const deviceSetups = yield* deviceSetupRepository;
  const findOAuthClient = yield* oauthClients;
  const secrets = yield* Secrets;
  const types = yield* ConnectionTypes;
  const audit = yield* AuditLog;
  const references = yield* ConnectionReferences;

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
   * Asks the type whether these credentials work, and returns the account's
   * display name. When they do not work, fails with `validation` at the first
   * credential field: the error is about the credentials as a whole, but a form
   * needs a field to show the message under. A type with no credential fields,
   * such as an OAuth type, gets the error at `credentials` itself.
   */
  const validateCredentials = (
    contribution: Contribution,
    credentials: Record<string, string>,
  ): Effect.Effect<{ readonly displayName: string; readonly detail?: string }, Validation> =>
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
    labels: row.labels,
    config: row.config,
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
        held.filter((ref) => !(ref.name in credentials)),
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
   * Returns the label, topics and config a token flow will write, after
   * checking the input that starts it. A new connection takes them from the
   * input. A reconnect keeps what the connection already has, unless the
   * input replaces it.
   *
   * Fails with `validation` when the reconnected connection does not exist or
   * has another type, when a new connection has no label or no topic, or when
   * the config does not suit the type.
   */
  const readSetupTarget = (
    input: {
      readonly type: string;
      readonly label?: string;
      readonly labels?: ReadonlyArray<string>;
      readonly config?: Record<string, Schema.Json>;
      readonly connectionId?: string;
    },
    contribution: Contribution,
  ): Effect.Effect<SetupTarget, Validation | SqlError> =>
    Effect.gen(function* () {
      const existing =
        input.connectionId === undefined
          ? undefined
          : Option.getOrUndefined(yield* connections.one(input.connectionId));
      if (input.connectionId !== undefined && existing === undefined) {
        return yield* Effect.fail(
          createValidationError([{ path: ["connectionId"], message: NO_SUCH_CONNECTION }]),
        );
      }
      // A reconnect replaces the connection's tokens, so it must use the
      // connection's own type: tokens from another type's provider would not
      // belong to this connection's account.
      if (existing !== undefined && existing.type !== input.type) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["connectionId"],
              message: `that connection has the type ${existing.type}, not ${input.type}`,
            },
          ]),
        );
      }
      const label = input.label ?? existing?.label;
      const labels = input.labels ?? existing?.labels;
      if (label === undefined || labels === undefined) {
        return yield* Effect.fail(
          createValidationError([
            { path: ["label"], message: "a new connection needs a label and a topic" },
          ]),
        );
      }
      const config = input.config ?? existing?.config ?? {};
      yield* readConfig(contribution, config);
      return { label, labels, config };
    });

  /**
   * Writes the connection a token flow set up, in one transaction: a new
   * connection, or new tokens and account for the one a reconnect names. The
   * connection's secrets become the token set alone. Returns the connection,
   * or `None` when the connection being reconnected was deleted while the
   * user was at the provider; nothing is written then.
   *
   * `actor` is passed in rather than read, because the redirect flow's
   * callback arrives without a credential.
   */
  const writeTokenConnection = (
    setup: SetupTarget & { readonly type: string; readonly connectionId: string | undefined },
    pluginId: string,
    displayName: string,
    tokens: TokenSet,
    actor: string,
  ): Effect.Effect<Option.Option<Connection>, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const now = yield* nowIso;
        // A reconnect keeps the connection's id, so anything that refers to
        // it stays attached; only the account and the tokens are replaced.
        const reconnected = setup.connectionId;
        // Checked inside the transaction, so nothing is written under an id
        // that no longer exists.
        if (reconnected !== undefined && Option.isNone(yield* connections.one(reconnected))) {
          return Option.none();
        }
        const id =
          reconnected === undefined
            ? yield* Effect.map(
                connections.insert({
                  pluginId,
                  type: setup.type,
                  label: setup.label,
                  displayName,
                  labels: setup.labels,
                  config: setup.config,
                  at: now,
                }),
                (row) => row.id,
              )
            : yield* Effect.as(
                connections.update(
                  reconnected,
                  { displayName, status: "connected", statusDetail: null },
                  now,
                ),
                reconnected,
              );
        yield* replaceSecrets(id, { [OAUTH_TOKENS]: serializeTokens(tokens) });
        yield* audit.append({
          kind: reconnected === undefined ? "connection.created" : "connection.credentialsSet",
          actor,
          payload: { connectionId: id, pluginId, type: setup.type, credentials: [OAUTH_TOKENS] },
          record: { topic: "connection", id },
          at: now,
        });
        return Option.some(yield* Effect.orDie(readConnectionOrFail(id)));
      }),
    );

  /**
   * Handles the OAuth callback, and returns `ok` once the connection is
   * written. Every way the flow can end early is a failure carrying the outcome
   * to show the user, so the code below reads as the successful path.
   */
  const finishOAuthCallback = (query: unknown): Effect.Effect<Outcome, Outcome> =>
    Effect.gen(function* () {
      const params = yield* Effect.catchTag(decodeCallback(query), "SchemaError", () =>
        failWithOutcome("expired"),
      );
      if (params.state === undefined) return yield* failWithOutcome("expired");
      const at = yield* nowIso;
      // Consume the setup in its own transaction, before anything waits on the
      // provider, so a state presented twice finds nothing the second time.
      const pending = yield* Effect.orDie(withTransaction(sql, setups.consume(params.state, at)));
      if (Option.isNone(pending)) return yield* failWithOutcome("expired");
      const setup = pending.value;
      // The provider sent the user back with an error instead of a code, or
      // with neither: either way there is no code to exchange.
      if (params.error !== undefined || params.code === undefined) {
        return yield* failWithOutcome("denied");
      }

      const registered = Option.getOrUndefined(yield* types.named(setup.type));
      const oauth = registered?.contribution.oauth;
      const client =
        registered === undefined
          ? Option.none()
          : yield* Effect.orDie(findOAuthClient(registered.pluginId));
      // The build no longer declares the type, or the plugin's client
      // credentials were cleared while the user was at the provider. Either way
      // the code cannot be exchanged.
      if (registered === undefined || oauth === undefined || Option.isNone(client)) {
        return yield* failWithOutcome("exchange-failed");
      }

      const tokens = yield* exchangeCode({
        tokenUrl: oauth.tokenUrl,
        client: client.value,
        code: params.code,
        redirectUri: buildRedirectUri(setup.origin),
        codeVerifier: setup.codeVerifier,
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.catch(() => failWithOutcome("exchange-failed")),
      );
      const account = yield* registered.contribution
        .validate({ accessToken: tokens.accessToken })
        .pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.catchTag("ConnectionValidationFailed", () => failWithOutcome("rejected")),
        );

      const written = yield* Effect.orDie(
        writeTokenConnection(
          setup,
          registered.pluginId,
          account.displayName,
          tokens,
          // The user started this setup with an authenticated request. The
          // browser comes back without a credential, but the actor is still
          // the user.
          USER_ACTOR,
        ),
      );
      if (Option.isNone(written)) return yield* failWithOutcome("expired");
      return "ok" as const;
    });

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
        const order =
          sort === undefined
            ? DEFAULT_SORT
            : { field: sort.field, direction: sort.direction ?? "asc" };
        const listing = yield* refuseCursor(
          connections.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            type,
            status,
            ...order,
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

    read: (id: Id): Effect.Effect<Connection, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.read");
        return yield* readConnectionOrFail(id);
      }),

    /**
     * Creates a connection from credentials the user pasted, once the type has
     * validated them. Fails with `validation` for an OAuth type, which has no
     * credentials to paste: that type is set up with `connection.startOAuth`.
     */
    create: (
      input: ConnectionCreateInput,
    ): Effect.Effect<Connection, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const { pluginId, contribution } = yield* readTypeOrFail(decoded.type);
        if (!hasCredentialsStep(contribution)) {
          const message = `the type ${decoded.type} takes no pasted credentials: set it up with ${nameTokenFlowStart(contribution)}`;
          return yield* Effect.fail(createValidationError([{ path: ["type"], message }], message));
        }
        const config = decoded.config ?? {};
        yield* readConfig(contribution, config);
        const credentials = yield* checkCredentialFields(contribution, decoded.credentials);
        const account = yield* validateCredentials(contribution, credentials);

        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const row = yield* connections.insert({
              pluginId,
              type: decoded.type,
              label: decoded.label,
              displayName: account.displayName,
              labels: decoded.labels,
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
        );
      }),

    /** Updates what the user chose: the label, topics and config. Not the account or status. */
    update: (
      input: UpdateInput,
    ): Effect.Effect<
      Connection,
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
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            yield* connections.update(id, patch, at);
            yield* audit.append({
              kind: "connection.updated",
              actor: yield* currentStamp,
              payload: { connectionId: id, fields: Object.keys(patch) },
              record: { topic: "connection", id },
              at,
            });
            return yield* readConnectionOrFail(id);
          }),
        );
      }),

    /**
     * Replaces the credentials of an existing connection. This is how the user
     * reconnects a connection that needs reauthentication. The id stays the
     * same, so anything that refers to the connection stays attached.
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
          const message = `the type ${row.type} takes no pasted credentials: reconnect it with ${nameTokenFlowStart(contribution)}`;
          return yield* Effect.fail(
            createValidationError([{ path: ["credentials"], message }], message),
          );
        }
        const credentials = yield* checkCredentialFields(contribution, decoded.credentials);
        const account = yield* validateCredentials(contribution, credentials);

        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            yield* replaceSecrets(row.id, credentials);
            yield* connections.update(
              row.id,
              { displayName: account.displayName, status: "connected", statusDetail: null },
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
     * Starts an OAuth flow: stores everything the callback will need, and
     * returns the authorization URL to send the browser to. No connection
     * exists yet. A flow the user abandons leaves a setup row, which a later
     * start deletes once it has expired.
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
          const message = `the type ${decoded.type} is not set up through an OAuth flow: create it with connection.create`;
          return yield* Effect.fail(createValidationError([{ path: ["type"], message }], message));
        }
        const target = yield* readSetupTarget(decoded, contribution);
        const client = yield* findOAuthClient(pluginId);
        if (Option.isNone(client)) {
          return yield* Effect.fail(
            createInvalidStateError(
              `the plugin ${pluginId} has no OAuth client credentials: set its clientId ` +
                `config field and its clientSecret secret before connecting`,
            ),
          );
        }

        const at = yield* nowIso;
        const state = mintToken();
        const codeVerifier = mintToken();
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* setups.sweep(at);
            yield* setups.insert({
              state,
              type: decoded.type,
              connectionId: decoded.connectionId,
              ...target,
              origin: decoded.origin,
              codeVerifier,
              expiresAt: new Date(Date.parse(at) + SETUP_LIFETIME_MS).toISOString(),
              at,
            });
          }),
        );
        return {
          authorizationUrl: buildAuthorizationUrl(oauth, {
            clientId: client.value.clientId,
            redirectUri: buildRedirectUri(decoded.origin),
            state,
            challenge: computeChallenge(codeVerifier),
          }),
        };
      }),

    /**
     * Finishes the OAuth flow the browser came back from, and returns the path
     * to redirect the browser to. The path carries one of the five `Outcome`
     * words, never the provider's own error text.
     *
     * The code exchange and the type's `validate` call the provider, so they run
     * outside any transaction. The setup row is deleted before either runs, so a
     * state presented twice does nothing the second time.
     */
    completeOAuth: (query: unknown): Effect.Effect<string> =>
      Effect.map(
        Effect.catch(finishOAuthCallback(query), (outcome: Outcome) => Effect.succeed(outcome)),
        (outcome) => `/connections?oauth=${outcome}`,
      ),

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
          const message = `the type ${decoded.type} has no device flow`;
          return yield* Effect.fail(createValidationError([{ path: ["type"], message }], message));
        }
        const target = yield* readSetupTarget(decoded, contribution);
        const code = yield* requestDeviceCode(device).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError((error) => createInvalidStateError(error.message)),
        );

        const at = yield* nowIso;
        const setupId = mintToken();
        const expiresAt = new Date(Date.parse(at) + code.expiresIn * 1000).toISOString();
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* deviceSetups.sweep(at);
            yield* deviceSetups.insert({
              setupId,
              type: decoded.type,
              connectionId: decoded.connectionId,
              ...target,
              deviceCode: code.deviceCode,
              interval: code.interval,
              // The provider wants one interval before the first poll too.
              nextPollAt: new Date(Date.parse(at) + code.interval * 1000).toISOString(),
              expiresAt,
              at,
            });
          }),
        );
        return {
          setupId,
          userCode: code.userCode,
          verificationUri: code.verificationUri,
          expiresAt,
          interval: code.interval,
        };
      }),

    /**
     * Asks the provider once whether the user has approved a device flow, and
     * returns where the flow stands. Every way the flow can end is a status in
     * the answer rather than an error.
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
     * 4. The type checks the account, and the connection is written.
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
        const claim = yield* withTransaction(sql, deviceSetups.claimPoll(setupId, yield* nowIso));
        if (claim._tag === "expired") return expired;
        if (claim._tag === "early") return { status: "pending", interval: claim.interval } as const;
        const setup = claim.setup;
        const endFlow = withTransaction(sql, deviceSetups.spend(setupId));

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
            const interval = exchange.interval ?? setup.interval + SLOW_DOWN_STEP_SECONDS;
            yield* withTransaction(sql, deviceSetups.slowDown(setupId, interval, yield* nowIso));
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
        const account = yield* Effect.result(
          Effect.provide(
            registered.contribution.validate({ accessToken: exchange.tokens.accessToken }),
            FetchHttpClient.layer,
          ),
        );
        if (Result.isFailure(account)) {
          return { status: "rejected", message: account.failure.message } as const;
        }
        const written = yield* writeTokenConnection(
          setup,
          registered.pluginId,
          account.success.displayName,
          exchange.tokens,
          yield* currentStamp,
        );
        return Option.match(written, {
          onNone: () => ({
            status: "expired" as const,
            message: "the connection this flow was reconnecting has been deleted",
          }),
          onSome: (connection) => ({ status: "done" as const, connection }),
        });
      }),

    /**
     * Deletes the connection and every secret it owns, in one transaction,
     * and records the deletion in the audit log. Fails with `NotFound` when
     * no connection has the id, and with `InvalidState` while a resource or a
     * trigger still names the connection, because deleting it would break
     * that record.
     *
     * The check runs in the delete's transaction. Otherwise a resource or a
     * workflow saved between the check and the delete would name a
     * connection that no longer exists.
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
            yield* connections.delete(id);
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
  SqlClient.SqlClient | Secrets | AuditLog | ConnectionTypes | PluginConfigs | ConnectionReferences
> = Layer.effect(ConnectionService)(make);
