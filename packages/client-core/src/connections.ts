/**
 * Client-side rules about connections that go beyond a plain read.
 *
 * The OAuth redirect URI is built from the browser's origin, which the
 * controller cannot see. The user registers that URI with the provider, so the
 * screen that shows it and the service that builds it use the same function.
 * The connection types are derived in the same way: a connection type is a
 * plugin contribution, so the types come from the plugin list rather than from
 * an operation of their own.
 */
import {
  GITHUB_CONNECTION_TYPE,
  type Connection,
  type ConnectionDevicePoll,
  type ConnectionDeviceStart,
  type PluginDetail,
} from "@hercule/contract";
import type { HerculeClient } from "./client";
import { readJsonObject } from "./json-shape";

/**
 * Returns the GitHub connections: the accounts a repo can be cloned through.
 * Two screens offer them (the composer's add-repo form and Settings > Threads),
 * so the filter is written once here rather than in each screen.
 */
export const filterGitHubConnections = (
  connections: readonly Connection[],
): readonly Connection[] =>
  connections.filter((connection) => connection.type === GITHUB_CONNECTION_TYPE);

/**
 * Checks whether a screen shows the connection's account beside its name.
 * The account is shown only when it adds something the name does not:
 *
 * - A connection the user never named is named after its account, so the
 *   account would repeat the name.
 * - An account with no name, or a name of only spaces, has nothing to show.
 *   Such a connection is named after its type instead.
 */
export const showsAccountBesideLabel = (connection: Connection): boolean =>
  connection.displayName.trim() !== "" && connection.displayName !== connection.label;

/**
 * Builds the connection's topics after the user edits the first one, the only
 * topic the settings form shows. Returns `undefined` when the first topic is
 * unchanged, so a save that leaves it alone sends no topics at all.
 *
 * The typed topic is trimmed, so stray spaces never make a topic of their
 * own, and text of only spaces clears the first topic. The topics after the
 * first, which only the CLI or the API can set, are kept. A kept topic that
 * equals the new first topic is dropped, so no topic is listed twice.
 */
export const buildTopicsUpdate = (
  topics: readonly string[],
  firstTopic: string,
): readonly string[] | undefined => {
  const typed = firstTopic.trim();
  if (typed === (topics[0] ?? "")) return undefined;
  const rest = topics.slice(1);
  return typed === "" ? rest : [typed, ...rest.filter((topic) => topic !== typed)];
};

/** The path the controller serves the provider's redirect on. */
const CALLBACK_PATH = "/oauth/callback";

/** Returns the redirect URI to register for this origin, without a double slash. */
export const buildRedirectUri = (origin: string): string =>
  `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`;

/** One secret a setup asks the user to paste. */
export interface CredentialField {
  readonly name: string;
  readonly label: string;
  readonly help?: string;
}

/**
 * One step of a setup flow, as the plugin host declares it. A newer host can
 * add step kinds this build does not know, so a screen must check which steps
 * it can render rather than assume it can render them all.
 */
export type SetupStep =
  | { readonly kind: "checklist"; readonly markdown: string }
  | { readonly kind: "credentials"; readonly fields: ReadonlyArray<CredentialField> }
  | { readonly kind: "oauth" }
  | { readonly kind: "device" }
  | { readonly kind: "pairing" };

/** A connection type as the screen offers it. */
export interface ConnectionType {
  /** `<pluginId>/<word>`, as the plugin list has it. Sent back as is, never parsed. */
  readonly type: string;
  readonly displayName: string;
  /**
   * The name of the plugin that declares the type, for the line under the
   * type's name. Two plugins may each declare a type called Gmail, so the type
   * name alone is not enough to tell them apart. See `showsPluginName`.
   */
  readonly pluginName: string;
  readonly setup: ReadonlyArray<SetupStep>;
  readonly configSchema?: Record<string, unknown>;
}

/**
 * Returns the connection types declared in the plugin list. There is no
 * separate operation for them: a type is a plugin contribution, so the plugin
 * list the plugins screen already fetches contains every type. Disabled
 * plugins are included, because their `register()` still ran, so their types
 * can still validate what the user pastes.
 */
