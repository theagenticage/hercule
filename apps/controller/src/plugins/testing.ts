/**
 * Test helpers shared by every plugin test: a running host and a configurable
 * fixture plugin. When each file had its own copy, the copies drifted apart,
 * and a reader had to check what each file had changed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  HOST_API,
  PluginError,
  registerConnectionType,
  registerEventSource,
  registerWorkflowAction,
  type ActionContext,
  type ActivationContext,
  type AuthError,
  type EventSourceContribution,
  type IngestConnection,
  type FeedDeclaration,
  type IngestContext,
  type PollResult,
  type Plugin,
  type PluginCapability,
  type ProviderDefinition,
  type RegistrationHost,
  type WorkflowActionContribution,
} from "@hercule/plugin-host";
import { CurrentActor, type Actor } from "../actor";
import { buildHomePaths, HerculeHome } from "../config";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { NotificationServiceTestLayer } from "../notifications/testing";
import { masterKeyLayer, SecretLayer, secretsLayer } from "../secrets";
import { connectionRepository, ConnectionTypesLayer, type StoredConnection } from "../connections";
import { IngestExecutorLayer } from "../daemon/ingest";
import { nowIso } from "../db";
import { ServingPromotionStateLayer } from "../promotion/testing";
import { PluginConfigsLayer, PluginHostLayer, PluginsLayer } from "./index";

/** Builds a provider definition that supports everything natively. */
export const buildProviderDefinition = (
  id: string,
  defaultConfig: Schema.Json = {},
): ProviderDefinition => ({
  id,
  displayName: `Provider ${id}`,
  binaryName: "harness",
  supportsMultipleInstances: true,
  configSchema: Schema.Struct({ token: Schema.String }),
  defaultConfig,
  declared: {
    steering: "native",
    fork: "native",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "native",
      "full-access": "native",
    },
    mcpPassthrough: "native",
    disallowedTools: "native",
    structuredOutput: "supported",
  },
});

const homes: Array<string> = [];

// Registered on the suite of the file that imports this module, which is the
// only scope that knows when its last stack is no longer used.
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.length = 0;
});

/**
 * Builds the real plugin services on a `:memory:` database, including a real
 * master key file. A plugin's secrets are rows in the secrets table, so the
 * encryption is part of what is tested.
 */
