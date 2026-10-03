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
import { describeMinutes } from "./minutes-left";

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
 *   `status` is the reason the flow is still open.
 * - `ended`: the flow ended without a connection. `message` is the
 *   controller's reason, or `DEVICE_CODE_EXPIRED` when the code's expiry
 *   ended the flow, and polling again would only answer `expired`.
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
 * The reason given when a device flow ends `expired` because its code's
 * expiry passed on this machine's clock while the flow was still open. A
 * flow the controller ended carries the controller's own reason instead.
 */
export const DEVICE_CODE_EXPIRED =
  "The code stopped working before it was approved. Start again for a new one.";

/**
 * Decides what a screen does next in a device flow, from the flow's start,
 * the last poll reply (`undefined` before the first poll), and `now`, in
 * milliseconds since the epoch. Before the first poll the flow is `pending`,
 * and the wait is the one the start returned. A `slow-down` reply carries the
 * new, longer wait, so every reply that keeps the flow open is read the same
 * way.
 *
 * An open flow ends `expired` once `now` reaches the code's `expiresAt`,
 * because no poll can succeed after that. Until then, a wait never runs past
 * the expiry, so the screen learns that the code expired the moment it does.
 */
export const decideDeviceFlowStep = (
  deviceStart: ConnectionDeviceStart,
  reply: ConnectionDevicePoll | undefined,
  now: number,
): DeviceFlowStep => {
  const last = reply ?? { status: "pending", interval: deviceStart.interval };
  switch (last.status) {
    case "pending":
    case "slow-down":
    case "unreachable": {
      const timeLeft = Date.parse(deviceStart.expiresAt) - now;
      if (timeLeft <= 0) return { kind: "ended", status: "expired", message: DEVICE_CODE_EXPIRED };
      return {
        kind: "waiting",
        status: last.status,
        delay: Math.min(last.interval * 1000, timeLeft),
      };
    }
    case "done":
      return { kind: "done", connection: last.connection };
    default:
      return { kind: "ended", status: last.status, message: last.message };
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

/** How a GitHub sign-in with a code ended without a Connection, as the first run shows it. */
export interface GitHubSignInEnding {
  readonly kind: "ended";
  readonly status: Extract<DeviceFlowStep, { kind: "ended" }>["status"];
  /** What happened. */
  readonly line: string;
  /** What the user can do next. */
  readonly next: string;
}

/**
 * Returns the ending of a GitHub sign-in that failed with `message`, the
 * controller's own reason, which differs from case to case. A sign-in fails
 * when its code cannot be started, or when the flow ends `failed`.
 */
export const describeGitHubSignInFailure = (message: string): GitHubSignInEnding => ({
  kind: "ended",
  status: "failed",
  line: DEVICE_FLOW_ENDINGS.failed,
  next: message,
});

/**
 * Returns how the GitHub sign-in with a code ended, from the flow's `ending`.
 * `codeMinutes` is how long the code lasted when it was handed out, which an
 * expired sign-in names.
 */
export const describeGitHubSignInEnding = (
  ending: Extract<DeviceFlowStep, { kind: "ended" }>,
  codeMinutes: number,
): GitHubSignInEnding => {
  switch (ending.status) {
    case "expired":
      return {
        kind: "ended",
        status: "expired",
        line: DEVICE_FLOW_ENDINGS.expired,
        next: `A code lasts ${describeMinutes(codeMinutes)}. Start again for a new one.`,
      };
    case "denied":
      return {
        kind: "ended",
        status: "denied",
        line: DEVICE_FLOW_ENDINGS.denied,
        next: "Hercule was declined on GitHub’s approval page. Start again if that was a mistake.",
      };
    case "failed":
      return describeGitHubSignInFailure(ending.message);
  }
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
  /**
   * Receives each step the flow reaches: the one a poll reply leads to, or the
   * `expired` ending when the code's expiry passes. A failed poll request does
   * not call it.
   */
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
 * - When the code's `expiresAt` passes, the flow ends `expired` at that
 *   moment, with no further poll, and `watcher.onStep` receives the ending.
 *   A code that has expired already ends the flow before any poll.
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
  let reply: ConnectionDevicePoll | undefined;
  let step = decideDeviceFlowStep(deviceStart, undefined, Date.now());
  // A screen may show the code as waiting before this runs, so a code that
  // had expired before it arrived is reported too.
  if (step.kind === "ended" && !signal.aborted) watcher.onStep(step);
  while (step.kind === "waiting" && !signal.aborted) {
    await waitUnlessAborted(step.delay, signal);
    if (signal.aborted) break;
    // The wait ends no later than the code's expiry. A code that expired
    // during the wait ends the flow here, before another poll goes out.
    step = decideDeviceFlowStep(deviceStart, reply, Date.now());
    if (step.kind === "waiting") {
      try {
        reply = await client.connection.pollDeviceFlow({
          payload: { setupId: deviceStart.setupId },
        });
      } catch (error) {
        if (!signal.aborted) watcher.onRequestFailure(error);
        continue;
      }
      step = decideDeviceFlowStep(deviceStart, reply, Date.now());
    }
    if (!signal.aborted) watcher.onStep(step);
  }
  return step;
};

/** Returns the secret fields the type's setup asks the user to paste, in declared order. */
export const listCredentialFields = (type: ConnectionType): ReadonlyArray<CredentialField> =>
  type.setup.flatMap((step) => (step.kind === "credentials" ? [...step.fields] : []));
