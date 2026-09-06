/**
 * The registry a release ships, as the rest of the system meets it after a
 * boot: the three provider plugins and the capabilities each declares.
 *
 * The declared values are written out in full rather than derived from one
 * another, because they are a pinned table: every affordance the UI offers and
 * every degradation the controller applies is read off them, so one of them
 * changing by accident has to fail here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import type { PluginDetail } from "@hydra/contract";
import { CurrentActor, type Actor } from "../actor";
import { homePaths, HydraHome } from "../config";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { masterKeyLayer, secretsLayer } from "../secrets";
import { PluginHost, PluginHostLayer, Plugins, PluginsLayer } from "./index";
import { registry } from "./registry";

/** The host reads plugin secrets, so the stack needs a home to keep a key file in. */
const HOME = mkdtempSync(join(tmpdir(), "hydra-plugin-registry-"));

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const layer = PluginsLayer.pipe(
  Layer.provideMerge(PluginHostLayer),
  Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
  Layer.provideMerge(Layer.succeed(HydraHome, homePaths(HOME, join(HOME, "data")))),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** Every call runs as the user actor, which is what a request through the API is. */
const run = <A, E>(body: Effect.Effect<A, E, Plugins | PluginHost>) =>
  Effect.runPromise(body.pipe(Effect.provide(layer), Effect.provideService(CurrentActor, USER)));

/** What the derivation makes of a config schema with no settings in it. */
const NO_SETTINGS = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

/**
 * Each row is the whole of what a boot persists for one plugin, written out
 * rather than derived from a neighbour: a copy of the wrong base is exactly the
 * mistake this has to catch.
 */
const SHIPPED = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    definition: {
      id: "claude-code",
      displayName: "Claude Code",
      supportsMultipleInstances: true,
      configSchema: NO_SETTINGS,
      defaultConfig: {},
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
    },
  },
  {
    id: "codex",
    displayName: "Codex",
    definition: {
      id: "codex",
      displayName: "Codex",
      supportsMultipleInstances: true,
      configSchema: NO_SETTINGS,
      defaultConfig: {},
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
        disallowedTools: "unsupported",
        structuredOutput: "supported",
      },
    },
  },
  {
    id: "pi",
    displayName: "pi",
    definition: {
      id: "pi",
      displayName: "pi",
      supportsMultipleInstances: true,
      configSchema: NO_SETTINGS,
      defaultConfig: {},
      declared: {
        steering: "native",
        fork: "native",
        modelSwitch: "in-session",
        accessModes: {
          "approval-required": "native",
          "auto-accept-edits": "native",
          auto: "unsupported",
          "full-access": "native",
        },
        mcpPassthrough: "unsupported",
        disallowedTools: "native",
        structuredOutput: "supported",
      },
    },
  },
];

let details: ReadonlyArray<PluginDetail>;

describe("the shipped registry after a boot", () => {
  beforeAll(async () => {
    details = await run(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot(registry));
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.query());
      }),
    );
  });

  it("holds the three provider plugins and nothing else", () => {
    expect(details.map((detail) => detail.id)).toEqual(["claude-code", "codex", "pi"]);
  });

  it.each(SHIPPED)(
    "$id is active, asks nothing of the user, and contributes its provider",
    ({ id, displayName, definition }) => {
      const detail = details.find((one) => one.id === id);

      expect(detail?.displayName).toBe(displayName);
      expect(detail?.status).toEqual({ _tag: "active" });
      expect(detail?.capabilities).toEqual(["providers"]);
      expect(detail?.configSchema).toEqual(NO_SETTINGS);

      expect(detail?.contributions).toEqual([
        { extensionPoint: "provider", id: definition.id, definition },
      ]);
    },
  );
});
