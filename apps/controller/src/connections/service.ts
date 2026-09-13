/**
 * The `connection.*` operations: one external account, as the user set it up.
 *
 * A connection is core-owned and its type is a plugin contribution, so every
 * write here asks the type two things the core cannot answer itself - whether a
 * config is one it accepts, and whether these credentials work and which
 * account they name.
 *
 * `validate` is a call to the external service. It runs before the transaction
 * and never inside one: a write that waits on the network holds the database
 * for as long as GitHub takes to answer. The cost is that a connection is
 * written only after the account is known, which is what the record says.
 *
 * Credentials go into the one secrets table under owner `connection/<id>`. What
 * comes back out is references: a name and, once it has been replaced, when.
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
import { decodeAgainst, type ConnectionValidationFailed } from "@hydra/plugin-host";
import {
  CONNECTION_SORT_FIELDS,
  ConnectionCreateInput,
  ConnectionCredentialsInput,
  ConnectionOAuthStartInput,
  ConnectionStatus,
  ConnectionUpdateInput,
  DEFAULT_PAGE_LIMIT,
  Id,
  invalidState,
  issuesOf,
  notFound,
  validation,
  validationOf,
  type Connection,
  type ConnectionOAuthStart,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { requireGrant, USER_ACTOR } from "../actor";
import { mintToken } from "../credentials";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { Secrets, type SecretNameRef, type SecretOwner } from "../secrets";
import {
  authorizationUrl,
  challengeFor,
  decodeCallback,
  exchangeCode,
  oauthClients,
  OAUTH_TOKENS,
  redirectUri,
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

/** What listing takes: which connections, how many, in what order. */
const QueryInput = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(ConnectionStatus),
  ...pageInput(CONNECTION_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...ConnectionUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const CredentialsInput = Schema.Struct({ id: Id, ...ConnectionCredentialsInput.fields });

export type CredentialsInput = Schema.Schema.Type<typeof CredentialsInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(ConnectionCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeCredentials = Schema.decodeUnknownEffect(CredentialsInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

/** One page of connections, in the contract's shape. */
export interface ConnectionPage {
  readonly items: ReadonlyArray<Connection>;
  readonly nextCursor?: string;
}

/** Oldest first: the Connections screen reads as the list the user built up. */
const DEFAULT_SORT: { field: ConnectionSortField; direction: SortDirection } = {
  field: "createdAt",
  direction: "asc",
};

const NO_SUCH_CONNECTION = "no such connection";

/** A type as the host registered it: the catalog half, plus its `validate`. */
type Contribution = RegisteredConnectionType["contribution"];

/** The credential fields a type declares, which is what a setup asks for. */
const fieldsOf = (contribution: Contribution): ReadonlyArray<string> =>
  contribution.setup.flatMap((step) =>
    step.kind === "credentials" ? step.fields.map((field) => field.name) : [],
  );

const isOAuthFlow = (contribution: Contribution): boolean =>
  contribution.setup.some((step) => step.kind === "oauth");

const decodeStart = Schema.decodeUnknownEffect(ConnectionOAuthStartInput);

/** A flow that ended before it made a connection, carrying what to say about it. */
const ended = (outcome: Outcome): Effect.Effect<never, Outcome> => Effect.fail(outcome);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const setups = yield* oauthSetupRepository;
  const clientOf = yield* oauthClients;
  const secrets = yield* Secrets;
  const types = yield* ConnectionTypes;
  const audit = yield* AuditLog;

  const ownerOf = (id: string): SecretOwner => ({ kind: "connection", id });

  /** The registered type of this name, if this build defines one. */
  const registeredType = (type: string): Effect.Effect<Option.Option<RegisteredConnectionType>> =>
    Effect.map(types.all(), (registered) =>
      Option.fromUndefinedOr(registered.find((one) => one.contribution.type === type)),
    );

  /** The type a request names, or the `validation` a caller can act on. */
  const typeNamed = (type: string): Effect.Effect<RegisteredConnectionType, Validation> =>
    Effect.flatMap(
      registeredType(type),
      Option.match({
        onNone: () =>
          Effect.fail(
            validation([{ path: ["type"], message: `no plugin defines the type ${type}` }]),
          ),
        onSome: Effect.succeed,
      }),
    );

  /**
   * The type a stored connection names. A row's type was registered when the
   * row was written, so a build that no longer defines it is the build's to fix
   * and nothing the caller can correct by sending something else.
   */
  const typeOf = (row: StoredConnection): Effect.Effect<RegisteredConnectionType, InvalidState> =>
    Effect.flatMap(
      registeredType(row.type),
      Option.match({
        onNone: () =>
          Effect.fail(
            invalidState(`the plugin that defines the type ${row.type} is not in this build`),
          ),
        onSome: Effect.succeed,
      }),
    );

  /**
   * The type's own verdict on a config. A type that declared no schema takes
   * the empty config and nothing else: anything put in it would be config
   * nothing ever reads.
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
            validation([
              {
                path: ["config"],
                message: `the type ${contribution.type} takes no configuration`,
              },
            ]),
          );
    }
    return Effect.asVoid(
      Effect.mapError(decodeAgainst(schema, config), (error) =>
        validation(issuesOf(error).map((issue) => ({ ...issue, path: ["config", ...issue.path] }))),
      ),
    );
  };

  /**
   * Exactly the fields the type declared, and nothing else: a name it does not
   * know would be stored as a secret nothing ever reads back.
   */
  const readCredentials = (
    contribution: Contribution,
    credentials: Record<string, string>,
  ): Effect.Effect<Record<string, string>, Validation> => {
    const declared = fieldsOf(contribution);
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
      : Effect.fail(validation(issues));
  };

  /**
   * Asks the type whether these credentials work. A refusal is shown at the
   * first credential field: it is about the credentials as a whole, and a form
   * needs somewhere to put the message. A type with no field to put it under -
   * a redirect flow - is refused at the group itself.
   */
  const validated = (
    contribution: Contribution,
    credentials: Record<string, string>,
  ): Effect.Effect<{ readonly displayName: string; readonly detail?: string }, Validation> =>
    Effect.mapError(
      Effect.provide(contribution.validate(credentials), FetchHttpClient.layer),
      (failure: ConnectionValidationFailed) => {
        const field = fieldsOf(contribution)[0];
        return validation(
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

  /** A connection as the wire sees it: the row, plus what it owns in `secrets`. */
  const compose = (row: StoredConnection, refs: ReadonlyArray<SecretNameRef>): Connection => ({
    id: row.id,
    pluginId: row.pluginId,
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

  const stored = (id: string): Effect.Effect<StoredConnection, NotFound | SqlError> =>
    Effect.flatMap(
      connections.one(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_CONNECTION)),
        onSome: Effect.succeed,
      }),
    );

  const composed = (row: StoredConnection): Effect.Effect<Connection, SqlError> =>
    Effect.map(secrets.refs("connection", [row.id]), (refs) =>
      compose(row, refs.get(row.id) ?? []),
    );

  const one = (id: string): Effect.Effect<Connection, NotFound | SqlError> =>
    Effect.flatMap(stored(id), composed);

  /**
   * Writes each pasted value under the connection's own owner scope. A field
   * name is the plugin's own and a connection id is a UUID, so neither can hold
   * the separator the secrets repository refuses.
   */
  const writeSecrets = (
    id: string,
    credentials: Record<string, string>,
  ): Effect.Effect<void, SqlError> =>
    Effect.forEach(
      Object.entries(credentials),
      ([name, value]) => secrets.set(ownerOf(id), name, Redacted.make(value)),
      { discard: true },
    ).pipe(Effect.catchTag("SecretNameError", Effect.die));

  /**
   * The callback, as far as it gets. Every way it can end short of a connection
   * is a typed failure carrying the word the user is told, so the path through
   * here reads as the one thing that has to happen.
   */
  const finish = (query: unknown): Effect.Effect<Outcome, Outcome> =>
    Effect.gen(function* () {
      const params = yield* Effect.catchTag(decodeCallback(query), "SchemaError", () =>
        ended("expired"),
      );
      if (params.state === undefined) return yield* ended("expired");
      const at = yield* nowIso;
      // Spent in its own transaction, before anything waits on the provider: a
      // state presented twice must find nothing the second time.
      const pending = yield* Effect.orDie(withTransaction(sql, setups.consume(params.state, at)));
      if (Option.isNone(pending)) return yield* ended("expired");
      const setup = pending.value;
      // The provider sent the user back with a refusal instead of a code, or
      // with neither: either way there is nothing here to spend.
      if (params.error !== undefined || params.code === undefined) {
        return yield* ended("denied");
      }

      const registered = (yield* types.all()).find((one) => one.contribution.type === setup.type);
      const oauth = registered?.contribution.oauth;
      const client =
        registered === undefined
          ? Option.none()
          : yield* Effect.orDie(clientOf(registered.pluginId));
      // A build that no longer declares the type, one where the type name has
      // moved to another plugin since the flow started, or a plugin whose
      // credentials were cleared while the user was at the provider: the code
      // cannot be spent in any of those, which is what the word says.
      if (
        registered === undefined ||
        registered.pluginId !== setup.pluginId ||
        oauth === undefined ||
        Option.isNone(client)
      ) {
        return yield* ended("exchange-failed");
      }

      const tokens = yield* exchangeCode({
        tokenUrl: oauth.tokenUrl,
        client: client.value,
        code: params.code,
        redirectUri: redirectUri(setup.origin),
        codeVerifier: setup.codeVerifier,
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.catch(() => ended("exchange-failed")),
      );
      const account = yield* registered.contribution
        .validate({ accessToken: tokens.accessToken })
        .pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.catchTag("ConnectionValidationFailed", () => ended("rejected")),
        );

      const credentials = { [OAUTH_TOKENS]: serializeTokens(tokens) };
      const written = yield* Effect.orDie(
        withTransaction(
          sql,
          Effect.gen(function* () {
            const now = yield* nowIso;
            // A reconnect keeps its id, so whatever points at this connection
            // stays attached; only the account and the tokens are replaced.
            const reconnected = setup.connectionId;
            // Deleted while the user was at the provider: read inside the
            // transaction, so nothing is written under an id that is gone.
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
              // The setup was started by a request the user made; the browser
              // simply carries it back, with no credential to present.
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
      if (!written) return yield* ended("expired");
      return "ok" as const;
    });

  return {
    /** One page of connections, narrowed by type and by status. */
    query: (
      input: QueryInput,
    ): Effect.Effect<ConnectionPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.query");
        const { limit, cursor, sort, type, status } = yield* Effect.mapError(
          decodeQuery(input),
          validationOf,
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
        const items = listing.items.map((row) => compose(row, refs.get(row.id) ?? []));
        return {
          items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (
      input: Identified,
    ): Effect.Effect<Connection, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* one(id);
      }),

    /**
     * Sets up a connection from credentials the user pasted. An OAuth-flow type
     * has no credentials to paste, so it is refused here and started through
     * the OAuth route instead.
     */
    create: (
      input: ConnectionCreateInput,
    ): Effect.Effect<Connection, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), validationOf);
        const { pluginId, contribution } = yield* typeNamed(decoded.type);
        if (isOAuthFlow(contribution)) {
          const message = `the type ${decoded.type} is set up through its OAuth flow: start it with connection.startOAuth`;
          return yield* Effect.fail(validation([{ path: ["type"], message }], message));
        }
        const config = decoded.config ?? {};
        yield* readConfig(contribution, config);
        const credentials = yield* readCredentials(contribution, decoded.credentials);
        const account = yield* validated(contribution, credentials);

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
              actor: USER_ACTOR,
              // Names only: the log is read by the Intake views and kept for
              // 90 days, and these names are what a value is stored under.
              payload: {
                connectionId: row.id,
                pluginId,
                type: row.type,
                credentials: Object.keys(credentials),
              },
              record: { topic: "connection", id: row.id },
              at,
            });
            return yield* composed(row);
          }),
        );
      }),

    /** Changes what the user chose. The account and the status are not that. */
    update: (
      input: UpdateInput,
    ): Effect.Effect<
      Connection,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.update");
        const { id, ...patch } = yield* Effect.mapError(decodeUpdate(input), validationOf);
        const row = yield* stored(id);
        if (patch.config !== undefined) {
          const { contribution } = yield* typeOf(row);
          yield* readConfig(contribution, patch.config);
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            yield* connections.update(id, patch, at);
            yield* audit.append({
              kind: "connection.updated",
              actor: USER_ACTOR,
              payload: { connectionId: id, fields: Object.keys(patch) },
              record: { topic: "connection", id },
              at,
            });
            return yield* one(id);
          }),
        );
      }),

    /**
     * Replaces the credentials of a connection that is already there, which is
     * what reconnecting one that needs reauthenticating does. The id is kept,
     * so whatever points at this connection stays attached.
     */
    setCredentials: (
      input: CredentialsInput,
    ): Effect.Effect<
      Connection,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.setCredentials");
        const decoded = yield* Effect.mapError(decodeCredentials(input), validationOf);
        const row = yield* stored(decoded.id);
        const { contribution } = yield* typeOf(row);
        if (isOAuthFlow(contribution)) {
          const message = `the type ${row.type} is reconnected through its OAuth flow: start it with connection.startOAuth`;
          return yield* Effect.fail(validation([{ path: ["credentials"], message }], message));
        }
        const credentials = yield* readCredentials(contribution, decoded.credentials);
        const account = yield* validated(contribution, credentials);

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
              actor: USER_ACTOR,
              payload: { connectionId: row.id, credentials: Object.keys(credentials) },
              record: { topic: "connection", id: row.id },
              at,
            });
            return yield* one(row.id);
          }),
        );
      }),

    /**
     * Starts a redirect flow: writes down everything the callback will need and
     * answers where to send the browser. Nothing exists as a connection yet - a
     * flow the user abandons leaves a row that the next start sweeps away.
     */
    startOAuth: (
      input: ConnectionOAuthStartInput,
    ): Effect.Effect<
      ConnectionOAuthStart,
      Unauthenticated | Forbidden | Validation | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.startOAuth");
        const decoded = yield* Effect.mapError(decodeStart(input), validationOf);
        const { pluginId, contribution } = yield* typeNamed(decoded.type);
        const oauth = contribution.oauth;
        if (oauth === undefined) {
          const message = `the type ${decoded.type} is not set up through a redirect flow`;
          return yield* Effect.fail(validation([{ path: ["type"], message }], message));
        }
        // A reconnect keeps what the user already chose, so the start needs
        // neither a label nor a topic to go with it.
        const existing =
          decoded.connectionId === undefined
            ? undefined
            : Option.getOrUndefined(yield* connections.one(decoded.connectionId));
        if (decoded.connectionId !== undefined && existing === undefined) {
          return yield* Effect.fail(
            validation([{ path: ["connectionId"], message: NO_SUCH_CONNECTION }]),
          );
        }
        // Reconnecting replaces one connection's tokens, so the flow has to be
        // the one it was set up through: another type's tokens would be written
        // under an account they say nothing about.
        if (existing !== undefined && existing.type !== decoded.type) {
          return yield* Effect.fail(
            validation([
              {
                path: ["connectionId"],
                message: `that connection is of the type ${existing.type}`,
              },
            ]),
          );
        }
        // The same type name, but owned by another plugin than when the
        // connection was made: only reachable across a rebuild that moved the
        // contribution, and the new owner's tokens are not this account's.
        if (existing !== undefined && existing.pluginId !== pluginId) {
          return yield* Effect.fail(
            validation([
              {
                path: ["connectionId"],
                message: `that connection belongs to the plugin ${existing.pluginId}`,
              },
            ]),
          );
        }
        const label = decoded.label ?? existing?.label;
        const labels = decoded.labels ?? existing?.labels;
        if (label === undefined || labels === undefined) {
          return yield* Effect.fail(
            validation([
              { path: ["label"], message: "a new connection needs a label and a topic" },
            ]),
          );
        }
        const config = decoded.config ?? existing?.config ?? {};
        yield* readConfig(contribution, config);
        const client = yield* clientOf(pluginId);
        if (Option.isNone(client)) {
          return yield* Effect.fail(
            invalidState(
              `the plugin ${pluginId} holds no OAuth client credentials: set its clientId ` +
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
              pluginId,
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
          authorizationUrl: authorizationUrl(oauth, {
            clientId: client.value.clientId,
            redirectUri: redirectUri(decoded.origin),
            state,
            challenge: challengeFor(codeVerifier),
          }),
        };
      }),

    /**
     * Finishes the flow the browser came back from, and answers where to send
     * it. Everything it can say is one of five words: the provider's own error
     * text is not the user's to read off a URL.
     *
     * The exchange and the type's `validate` are calls to the provider, so they
     * run outside the transaction; the pending row is spent before either, so a
     * code presented twice buys nothing the second time.
     */
    completeOAuth: (query: unknown): Effect.Effect<string> =>
      Effect.map(
        Effect.catch(finish(query), (outcome: Outcome) => Effect.succeed(outcome)),
        (outcome) => `/connections?oauth=${outcome}`,
      ),

    /** Removes the connection and every secret it owned, in one transaction. */
    delete: (
      input: Identified,
    ): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | Validation | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("connection.delete");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        const row = yield* stored(id);
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const owner = ownerOf(id);
            const names =
              (yield* secrets.refs("connection", [id])).get(id)?.map((ref) => ref.name) ?? [];
            yield* Effect.forEach(names, (name) => secrets.delete(owner, name), {
              discard: true,
            });
            yield* connections.delete(id);
            yield* audit.append({
              kind: "connection.deleted",
              actor: USER_ACTOR,
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
>()("hydra/controller/connections/ConnectionService") {}

export const ConnectionServiceLayer: Layer.Layer<
  ConnectionService,
  never,
  SqlClient.SqlClient | Secrets | AuditLog | ConnectionTypes | PluginConfigs
> = Layer.effect(ConnectionService)(make);
