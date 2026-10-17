/**
 * The records the Settings > Connections specimen (settings-connections.tsx)
 * seeds its query cache with, as the controller would return them: the
 * event sources the Bureau book's desktop/settings-connections.html lists,
 * each a Connection of a plugin that declares its Connection type and its
 * mark.
 *
 * - GitHub and Sentry use the ids of the plugins the binary ships, `github`
 *   and `sentry`. The other five types come from plugins the binary does not
 *   ship yet, named after the book's rows.
 * - Each plugin declares the book's brand as its mark: brands.js draws it on a
 *   24-unit grid (Simple Icons, CC0), so each path here is the book's scaled
 *   by 2/3 onto the 16-unit grid a plugin's mark is drawn on.
 * - The book's Cron row is left out: in Hercule a schedule is a trigger, not
 *   a Connection.
 * - Intercom has failed, so its row is drawn as a failure and the Settings
 *   list's Connections row carries the red dot the book draws there.
 * - Each Connection's account differs from its name, so the table shows it
 *   under the name.
 * - Each Connection received the book's count of events in the last 24
 *   hours, spread over the hours as the book spreads them: unevenly, with
 *   Sentry's and GitHub's rising for the last hours of the day.
 *
 * The reference module (settings-connections-reference.ts) reads this module
 * too, to edit the book's page where the app draws the fixture's words.
 */
import type {
  Connection,
  EventCountsByConnection,
  PluginDetail,
  PluginMark,
} from "@hercule/contract";
import type { ConnectionsSettingsRecords, SidebarRecords } from "./shell-page";
import { SETTINGS_ASSISTANTS_RECORDS } from "./settings-assistants-fixture";
import { buildPlugin, GITHUB_PLUGIN, SENTRY_MARK } from "./plugins-fixture";

/** The moment every Connection was created, as the API spells a time. */
const CREATED_AT = "2026-09-10T09:00:00.000Z";

