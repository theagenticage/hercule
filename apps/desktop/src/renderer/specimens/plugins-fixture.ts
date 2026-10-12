/**
 * The plugins the specimens install, as `plugin.query` would list them. Intake
 * names each signal's source by its plugin, and the open workflow draws an
 * action step with the mark of the plugin whose action it calls.
 */
import type { PluginDetail, PluginMark } from "@hercule/contract";

/** Builds an installed, active plugin named `displayName`, with `mark` when it declares one. */
export const buildPlugin = (id: string, displayName: string, mark?: PluginMark): PluginDetail => ({
  id,
  displayName,
  ...(mark !== undefined && { mark }),
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
});

/**
 * GitHub's mark, as the GitHub plugin declares it: the Bureau book's brands.js
 * path (Simple Icons, CC0) scaled by 2/3 from its 24-unit grid onto the
 * 16-unit grid a plugin's mark is drawn on.
 */
const GITHUB_MARK: PluginMark = {
  paths: [
    "M8 .198c-4.42 0-8 3.582-8 8 0 3.535333 2.292 6.533333 5.47 7.59.4.075333.546667-.172.546667-.384667 0-.19-.006667-.693333-.01-1.36-2.225333.482667-2.694667-1.073333-2.694667-1.073333C2.948 12.046667 2.422 11.8 2.422 11.8c-.724667-.496.056-.486.056-.486 .803333.056 1.225333 .824 1.225333 .824 .713333 1.223333 1.872667 .87 2.33.665333.072-.517333.278-.87.506667-1.07-1.776667-.2-3.644-.888-3.644-3.953333 0-.873333.31-1.586667 .823333-2.146667-.09-.202-.36-1.015333.07-2.117333 0 0 .67-.214667 2.2 .82.64-.178 1.32-.266 2-.27 .68.004 1.36.092 2 .27 1.52-1.034667 2.19-.82 2.19-.82.43 1.102.16 1.915333.08 2.117333.51.56 .82 1.273333 .82 2.146667 0 3.073333-1.87 3.75-3.65 3.946667.28.24.54 .730667.54 1.48 0 1.070667-.01 1.930667-.01 2.190667 0 .21.14.46.55.38C13.71 14.728 16 11.728 16 8.198c0-4.418-3.582-8-8-8",
  ],
};
/** The GitHub plugin, installed and active, with its mark. */
export const GITHUB_PLUGIN: PluginDetail = buildPlugin("github", "GitHub", GITHUB_MARK);

/**
 * Sentry's mark, as a plugin that draws Sentry's own logo would declare it:
 * the Bureau book's brands.js path (Simple Icons, CC0) scaled by 2/3 onto the
 * 16-unit grid. The shipped Sentry plugin declares a geometric mark of its
 * own instead, but the book draws Sentry's logo, so the specimens do too.
 */
export const SENTRY_MARK: PluginMark = {
  paths: [
    "M9.273333 1.67c-0.582 -0.965333 -1.981333 -0.965333 -2.562667 0L4.602667 5.28a10.318667 10.318667 0 0 1 5.686667 8.540667h-1.480667A8.867333 8.867333 0 0 0 3.856 6.542667l-1.950667 3.373333a5.1 5.1 0 0 1 2.956667 3.898667H1.462667a0.243333 0.243333 0 0 1 -0.198667 -0.356l0.942 -1.601333a3.44 3.44 0 0 0 -1.076 -0.608667L0.197333 12.85a1.454667 1.454667 0 0 0 0.541333 1.999333 1.493333 1.493333 0 0 0 0.724 0.192h4.655333a6.214667 6.214667 0 0 0 -2.563333 -5.545333l0.74 -1.281333a7.646667 7.646667 0 0 1 3.3 6.826667h3.943333a11.494667 11.494667 0 0 0 -5.256667 -10.186667l1.496 -2.563333a0.246667 0.246667 0 0 1 0.336 -0.086667c0.17 0.093333 6.5 11.138667 6.618667 11.266667a0.243333 0.243333 0 0 1 -0.218 0.362h-1.524667c0.019333 0.408 0.019333 0.815333 0 1.220667h1.531333a1.470667 1.470667 0 0 0 1.281333 -2.206667z",
  ],
};
