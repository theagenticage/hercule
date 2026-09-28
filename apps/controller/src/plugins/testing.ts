/**
 * Test helpers shared by every plugin test: a running host and a configurable
 * fixture plugin. When each file had its own copy, the copies drifted apart,
 * and a reader had to check what each file had changed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { Effect, Layer, Schema } from "effect";
import {
  HOST_API,
  PluginError,
  registerWorkflowAction,
  type ActivationContext,
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
import { NotificationServiceLayer } from "../notifications";
import { masterKeyLayer, SecretLayer, secretsLayer } from "../secrets";
import { ConnectionTypesLayer } from "../connections";
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
    Layer.provideMerge(PluginHostLayer),
    Layer.provideMerge(ConnectionTypesLayer),
    Layer.provideMerge(PluginConfigsLayer),
    Layer.provideMerge(SecretLayer),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(NotificationServiceLayer),
    Layer.provideMerge(AuditLogLayer),
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
