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
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { decodeAgainst, type ConnectionValidationFailed } from "@hercule/plugin-host";
import {
  CONNECTION_SORT_FIELDS,
  ConnectionCreateInput,
  ConnectionCredentialsInput,
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
import {
  buildAuthorizationUrl,
  computeChallenge,
  decodeCallback,
  exchangeCode,
  oauthClients,
  OAUTH_TOKENS,
  buildRedirectUri,
  serializeTokens,
  SETUP_LIFETIME_MS,
  type Outcome,
} from "./oauth";
import { PluginConfigs } from "./plugin-configs";
import {
  connectionRepository,
  type ConnectionSortField,
  type StoredConnection,
} from "./repository";
import { ConnectionTypes, type RegisteredConnectionType } from "./runtime";
import { oauthSetupRepository } from "./setups";

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

const NAMED_BY_RESOURCE =
  "a resource still acts through this connection; point the resource at another connection before deleting this one";

/** A connection type as the host registered it: the catalog entry, plus its `validate` function. */
type Contribution = RegisteredConnectionType["contribution"];

/** Returns the names of the credential fields a type's setup asks for. */
const listCredentialFields = (contribution: Contribution): ReadonlyArray<string> =>
  contribution.setup.flatMap((step) =>
    step.kind === "credentials" ? step.fields.map((field) => field.name) : [],
  );

const isOAuthFlow = (contribution: Contribution): boolean =>
  contribution.setup.some((step) => step.kind === "oauth");

const decodeStart = Schema.decodeUnknownEffect(ConnectionOAuthStartInput);

/** Fails an OAuth callback with the outcome to show the user. */
const failWithOutcome = (outcome: Outcome): Effect.Effect<never, Outcome> => Effect.fail(outcome);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const setups = yield* oauthSetupRepository;
  const findOAuthClient = yield* oauthClients;
  const secrets = yield* Secrets;
  const types = yield* ConnectionTypes;
  const audit = yield* AuditLog;

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
  const readCredentials = (
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
   * Stores each credential value as a secret owned by the connection. Field
   * names were checked for the `|` separator when the plugin declared them, and
   * a connection id is a UUID, so the secrets repository never rejects them.
   */
  const writeSecrets = (
    id: string,
    credentials: Record<string, string>,
  ): Effect.Effect<void, SqlError> =>
    Effect.forEach(
      Object.entries(credentials),
      ([name, value]) => secrets.set(buildSecretOwner(id), name, Redacted.make(value)),
      { discard: true },
    ).pipe(Effect.catchTag("SecretNameError", Effect.die));

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

      const credentials = { [OAUTH_TOKENS]: serializeTokens(tokens) };
      const written = yield* Effect.orDie(
        withTransaction(
          sql,
          Effect.gen(function* () {
            const now = yield* nowIso;
            // A reconnect keeps the connection's id, so anything that refers to
            // it stays attached; only the account and the tokens are replaced.
            const reconnected = setup.connectionId;
            // The connection may have been deleted while the user was at the
            // provider. Check inside the transaction, so nothing is written
            // under an id that no longer exists.
            if (reconnected !== undefined && Option.isNone(yield* connections.one(reconnected))) {
              return false;
            }
            const id =
              reconnected === undefined
                ? yield* Effect.map(
                    connections.insert({
                      pluginId: registered.pluginId,
                      type: setup.type,
                      label: setup.label,
                      displayName: account.displayName,
                      labels: setup.labels,
                      config: setup.config,
                      at: now,
                    }),
                    (row) => row.id,
                  )
                : yield* Effect.as(
                    connections.update(
                      reconnected,
                      { displayName: account.displayName, status: "connected", statusDetail: null },
                      now,
                    ),
                    reconnected,
                  );
            yield* writeSecrets(id, credentials);
            yield* audit.append({
              kind: reconnected === undefined ? "connection.created" : "connection.credentialsSet",
              // The user started this setup with an authenticated request. The
              // browser comes back without a credential, but the actor is still
              // the user.
              actor: USER_ACTOR,
              payload: {
                connectionId: id,
                pluginId: registered.pluginId,
                type: setup.type,
                credentials: [OAUTH_TOKENS],
              },
              record: { topic: "connection", id },
              at: now,
            });
            return true;
          }),
        ),
      );
      if (!written) return yield* failWithOutcome("expired");
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
        if (isOAuthFlow(contribution)) {
          const message = `the type ${decoded.type} is set up through its OAuth flow: start it with connection.startOAuth`;
          return yield* Effect.fail(createValidationError([{ path: ["type"], message }], message));
        }
        const config = decoded.config ?? {};
        yield* readConfig(contribution, config);
        const credentials = yield* readCredentials(contribution, decoded.credentials);
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
            yield* writeSecrets(row.id, credentials);
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
        if (isOAuthFlow(contribution)) {
          const message = `the type ${row.type} is reconnected through its OAuth flow: start it with connection.startOAuth`;
          return yield* Effect.fail(
            createValidationError([{ path: ["credentials"], message }], message),
          );
        }
        const credentials = yield* readCredentials(contribution, decoded.credentials);
        const account = yield* validateCredentials(contribution, credentials);

        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            yield* writeSecrets(row.id, credentials);
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
        // A reconnect keeps the label, topics and config the connection already
        // has, so the start does not need them.
        const existing =
          decoded.connectionId === undefined
            ? undefined
            : Option.getOrUndefined(yield* connections.one(decoded.connectionId));
        if (decoded.connectionId !== undefined && existing === undefined) {
          return yield* Effect.fail(
            createValidationError([{ path: ["connectionId"], message: NO_SUCH_CONNECTION }]),
          );
        }
        // A reconnect replaces the connection's tokens, so it must use the
        // connection's own type: tokens from another type's provider would not
        // belong to this connection's account.
        if (existing !== undefined && existing.type !== decoded.type) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["connectionId"],
                message: `that connection has the type ${existing.type}, not ${decoded.type}`,
              },
            ]),
          );
        }
        const label = decoded.label ?? existing?.label;
        const labels = decoded.labels ?? existing?.labels;
        if (label === undefined || labels === undefined) {
          return yield* Effect.fail(
            createValidationError([
              { path: ["label"], message: "a new connection needs a label and a topic" },
            ]),
          );
        }
        const config = decoded.config ?? existing?.config ?? {};
        yield* readConfig(contribution, config);
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
              label,
              labels,
              config,
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
     * Deletes the connection and every secret it owns, in one transaction.
     * Fails with `invalid_state` while a resource still acts through the
     * connection, because deleting it would leave that resource with
     * credentials that no longer exist.
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
            // Check inside the delete's transaction. Otherwise a resource pointed
            // at this connection between the check and the delete would refer to
            // a connection that no longer exists.
            if (yield* connections.namedByResource(id)) {
              return yield* Effect.fail(createInvalidStateError(NAMED_BY_RESOURCE));
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
  SqlClient.SqlClient | Secrets | AuditLog | ConnectionTypes | PluginConfigs
> = Layer.effect(ConnectionService)(make);