export const listConnectionTypes = (
  plugins: ReadonlyArray<PluginDetail>,
): ReadonlyArray<ConnectionType> =>
  plugins.flatMap((plugin) =>
    plugin.contributions
      .filter((contribution) => contribution.extensionPoint === "connection-type")
      .flatMap((contribution) => {
        // A contribution's definition arrives as untyped JSON.
        const definition = readJsonObject(contribution.definition);
        const type = definition?.["type"];
        const displayName = definition?.["displayName"];
        if (typeof type !== "string" || typeof displayName !== "string") return [];
        const setup = definition?.["setup"];
        const configSchema = readJsonObject(definition?.["configSchema"]);
        return [
          {
            type,
            displayName,
            pluginName: plugin.displayName,
            setup: Array.isArray(setup) ? (setup as ReadonlyArray<SetupStep>) : [],
            ...(configSchema === undefined ? {} : { configSchema }),
          },
        ];
      }),
  );

/**
 * Checks whether a screen shows the plugin's name under the type's name. The
 * plugin's name is there to tell apart two plugins that declare a type of the
 * same name. When the plugin is named like its type, as a GitHub plugin that
 * declares a GitHub type is, the plugin's name would only repeat the type's.
 */
export const showsPluginName = (type: ConnectionType): boolean =>
  type.pluginName !== type.displayName;

/**
 * One way to obtain a connection's credential:
 *
 * - `device`: the user enters a code at the provider (a device flow).
 * - `oauth`: the browser goes to the provider and comes back (a redirect flow).
 * - `credentials`: the user pastes the secrets.
 * - `pairing`: the user sends the bot a one-time code from a chat account.
 */
export type SetupFlow = "device" | "oauth" | "credentials" | "pairing";

const SETUP_FLOWS: ReadonlyArray<string> = ["device", "oauth", "credentials", "pairing"];

/**
 * Returns every way the connection type can be set up, in the order its setup
 * declares them. The first flow is the one the type prefers; a type with more
 * than one lets the user pick. Every screen that depends on the setup flow
 * uses this function rather than scanning the steps itself.
 *
 * A step kind this build does not know is left out, because it comes from a
 * newer host. An empty list therefore means that the screen cannot set the
 * type up, and should say so rather than guess.
 */
export const listSetupFlows = (type: ConnectionType): ReadonlyArray<SetupFlow> => {
  const kinds: ReadonlyArray<string> = type.setup.map((step) => step.kind);
  // Two credential steps are one flow: the user pastes all their fields at once.
  return [...new Set(kinds)].filter((kind): kind is SetupFlow => SETUP_FLOWS.includes(kind));
};

/**
 * Where a device flow stands after its last poll, as a screen acts on it:
 *
 * - `waiting`: the flow is still open. Poll again after `delay` milliseconds.
 *   `status` says why the flow is still open.
 * - `ended`: the flow ended without a connection. `message` is the
 *   controller's reason, and polling again would only answer `expired`.
 * - `done`: the connection is written.
 */
export type DeviceFlowStep =
  | {
      readonly kind: "waiting";
      readonly status: Extract<ConnectionDevicePoll, { interval: number }>["status"];
      readonly delay: number;
    }
  | {
      readonly kind: "ended";
      readonly status: Extract<ConnectionDevicePoll, { message: string }>["status"];
      readonly message: string;
    }
  | { readonly kind: "done"; readonly connection: Connection };

/**
 * Decides what a screen does next in a device flow, from the flow's start and
 * the last poll reply, or `undefined` before the first poll. Before the first
 * poll the flow is `pending`, and the wait is the one the start returned.
 * A `slow-down` reply carries the new, longer wait, so every reply that keeps
 * the flow open is read the same way.
 */
export const decideDeviceFlowStep = (
  deviceStart: ConnectionDeviceStart,
  reply: ConnectionDevicePoll | undefined,
): DeviceFlowStep => {
  if (reply === undefined) {
    return { kind: "waiting", status: "pending", delay: deviceStart.interval * 1000 };
  }
  switch (reply.status) {
    case "pending":
    case "slow-down":
    case "unreachable":
      return { kind: "waiting", status: reply.status, delay: reply.interval * 1000 };
    case "done":
      return { kind: "done", connection: reply.connection };
    default:
      return { kind: "ended", status: reply.status, message: reply.message };
  }
};