const STRIPE_MARK: PluginMark = {
  paths: [
    "M9.317333 6.1c-1.448-0.537333-2.237333-0.950667-2.237333-1.606 0-0.554 0.455333-0.87 1.267333-0.87 1.484667 0 3.01 0.572 4.06 1.087333l0.593333-3.662667C12.168 0.65 10.464667 0 8.11 0 6.444667 0 5.059333 0.436 4.069333 1.248 3.04 2.098 2.504667 3.328 2.504667 4.812c0 2.692667 1.644667 3.84 4.317333 4.812667 1.723333 0.613333 2.296667 1.049333 2.296667 1.722 0 0.653333-0.56 1.03-1.569333 1.03-1.25 0-3.31-0.614-4.66-1.406l-0.6 3.703333C3.45 15.326667 5.59 16 7.809333 16c1.760667 0 3.228667-0.416 4.218667-1.208667 1.109333-0.87 1.683333-2.157333 1.683333-3.821333 0-2.752-1.682667-3.900667-4.396-4.87h0.002z",
  ],
};
const GMAIL_MARK: PluginMark = {
  paths: [
    "M16 3.638v9.272667c0 0.602667-0.488 1.090667-1.090667 1.090667h-2.546V7.82L8 11.093333l-4.363333-3.273333v6.182H1.090667A1.090667 1.090667 0 0 1 0 12.910667V3.638c0-1.348667 1.539333-2.118667 2.618-1.309333L3.636667 3.093333 8 6.365333l4.363333-3.273333 1.018667-0.763333C14.46 1.52 16 2.289333 16 3.638z",
  ],
};
const POSTHOG_MARK: PluginMark = {
  paths: [
    "M6.569333 9.666667 3.333333 6.431333 0.569333 3.666667A0.333333 0.333333 0 0 0 0 3.902667V5.626667a0.333333 0.333333 0 0 0 0.097333 0.235333L3.333333 9.098l0.098 0.097333L6.569333 12.333333l0.097333 0.098v-0.032667c0.043333 0.02 0.089333 0.032667 0.138 0.032667h1.724a0.333333 0.333333 0 0 0 0.235333-0.569333L6.569333 9.666667zm0-3.333333-2.666667-2.666667a0.324667 0.324667 0 0 0-0.272667-0.096 0.343333 0.343333 0 0 0-0.237333 0.14 0.328667 0.328667 0 0 0-0.059333 0.192V5.626667a0.333333 0.333333 0 0 0 0.098 0.235333l6 6a0.333333 0.333333 0 0 0 0.568667-0.236v-1.723333a0.333333 0.333333 0 0 0-0.097333-0.236l-3.333333-3.333333zm0.666667-2.666667a0.333333 0.333333 0 0 0-0.569333 0.236V5.626667a0.333333 0.333333 0 0 0 0.098 0.235333l2.666667 2.666667a0.333333 0.333333 0 0 0 0.568667-0.236V6.569333a0.333333 0.333333 0 0 0-0.097333-0.236l-2.666667-2.666667zm8.431333 7.676667a2.575333 2.575333 0 0 1-1.488-0.733333l-3.138667-3.138a0.333333 0.333333 0 0 0-0.569333 0.236v4.39a0.333333 0.333333 0 0 0 0.333333 0.333333H15.666667a0.333333 0.333333 0 0 0 0.333333-0.333333v-0.4c0-0.184-0.15-0.331333-0.332667-0.354667zm-3.596 0.021333a0.533333 0.533333 0 1 1 0-1.066667 0.533333 0.533333 0 0 1 0 1.066667zM0.569333 10.333333a0.333333 0.333333 0 0 0-0.569333 0.236v1.528667a0.333333 0.333333 0 0 0 0.333333 0.333333h1.528667c0.148 0 0.26-0.09 0.308-0.206a0.328667 0.328667 0 0 0-0.072667-0.363333L0.569333 10.334zM3.333333 9.764667 0.569333 7a0.333333 0.333333 0 0 0-0.569333 0.235333v1.724a0.333333 0.333333 0 0 0 0.097333 0.235333L3.236 12.333333l0.097333 0.098h1.862a0.333333 0.333333 0 0 0 0.235333-0.569333L3.333333 9.764667z",
  ],
};
const INTERCOM_MARK: PluginMark = {
  paths: [
    "M14 0H2C0.895333 0 0 0.895333 0 2v12c0 1.105333 0.895333 2 2 2h12c1.105333 0 2-0.894667 2-2V2c0-1.104667-0.894667-2-2-2zm-3.867333 2.932667c0-0.293333 0.24-0.533333 0.534667-0.533333 0.293333 0 0.533333 0.24 0.533333 0.533333v7.125333c0 0.294667-0.24 0.534-0.533333 0.534-0.295333 0-0.534667-0.239333-0.534667-0.534V2.932667zM7.466667 2.662667c0-0.293333 0.238-0.532667 0.533333-0.532667s0.533333 0.239333 0.533333 0.532667v7.734667c0 0.293333-0.238 0.533333-0.533333 0.533333s-0.533333-0.24-0.533333-0.533333V2.662667zm-2.666667 0.27c0-0.293333 0.239333-0.533333 0.532667-0.533333 0.295333 0 0.534667 0.24 0.534667 0.533333v7.125333c0 0.294667-0.24 0.534-0.534667 0.534-0.293333 0-0.532667-0.239333-0.532667-0.534V2.932667zM2.132667 4c0-0.294667 0.24-0.533333 0.534667-0.533333 0.293333 0 0.532667 0.238667 0.532667 0.533333v4.796667c0 0.294-0.239333 0.533333-0.532667 0.533333-0.295333 0-0.534667-0.24-0.534667-0.533333V4zM13.68 12.134667c-0.082 0.07-2.057333 1.728667-5.68 1.728667-3.622 0-5.598-1.657333-5.680667-1.728667-0.223333-0.192-0.25-0.528-0.057333-0.752 0.19-0.222667 0.526667-0.25 0.75-0.06 0.031333 0.027333 1.795333 1.474 4.987333 1.474 3.232 0 4.970667-1.457333 4.986-1.471333 0.222667-0.192667 0.559333-0.166667 0.752 0.057333 0.192667 0.224 0.166667 0.56-0.057333 0.752zm0.187333-3.338c0 0.294-0.24 0.533333-0.534 0.533333-0.294 0-0.534-0.24-0.534-0.533333V4c0-0.294667 0.240667-0.533333 0.534-0.533333 0.294 0 0.534 0.238 0.534 0.533333v4.796667z",
  ],
};
const GRAFANA_MARK: PluginMark = {
  paths: [
    "M15.346667 7.06a5.718667 5.718667 0 0 0-0.574667-2.022667 5.940667 5.940667 0 0 0-1.192667-1.63c0.224667-0.894667-0.275333-1.67-0.275333-1.67-0.861333-0.053333-1.408667 0.266667-1.610667 0.413333-0.034667-0.013333-0.068-0.029333-0.102667-0.042667-0.146667-0.059333-0.297333-0.114667-0.451333-0.164667-0.154-0.048667-0.313333-0.093333-0.474-0.131333a6.578 6.578 0 0 0-0.583333-0.107333C9.704667 0.502 8.626667 0 8.626667 0c-1.202667 0.763333-1.431333 1.829333-1.431333 1.829333l-0.012 0.062c-0.065333 0.019333-0.133333 0.038-0.198667 0.058667-0.092 0.028-0.183333 0.062667-0.275333 0.095333-0.092 0.036667-0.183333 0.071333-0.273333 0.110667a5.912667 5.912667 0 0 0-1.038 0.58l-0.042-0.019333c-1.664667-0.636667-3.144 0.13-3.144 0.13-0.135333 1.772 0.664 2.886667 0.823333 3.090667a7.738667 7.738667 0 0 0-0.404667 1.756667C1.090667 8.451333 0.635333 10.009333 0.635333 10.009333c1.284 1.476 2.780667 1.567333 2.780667 1.567333 0.002-0.001333 0.004-0.001333 0.004-0.003333 0.19 0.339333 0.41 0.662667 0.657333 0.964 0.104 0.126667 0.213333 0.247333 0.325333 0.365333-0.469333 1.339333 0.066 2.453333 0.066 2.453333 1.429333 0.053333 2.368667-0.624667 2.566-0.782a6.522667 6.522667 0 0 0 2.109333 0.334h0.053333l0.036667-0.002 0.071333-0.001333 0.068667-0.003333 0.002 0.001333c0.673333 0.96 1.858667 1.097333 1.858667 1.097333 0.842667-0.888 0.891333-1.768667 0.891333-1.96v-0.038667c0-0.013333-0.002-0.026-0.002-0.04 0.176667-0.124667 0.346667-0.258 0.505333-0.4a5.25 5.25 0 0 0 0.943333-1.133333c0.953333 0.055333 1.624667-0.59 1.624667-0.59-0.157333-0.993333-0.723333-1.477333-0.842667-1.569333l-0.012-0.008667-0.010667-0.008667a0.144667 0.144667 0 0 1-0.020667-0.013333c0.005333-0.061333 0.010667-0.12 0.013333-0.18 0.007333-0.108 0.010667-0.215333 0.010667-0.32v-0.168667l-0.003333-0.065333-0.005333-0.09a1.260667 1.260667 0 0 0-0.006667-0.086667c-0.002-0.028-0.005333-0.055333-0.008667-0.083333l-0.010667-0.082667-0.012-0.081333a4.143333 4.143333 0 0 0-1.354667-2.486667 4.01 4.01 0 0 0-2.148-0.973333 4.194667 4.194667 0 0 0-0.566667-0.032l-0.071333 0.001333h-0.042l-0.029333 0.002-0.069333 0.005333a3.184667 3.184667 0 0 0-2.223333 1.13c-0.221333 0.266667-0.394667 0.56-0.512 0.864667a3.062667 3.062667 0 0 0-0.208 1.211333l0.002 0.060667c0.003333 0.036667 0.004667 0.073333 0.008667 0.109333a2.41 2.41 0 0 0 0.465333 1.213333 2.353333 2.353333 0 0 0 1.218 0.854667c0.22 0.065333 0.44 0.093333 0.647333 0.091333 0.026 0 0.052 0 0.076-0.001333l0.042-0.002c0.013333 0 0.027333-0.002 0.041333-0.002 0.022667-0.001333 0.043333-0.004667 0.066-0.006667 0.004667 0 0.012-0.002 0.018667-0.002l0.020667-0.003333 0.04-0.005333a0.786667 0.786667 0 0 0 0.074667-0.013333c0.024-0.005333 0.048-0.008667 0.072667-0.016a1.756 1.756 0 0 0 0.609333-0.276667c0.018667-0.013333 0.037333-0.027333 0.056667-0.043333a0.165333 0.165333 0 0 0 0.026-0.233333 0.162667 0.162667 0 0 0-0.206-0.04l-0.052 0.028c-0.06 0.029333-0.122667 0.055333-0.188667 0.077333a1.650667 1.650667 0 0 1-0.316667 0.064c-0.018667 0.002-0.036 0.004-0.055333 0.004l-0.055333 0.001333c-0.017333 0-0.036 0-0.053333-0.001333l-0.068-0.004h-0.008l-0.016 0.004c-0.010667-0.002-0.020667-0.002-0.029333-0.004-0.020667-0.001333-0.04-0.004667-0.060667-0.006667a1.726667 1.726667 0 0 1-0.482667-0.142 1.704667 1.704667 0 0 1-0.444667-0.292 1.68 1.68 0 0 1-0.536667-0.983333 1.537333 1.537333 0 0 1-0.019333-0.296l0.004-0.081333v-0.015333l0.001333-0.020667c0.002-0.014 0.002-0.026667 0.003333-0.04a2.108667 2.108667 0 0 1 0.901333-1.526667 2.08 2.08 0 0 1 0.624667-0.286667 1.964 1.964 0 0 1 0.517333-0.067333h0.04l0.046667 0.001333 0.03 0.002h0.017333l0.046667 0.003333a2.694 2.694 0 0 1 1.09 0.326667 2.626667 2.626667 0 0 1 1.068 1.108 2.513333 2.513333 0 0 1 0.264667 0.942667l0.003333 0.050667 0.002 0.05c0.001333 0.017333 0.001333 0.033333 0.001333 0.05 0 0.016 0.002 0.034667 0 0.046667v0.043333l-0.001333 0.048667-0.005333 0.116a4.13 4.13 0 0 1-0.053333 0.426 3.4 3.4 0 0 1-0.178 0.618 3.54 3.54 0 0 1-0.416 0.753333 3.368 3.368 0 0 1-2.158 1.342667 3.213333 3.213333 0 0 1-0.432667 0.044l-0.026 0.002h-0.191333a4.404667 4.404667 0 0 1-1.144-0.176667 4.517333 4.517333 0 0 1-2.266667-1.516 4.5 4.5 0 0 1-0.497333-0.766667 4.410667 4.410667 0 0 1-0.476-1.730667l-0.003333-0.055333-0.001333-0.013333v-0.037333l-0.002-0.048667v-0.064l-0.002-0.069333v-0.046667l0.002-0.108667c0.005333-0.146667 0.017333-0.3 0.036-0.452a5.804667 5.804667 0 0 1 0.186667-0.903333c0.085333-0.296 0.190667-0.581333 0.315333-0.851333a4.693333 4.693333 0 0 1 0.970667-1.4 3.95 3.95 0 0 1 0.635333-0.508667c0.112667-0.074 0.228667-0.142 0.349333-0.204 0.059333-0.033333 0.121333-0.060667 0.182-0.09 0.031333-0.013333 0.062-0.028 0.092-0.041333a4.784667 4.784667 0 0 1 0.476-0.178l0.096667-0.03c0.032667-0.01 0.065333-0.017333 0.098667-0.027333 0.065333-0.019333 0.131333-0.034667 0.197333-0.050667 0.032667-0.008667 0.066667-0.013333 0.1-0.022l0.1-0.021333 0.100667-0.018667 0.050667-0.008667 0.05-0.006667 0.102-0.016c0.038-0.006667 0.076-0.008667 0.114-0.015333l0.112667-0.014c0.024-0.002 0.048667-0.005333 0.070667-0.006667l0.048667-0.005333 0.024-0.002 0.028-0.001333c0.038-0.002 0.076-0.005333 0.114-0.006667l0.057333-0.004h0.015333l0.024667-0.002 0.096667-0.004667a5.332667 5.332667 0 0 1 1.138667 0.083333 5.278 5.278 0 0 1 1.365333 0.453333 5.502 5.502 0 0 1 1.114667 0.726667l0.06 0.051333 0.059333 0.052c0.04 0.034667 0.076 0.071333 0.114 0.106 0.038 0.034667 0.074667 0.070667 0.110667 0.106667 0.034667 0.036667 0.071333 0.071333 0.106 0.109333a5.780667 5.780667 0 0 1 0.94 1.318667c0.008 0.017333 0.018667 0.034667 0.026667 0.052l0.026667 0.052 0.05 0.104c0.015333 0.034 0.033333 0.066667 0.046667 0.102l0.043333 0.1a5.898667 5.898667 0 0 1 0.3 0.893333 0.126667 0.126667 0 0 0 0.134 0.094667 0.124 0.124 0 0 0 0.114667-0.122667c0.006667-0.164 0.001333-0.354667-0.016-0.570667z",
  ],
};

