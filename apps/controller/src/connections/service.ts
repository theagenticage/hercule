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
import type { ConnectionValidationFailed } from "@hydra/plugin-host";
import {
  CONNECTION_SORT_FIELDS,
  ConnectionCreateInput,
  ConnectionCredentialsInput,
  ConnectionStatus,
  ConnectionUpdateInput,
  DEFAULT_PAGE_LIMIT,
  Id,
  issuesOf,
  notFound,
  validation,
  validationOf,
  type Connection,
  type Forbidden,
  type NotFound,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { requireGrant, USER_ACTOR } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost, type RegisteredConnectionType } from "../plugins";
import { Secrets, type SecretOwner } from "../secrets";
import {
  connectionRepository,
  type ConnectionSortField,
  type StoredConnection,
} from "./repository";

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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const secrets = yield* Secrets;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;

  const ownerOf = (id: string): SecretOwner => ({ kind: "connection", id });

  /** The type a request names, or the `validation` a caller can act on. */
  const typeNamed = (type: string): Effect.Effect<RegisteredConnectionType, Validation> =>
    Effect.flatMap(host.connectionTypes(), (registered) => {
      const found = registered.find((one) => one.contribution.type === type);
      return found === undefined
        ? Effect.fail(
            validation([{ path: ["type"], message: `no plugin defines the type ${type}` }]),
          )
        : Effect.succeed(found);
    });

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
      Effect.mapError(
        // Every issue at once, and an unknown key refused rather than dropped,
        // so a form puts each message under its own field.
        Schema.decodeUnknownEffect(schema as Schema.Codec<unknown>, {
          errors: "all",
          onExcessProperty: "error",
        })(config),
        (error) =>
          validation(
            issuesOf(error).map((issue) => ({ ...issue, path: ["config", ...issue.path] })),
          ),
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
        .filter((name) => (credentials[name] ?? "") === "")
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
   * needs somewhere to put the message.
   */
  const validated = (
    contribution: Contribution,
    credentials: Record<string, string>,
  ): Effect.Effect<{ readonly displayName: string; readonly detail?: string }, Validation> =>
    Effect.mapError(
      Effect.provide(contribution.validate(credentials), FetchHttpClient.layer),
      (failure: ConnectionValidationFailed) =>
        validation(
          [{ path: ["credentials", fieldsOf(contribution)[0] ?? ""], message: failure.message }],
          failure.message,
        ),
    );

  /** A connection as the wire sees it: the row, plus what it owns in `secrets`. */
  const compose = (row: StoredConnection): Effect.Effect<Connection, SqlError> =>
    Effect.map(secrets.refs(ownerOf(row.id)), (refs) => ({
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
    }));

  const stored = (id: string): Effect.Effect<StoredConnection, NotFound | SqlError> =>
    Effect.flatMap(
      connections.one(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_CONNECTION)),
        onSome: Effect.succeed,
      }),
    );

  const one = (id: string): Effect.Effect<Connection, NotFound | SqlError> =>
    Effect.flatMap(stored(id), compose);

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
        const items = yield* Effect.forEach(listing.items, compose);
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
            return yield* compose(row);
          }),
        );
      }),

    /** Changes what the user chose. The account and the status are not that. */
    update: (
      input: UpdateInput,
    ): Effect.Effect<Connection, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.update");
        const { id, ...patch } = yield* Effect.mapError(decodeUpdate(input), validationOf);
        const row = yield* stored(id);
        if (patch.config !== undefined) {
          const { contribution } = yield* typeNamed(row.type);
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
    ): Effect.Effect<Connection, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("connection.setCredentials");
        const decoded = yield* Effect.mapError(decodeCredentials(input), validationOf);
        const row = yield* stored(decoded.id);
        const { contribution } = yield* typeNamed(row.type);
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
            const names = yield* secrets.names(owner);
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
  SqlClient.SqlClient | Secrets | AuditLog | PluginHost
> = Layer.effect(ConnectionService)(make);