/** The line a screen shows for each way a device flow can end without a connection. */
export const DEVICE_FLOW_ENDINGS: Readonly<
  Record<Extract<DeviceFlowStep, { kind: "ended" }>["status"], string>
> = {
  expired: "The sign-in expired before it was approved.",
  denied: "The sign-in was declined, so nothing changed.",
  failed: "The sign-in did not finish, so nothing changed.",
};

/**
 * Returns the status line a screen shows while a device flow waits for the
 * user. `providerName` is the connection type's display name, such as
 * "GitHub". A `request-failed` wait is a poll request that did not reach the
 * controller or failed there: the flow is still open, so polling goes on.
 */
export const describeDeviceFlowWait = (
  status: Extract<DeviceFlowStep, { kind: "waiting" }>["status"] | "request-failed",
  providerName: string,
): string => {
  switch (status) {
    case "pending":
      return `Waiting for you to approve Hercule on ${providerName}.`;
    case "slow-down":
      return `${providerName} asked for slower checks. Still waiting for you to approve the code.`;
    case "unreachable":
      return `Cannot reach ${providerName} right now. Still trying.`;
    case "request-failed":
      return "The last check did not go through. Still trying.";
  }
};

/** What `waitForDeviceFlow` reports to the screen that shows the flow. */
export interface DeviceFlowWatcher {
  /** Stops the polling. No callback runs after the signal aborts. */
  readonly signal: AbortSignal;
  /** Receives the step each poll reply leads to. A failed poll request does not call it. */
  readonly onStep: (step: DeviceFlowStep) => void;
  /** Receives the error of a poll request that failed. The flow is still open, so polling goes on. */
  readonly onRequestFailure: (error: unknown) => void;
}

/**
 * Returns a promise that resolves after `delay` milliseconds, or as soon as
 * `signal` aborts, whichever comes first. The timer is cleared on abort, so
 * an aborted wait leaves nothing scheduled.
 */
const waitUnlessAborted = (delay: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const stop = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, delay);
    signal.addEventListener("abort", stop, { once: true });
  });

/**
 * Polls `connection.pollDeviceFlow` until the device flow ends, and returns
 * the last step: `done` or `ended` when the flow ended, or the open `waiting`
 * step when `watcher.signal` aborted first. It never throws.
 *
 * - The first poll waits the interval `deviceStart` returned, and each later
 *   poll waits the interval of the last reply, so a `slow-down` reply slows
 *   every poll after it.
 * - A poll request that fails does not end the flow. The next poll follows at
 *   the last interval the controller returned.
 * - One poll runs at a time, and the next one is scheduled only after it
 *   answers.
 *
 * A reply that arrives after the signal aborted calls no callback, so a
 * screen the user already left cannot act on it. The reply still decides the
 * step this function returns: a `done` reply means the controller wrote the
 * Connection, and the caller may want to read its connections again.
 *
 * The waits use `setTimeout` alone, so a test can drive them with fake timers.
 */
export const waitForDeviceFlow = async (
  client: HerculeClient,
  deviceStart: ConnectionDeviceStart,
  watcher: DeviceFlowWatcher,
): Promise<DeviceFlowStep> => {
  const { signal } = watcher;
  let step = decideDeviceFlowStep(deviceStart, undefined);
  while (step.kind === "waiting" && !signal.aborted) {
    await waitUnlessAborted(step.delay, signal);
    if (signal.aborted) break;
    let reply: ConnectionDevicePoll;
    try {
      reply = await client.connection.pollDeviceFlow({
        payload: { setupId: deviceStart.setupId },
      });
    } catch (error) {
      if (!signal.aborted) watcher.onRequestFailure(error);
      continue;
    }
    step = decideDeviceFlowStep(deviceStart, reply);
    if (!signal.aborted) watcher.onStep(step);
  }
  return step;
};

/** Returns the secret fields the type's setup asks the user to paste, in declared order. */
export const listCredentialFields = (type: ConnectionType): ReadonlyArray<CredentialField> =>
  type.setup.flatMap((step) => (step.kind === "credentials" ? [...step.fields] : []));
