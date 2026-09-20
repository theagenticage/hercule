/**
 * The registry a release ships, as the rest of the system meets it after a boot.
 * The declared values are written out in full rather than derived from one
 * another: every affordance the UI offers is read off them, so one changing by
 * accident has to fail here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { PluginDetail } from "@hercule/contract";
import { PluginHost, Plugins, registry } from "./index";
import { asUser, pluginStack } from "./testing";

/** Every call runs on a stack of its own, as the user a request would arrive as. */
const run = <A, E>(body: Effect.Effect<A, E, Plugins | PluginHost>) =>
  Effect.runPromise(body.pipe(Effect.provide(pluginStack()), asUser));

/** What the derivation makes of a config schema with no settings in it. */
const NO_SETTINGS = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

/** What pi says the Z.ai key is, in the plugin's own words. */
const ZAI_KEY_DESCRIPTION =
  "From your Z.ai Coding Plan subscription. It is stored on the controller and " +
  "sent to whichever machine runs a thread, so it is entered once and works on " +
  "every machine.";

/** Written out rather than derived: a copy of the wrong base is the mistake this catches. */
const SHIPPED = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    definition: {
      id: "claude-code",
      displayName: "Claude Code",
      binaryName: "claude",
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
      binaryName: "codex",
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
      binaryName: "pi",
      supportsMultipleInstances: true,
      // The one provider with a setting: the Z.ai key, which is entered in a
      // masked form and stored outside the config it is declared in.
      configSchema: {
        type: "object",
        properties: {
          zaiApiKey: {
            type: "string",
            title: "Z.ai API key",
            description: ZAI_KEY_DESCRIPTION,
            "x-secret": true,
          },
        },
        // Not required: a secret-valued field's value lives in the secrets
        // table, so a stored config is complete without it.
        required: [],
        additionalProperties: false,
      },
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

  it("holds the three provider plugins and the github connection type, in registry order", () => {
    expect(details.map((detail) => detail.id)).toEqual(["claude-code", "codex", "pi", "github"]);
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