/**
 * Returns `plugin` declaring one Connection type, `<plugin id>/<word>`, named
 * `displayName`.
 */
const declareConnectionType = (
  plugin: PluginDetail,
  word: string,
  displayName: string,
): PluginDetail => ({
  ...plugin,
  contributions: [
    {
      extensionPoint: "connection-type",
      id: `${plugin.id}/${word}`,
      definition: { type: `${plugin.id}/${word}`, displayName },
    },
  ],
});

/** The plugins the Connections belong to, each declaring its Connection type. */
const CONNECTIONS_PLUGINS: ReadonlyArray<PluginDetail> = [
  declareConnectionType(buildPlugin("sentry", "Sentry", SENTRY_MARK), "sentry", "Sentry"),
  declareConnectionType(GITHUB_PLUGIN, "github", "GitHub"),
  declareConnectionType(buildPlugin("stripe", "Stripe", STRIPE_MARK), "stripe", "Stripe"),
  declareConnectionType(buildPlugin("gmail", "Gmail", GMAIL_MARK), "gmail", "Gmail"),
  declareConnectionType(buildPlugin("posthog", "PostHog", POSTHOG_MARK), "posthog", "PostHog"),
  declareConnectionType(buildPlugin("intercom", "Intercom", INTERCOM_MARK), "intercom", "Intercom"),
  declareConnectionType(buildPlugin("grafana", "Grafana", GRAFANA_MARK), "grafana", "Grafana"),
];

