import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";

/**
 * The Google mark, path data only, on the 16x16 grid a plugin's mark uses. It
 * is the Google mark of Simple Icons 16.38.1 (CC0), drawn on a 24-unit grid
 * there, with every coordinate scaled by 2/3 and rounded to six decimals, so it
 * draws the same pixels as the original.
 */
const GOOGLE_MARK_PATH =
  "M8.32 7.28v2.186667h5.226667c-0.16 1.226667 -0.568667 2.124667 -1.191333 2.755333 -0.764667 0.764667 -1.955333 1.6 -4.035333 1.6 -3.218 0 -5.733333 -2.595333 -5.733333 -5.813333s2.515333 -5.813333 5.733333 -5.813333c1.733333 0 3.004667 0.684667 3.938 1.564667l1.538 -1.538C12.498 0.96 10.755333 0 8.32 0 3.911333 0 0.204667 3.591333 0.204667 8s3.706667 8 8.115333 8c2.382 0 4.178 -0.782 5.582 -2.24 1.44 -1.44 1.893333 -3.475333 1.893333 -5.111333 0 -0.506667 -0.035333 -0.978 -0.115333 -1.368667H8.32z";

/**
 * Google as a provider. A Google subscription is signed in through
 * Antigravity's own login on each machine, so Antigravity is the one harness
 * the account kind lists.
 */
const definition: ProviderDefinition = {
  id: "google",
  displayName: "Google",
  kinds: [
    {
      id: "subscription-per-machine",
      title: "Google subscription, signed in on each machine",
      description:
        "Uses your Google plan through Antigravity. You sign in to Antigravity once on each machine that runs it.",
      setup: [{ kind: "harness-login", method: "sign-in" }],
      // No usage: Antigravity reports no quota over ACP, and Hercule never
      // calls Google itself with a subscription login.
      harnesses: ["antigravity/antigravity"],
    },
  ],
  defaultHarnessId: "antigravity/antigravity",
  catalogSource: { kind: "harness-probe", harnessId: "antigravity/antigravity" },
  defaultSelection: "current-models",
  // A Google account also lists Claude and GPT models that Google resells. The
  // menu starts with Google's own; the others are found in the model browser.
  defaultSelectionMaker: "Google",
};

export const google: Plugin = {
  manifest: {
    id: "google",
    displayName: "Google",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
    mark: { paths: [GOOGLE_MARK_PATH] },
  },
  register: (host) => registerProvider(host, definition),
  // Nothing runs on the controller for a provider yet: the definition above is
  // everything the plugin contributes.
  activate: () => Effect.succeed(Effect.void),
};