export const buildPluginStack = () => {
  const home = mkdtempSync(join(tmpdir(), "hercule-plugins-"));
  homes.push(home);
  return PluginsLayer.pipe(
    Layer.provideMerge(PluginHostLayer.pipe(Layer.provide(IngestExecutorLayer))),
    Layer.provideMerge(ConnectionTypesLayer),
    Layer.provideMerge(PluginConfigsLayer),
    Layer.provideMerge(SecretLayer),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(NotificationServiceTestLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(ServingPromotionStateLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  );
};

/** The actor every call runs as, the same as a request through the API. */
export const USER: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** Runs an effect as `USER`. */
export const asUser = Effect.provideService(CurrentActor, USER);

export interface Fixture {
  readonly plugin: Plugin;
  /** The `activate` and `deactivate` calls, in the order the plugin received them. */
  readonly calls: Array<string>;
  readonly contexts: Array<ActivationContext>;
  readonly hosts: Array<RegistrationHost>;
  /** Whether an instance the plugin started is still up. */
  running: () => boolean;
}

/**
 * Creates a fixture plugin that behaves as the options say, and records every
 * call it receives. By default the plugin starts and stays up, so a test sets
 * only the options it varies.
 */
export const createPluginFixture = (options: {
  readonly id: string;
  readonly hostApi?: number;
  readonly capabilities?: ReadonlyArray<PluginCapability>;
  readonly configSchema?: Schema.Top;
  /** The providers to register, in order. By default, one provider named after the plugin. */
  readonly definitions?: ReadonlyArray<ProviderDefinition>;
  /** A message to fail `register` with, after registering, where a plugin's own work would go. */
  readonly registerFails?: string;
  /** How many `activate` calls fail before the first one that succeeds. */
  readonly activateFailures?: number;
  /** The message the returned deactivate fails with, when it fails. */
  readonly deactivateFails?: string;
  /** Whether the returned deactivate never returns, like a plugin stuck on a lock. */
  readonly deactivateHangs?: boolean;
  /** Whether the hooks yield, so a second caller can interleave with them. */
  readonly slow?: boolean;
  /** A hook that misbehaves in a way the options above cannot express. */
  readonly register?: Plugin["register"];
}): Fixture => {
  const calls: Array<string> = [];
  const contexts: Array<ActivationContext> = [];
  const hosts: Array<RegistrationHost> = [];
  const definitions = options.definitions ?? [buildProviderDefinition(`${options.id}-provider`)];
  let remainingFailures = options.activateFailures ?? 0;
  let up = false;
  const pause = options.slow === true ? Effect.yieldNow : Effect.void;

  const plugin: Plugin = {
    manifest: {
      id: options.id,
      displayName: `Plugin ${options.id}`,
      hostApi: options.hostApi ?? HOST_API,
      capabilities: options.capabilities ?? ["providers"],
      configSchema: options.configSchema ?? Schema.Struct({}),
    },
    register:
      options.register ??
      ((host) =>
        Effect.gen(function* () {
          hosts.push(host);
          for (const definition of definitions) {
            if (host.providers !== undefined) yield* host.providers.register(definition);
          }
          if (options.registerFails !== undefined) {
            return yield* Effect.fail(new PluginError({ message: options.registerFails }));
          }
        })),
    activate: (ctx) =>
      Effect.suspend(() => {
        calls.push("activate");
        contexts.push(ctx);
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          return Effect.fail(new PluginError({ message: `${options.id} could not start` }));
        }
        up = true;
        return Effect.as(
          pause,
          Effect.suspend(() => {
            calls.push("deactivate");
            if (options.deactivateHangs === true) return Effect.never;
            if (options.deactivateFails !== undefined) {
              return Effect.fail(new PluginError({ message: options.deactivateFails }));
            }
            up = false;
            return pause;
          }),
        );
      }),
  };

  return { plugin, calls, contexts, hosts, running: () => up };
};

/** The workflow action that `notesPlugin` declares, with its unqualified id. */
export const NOTE_APPEND_ACTION: WorkflowActionContribution = {
  id: "note.append",
  displayName: "Append a note",
  description: "Appends one line of text to the notes of the run.",
  input: Schema.Struct({ text: Schema.String, pinned: Schema.optionalKey(Schema.Boolean) }),
  output: Schema.Struct({ noteId: Schema.String }),
  execute: () => Effect.succeed({ noteId: "note-1" }),
};

/** The qualified id a step uses to call `NOTE_APPEND_ACTION`: the host prefixes the plugin id. */
export const NOTE_APPEND_ACTION_ID = "notes/note.append";

/** Builds a plugin that declares one workflow action and does nothing else. */
export const buildActionPlugin = (id: string, action: WorkflowActionContribution): Plugin => ({
  manifest: {
    id,
    displayName: `Plugin ${id}`,
    hostApi: HOST_API,
    capabilities: ["workflow-actions"],
    configSchema: Schema.Struct({}),
  },
  register: (host) => registerWorkflowAction(host, action),
  activate: () => Effect.succeed(Effect.void),
});

/** A plugin with the id `notes` that declares `NOTE_APPEND_ACTION`, for tests of action steps. */
export const notesPlugin: Plugin = buildActionPlugin("notes", NOTE_APPEND_ACTION);

/** The qualified Connection type that `buildForgePlugin` declares. */
export const FORGE_CONNECTION_TYPE = "forge/forge";

/** The qualified id a step uses to call the review action of `buildForgePlugin`. */
export const FORGE_REVIEW_ACTION_ID = "forge/pr.review";

/** The verdicts the forge review action accepts, as a GitHub review does. */
export const FORGE_REVIEW_VERDICTS = ["approve", "request-changes", "comment"] as const;

/** The forge plugin, and every `ActionContext` its review action was called with. */
export interface ForgePlugin {
  readonly plugin: Plugin;
  readonly contexts: ReadonlyArray<ActionContext>;
  /** The decoded input of every call, in the same order as `contexts`. */
  readonly inputs: ReadonlyArray<unknown>;
}

/**
 * Builds a plugin with the id `forge`, for tests of an action that acts
 * through a Connection. It declares:
 *
 * - the Connection type `forge/forge`, set up by pasting a `token`, or
 *   through a redirect flow when `tokenUrl` is given. The redirect flow lets
 *   a test give a Connection a token set whose refresh goes to `tokenUrl`;
 * - the workflow action `forge/pr.review`, which acts through a `forge/forge`
 *   Connection, takes a `verdict` from a fixed list, and records the context
 *   and input of every call.
 *
 * The plugin config accepts `clientId`, which a refresh needs.
 */
export const buildForgePlugin = (options: { readonly tokenUrl?: string } = {}): ForgePlugin => {
  const contexts: Array<ActionContext> = [];
  const inputs: Array<unknown> = [];
  const { tokenUrl } = options;
  const plugin: Plugin = {
    manifest: {
      id: "forge",
      displayName: "Forge",
      hostApi: HOST_API,
      capabilities: ["connections", "workflow-actions"],
      configSchema: Schema.Struct({ clientId: Schema.optionalKey(Schema.String) }),
    },
    register: (host) =>
      Effect.andThen(
        registerConnectionType(host, {
          type: "forge",
          displayName: "Forge",
          setup: [
            { kind: "credentials", fields: [{ name: "token", label: "Token" }] },
            ...(tokenUrl === undefined ? [] : [{ kind: "oauth" as const }]),
          ],
          ...(tokenUrl === undefined
            ? {}
            : { oauth: { authorizationUrl: tokenUrl, tokenUrl, scopes: ["repo"] } }),
          validate: () => Effect.succeed({ displayName: "octocat", accountId: "1" }),
        }),
        registerWorkflowAction(host, {
          id: "pr.review",
          displayName: "Review a pull request",
          description: "Submits a review with a verdict on a pull request.",
          connection: { type: FORGE_CONNECTION_TYPE },
          input: Schema.Struct({
            verdict: Schema.Literals(FORGE_REVIEW_VERDICTS),
            body: Schema.optionalKey(Schema.String),
          }),
          output: Schema.Struct({ reviewed: Schema.Boolean }),
          execute: (input, context) =>
            Effect.sync(() => {
              contexts.push(context);
              inputs.push(input);
              return { reviewed: true };
            }),
        }),
      ),
    activate: () => Effect.succeed(Effect.void),
  };
  return { plugin, contexts, inputs };
};

/**
 * An event source's `open` whose handle polls nothing and closes at once, for
 * a test about anything but ingest.
 */
export const IDLE_INGEST_OPEN: EventSourceContribution["open"] = () =>
  Effect.succeed({ poll: () => Effect.succeed({}), close: Effect.void });

/** The one feed of a source whose handle is `IDLE_INGEST_OPEN`'s: a source must declare one. */
export const IDLE_FEEDS: Record<string, FeedDeclaration> = {
  idle: { defaultIntervalSeconds: 3600 },
};

/** The plugin id, Connection type and event kind of `createEventSourceFixture`'s plugin. */
export const EVENT_SOURCE_FIXTURE = {
  pluginId: "acme",
  connectionType: "acme/acme",
  kind: "acme.thing.done",
} as const;

export interface EventSourceFixture {
  readonly plugin: Plugin;
  /**
   * What the source was asked to do, in order: `open`, `poll <feed>` when a
   * poll starts, `polled <feed>` when it ends, and `close`.
   */
  readonly calls: Array<string>;
  /** The `IngestConnection` and `IngestContext` of every open, in order. */
  readonly opened: Array<{
    readonly connection: IngestConnection;
    readonly context: IngestContext;
  }>;
  /** Decides how each open ends. By default it succeeds. A test replaces it to make opens fail. */
  open: () => Effect.Effect<void, AuthError | PluginError>;
  /** Decides how each poll ends. By default it succeeds with no hint. */
  poll: (feed: string) => Effect.Effect<PollResult, AuthError | PluginError>;
  /** Decides how each close ends. By default it returns at once. */
  close: () => Effect.Effect<void>;
  /** Returns the most polls that were running at one time. */
  readonly countMostPollsAtOnce: () => number;
}

/**
 * Creates a plugin with one Connection type, `acme/acme`, and one event source
 * for it that emits `acme.thing.done`. The source records every call, and a
 * test decides how each open and poll ends by replacing `open` and `poll`.
 */
export const createEventSourceFixture = (
  options: {
    readonly feeds?: Record<string, FeedDeclaration>;
    readonly capabilities?: ReadonlyArray<PluginCapability>;
  } = {},
): EventSourceFixture => {
  let running = 0;
  let most = 0;
  const fixture: EventSourceFixture = {
    calls: [],
    opened: [],
    open: () => Effect.void,
    poll: () => Effect.succeed({}),
    close: () => Effect.void,
    countMostPollsAtOnce: () => most,
    plugin: {
      manifest: {
        id: EVENT_SOURCE_FIXTURE.pluginId,
        displayName: "Acme",
        hostApi: HOST_API,
        capabilities: options.capabilities ?? ["connections", "event-sources", "events"],
        configSchema: Schema.Struct({}),
      },
      register: (host) =>
        Effect.andThen(
          registerConnectionType(host, {
            type: "acme",
            displayName: "Acme",
            setup: [],
            configSchema: Schema.Struct({ project: Schema.optionalKey(Schema.String) }),
            validate: () => Effect.succeed({ displayName: "Acme", accountId: "acme-1" }),
          }),
          registerEventSource(host, {
            id: "acme",
            connectionType: EVENT_SOURCE_FIXTURE.connectionType,
            feeds: options.feeds ?? { notifications: { defaultIntervalSeconds: 60 } },
            kinds: {
              [EVENT_SOURCE_FIXTURE.kind]: {
                description: "Something was done in Acme.",
                schema: Schema.Struct({ title: Schema.String }),
              },
            },
            open: (connection, context) =>
              Effect.suspend(() => {
                fixture.calls.push("open");
                fixture.opened.push({ connection, context });
                return Effect.as(fixture.open(), {
                  poll: (feed: string) =>
                    Effect.suspend(() => {
                      fixture.calls.push(`poll ${feed}`);
                      running += 1;
                      most = Math.max(most, running);
                      return fixture.poll(feed);
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          running -= 1;
                          fixture.calls.push(`polled ${feed}`);
                        }),
                      ),
                    ),
                  close: Effect.suspend(() => {
                    fixture.calls.push("close");
                    return fixture.close();
                  }),
                });
              }),
          }),
        ),
      activate: () => Effect.succeed(Effect.void),
    },
  };
  return fixture;
};

/**
 * Inserts a `connected` Connection of the fixture's type, with the label and
 * feed intervals given, and returns it as the repository reads it back.
 */
export const insertFixtureConnection = (
  options: {
    readonly label?: string;
    readonly feedIntervals?: Readonly<Record<string, number>>;
  } = {},
): Effect.Effect<StoredConnection, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const connections = yield* connectionRepository;
    const at = yield* nowIso;
    const inserted = yield* connections.insert({
      pluginId: EVENT_SOURCE_FIXTURE.pluginId,
      type: EVENT_SOURCE_FIXTURE.connectionType,
      label: options.label ?? "work",
      displayName: "Acme",
      accountId: "acme-1",
      labels: [],
      config: {},
      at,
    });
    if (options.feedIntervals !== undefined) {
      yield* connections.update(inserted.id, { feedIntervals: options.feedIntervals }, at);
    }
    return Option.getOrThrow(yield* connections.one(inserted.id));
  });