/** Builds a connected Connection of `type` named `label`, signed in as `displayName`. */
const buildConnection = (
  id: string,
  type: string,
  label: string,
  displayName: string,
): Connection => ({
  id,
  type,
  label,
  displayName,
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

/** Intercom, which failed: its health reads the controller's detail. */
export const FAILED_INTERCOM: Connection = {
  ...buildConnection("c-intercom", "intercom/intercom", "support", "Acme support"),
  status: "error",
  statusDetail: "reconnecting since 09:12",
};

/** The Connections, in the order the book lists its event sources. */
export const CONNECTIONS: ReadonlyArray<Connection> = [
  buildConnection("c-sentry", "sentry/sentry", "webshop-prod", "Acme · rogier"),
  buildConnection("c-github", "github/github", "rogier", "rogier-acme"),
  buildConnection("c-stripe", "stripe/stripe", "live", "Acme Inc."),
  buildConnection("c-gmail", "gmail/gmail", "rogier@personal", "rogier@gmail.com"),
  buildConnection("c-posthog", "posthog/posthog", "webshop", "Acme"),
  FAILED_INTERCOM,
  buildConnection("c-grafana", "grafana/grafana", "ops", "acme.grafana.net"),
];

/**
 * Spreads `total` events over 24 hours, oldest first, as the book's page
 * spreads each row's count: each hour gets a weight between 0.4 and 1.4,
 * picked by a hash of the hour, and from hour `surge` on, if given, 2.6 times
 * that. The counts are the weights' shares of `total`, rounded, and the last
 * hour takes what the rounding left over, so they add up to `total`.
 */
const spreadOverHours = (total: number, surge?: number): ReadonlyArray<number> => {
  const weights = Array.from({ length: 24 }, (_, hour) => {
    // FNV-1a, enough to scatter the hours the same way on every run.
    let hash = 2166136261;
    for (const char of `${String(total)}:${String(hour)}`) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    }
    const weight = 0.4 + (hash % 100) / 100;
    return surge !== undefined && hour >= surge ? weight * 2.6 : weight;
  });
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const counts = weights.map((weight) => Math.round((weight / sum) * total));
  counts[23] = total - counts.slice(0, 23).reduce((total, count) => total + count, 0);
  return counts;
};

/** What each Connection received in the last 24 hours: the book's count of each row. */
const EVENT_COUNTS: EventCountsByConnection = {
  connections: [
    { connectionId: "c-sentry", hourly: spreadOverHours(1406, 10) },
    { connectionId: "c-github", hourly: spreadOverHours(312, 16) },
    { connectionId: "c-stripe", hourly: spreadOverHours(209) },
    { connectionId: "c-gmail", hourly: spreadOverHours(188) },
    { connectionId: "c-posthog", hourly: spreadOverHours(96) },
    { connectionId: "c-intercom", hourly: spreadOverHours(61) },
    { connectionId: "c-grafana", hourly: spreadOverHours(44) },
  ],
};

/**
 * The records the specimen draws beside the section: the Settings >
 * Assistants specimen's sidebar with its first four threads, as the
 * Appearance specimen draws it. The comparison covers only the main pane.
 */
export const CONNECTIONS_SIDEBAR_RECORDS: SidebarRecords = {
  ...SETTINGS_ASSISTANTS_RECORDS,
  threads: SETTINGS_ASSISTANTS_RECORDS.threads.slice(0, 4),
};

/**
 * What the section reads: the Connections, the plugins that declare their
 * types, and the events each received.
 */
export const CONNECTIONS_SETTINGS_RECORDS: ConnectionsSettingsRecords = {
  connections: CONNECTIONS,
  plugins: CONNECTIONS_PLUGINS,
  counts: EVENT_COUNTS,
};
