import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, PluginDetail } from "@hercule/contract";
import { buildErrorBody, createApiStub, type Answer, type Handler } from "./api-stub";
import { createClient } from "./client";
import {
  listConnectionTypes,
  listCredentialFields,
  showsAccountBesideLabel,
  showsPluginName,
  buildTopicsUpdate,
  buildRedirectUri,
  listSetupFlows,
  decideDeviceFlowStep,
  describeDeviceFlowWait,
  DEVICE_CODE_EXPIRED,
  describeGitHubSignInEnding,
  describeGitHubSignInFailure,
  waitForDeviceFlow,
  describeFeedName,
  describeFeedInterval,
  buildFeedIntervalsDraft,
  buildFeedIntervalsPayload,
  readConnectionIssues,
  type ConnectionFeed,
  type ConnectionType,
  type DeviceFlowStep,
} from "./connections";
import { ApiError, readErrorMessage } from "./errors";

describe("showsAccountBesideLabel", () => {
  const connection = {
    id: "0199c0ff-aaaa-7000-8000-000000000001",
    type: "github/github",
    label: "octocat",
    displayName: "octocat",
    status: "connected",
    labels: [],
    config: {},
    feedIntervals: {},
    credentials: [],
    createdAt: "2026-10-02T08:15:00.000Z",
    updatedAt: "2026-10-02T08:15:00.000Z",
  } satisfies Connection;

  it("is false for a connection whose name is its account name", () => {
    expect(showsAccountBesideLabel(connection)).toBe(false);
  });

  it("is true once the connection is renamed, though the account stays the same", () => {
    expect(showsAccountBesideLabel({ ...connection, label: "personal" })).toBe(true);
  });

  it("is false for an account with no name, which the type's name stands in for", () => {
    expect(showsAccountBesideLabel({ ...connection, label: "GitHub", displayName: "" })).toBe(
      false,
    );
    expect(showsAccountBesideLabel({ ...connection, label: "GitHub", displayName: "  " })).toBe(
      false,
    );
  });
});

describe("buildTopicsUpdate", () => {
  it("returns nothing when the first topic is unchanged", () => {
    expect(buildTopicsUpdate(["Code", "Ops"], "Code")).toBeUndefined();
    expect(buildTopicsUpdate([], "")).toBeUndefined();
  });

  it("replaces the first topic and keeps the others", () => {
    expect(buildTopicsUpdate(["Code", "Ops"], "Business")).toEqual(["Business", "Ops"]);
    expect(buildTopicsUpdate([], "Code")).toEqual(["Code"]);
  });

  it("removes only the first topic when the field is cleared", () => {
    expect(buildTopicsUpdate(["Code", "Ops"], "")).toEqual(["Ops"]);
    expect(buildTopicsUpdate(["Code"], "")).toEqual([]);
  });

  it("trims the typed topic, and reads text of only spaces as cleared", () => {
    expect(buildTopicsUpdate(["Code", "Ops"], " Code ")).toBeUndefined();
    expect(buildTopicsUpdate(["Code", "Ops"], "Business ")).toEqual(["Business", "Ops"]);
    expect(buildTopicsUpdate(["Code", "Ops"], "   ")).toEqual(["Ops"]);
    expect(buildTopicsUpdate([], "   ")).toBeUndefined();
  });

  it("lists a topic once when the new first topic is one of the others", () => {
    expect(buildTopicsUpdate(["Code", "Ops"], "Ops")).toEqual(["Ops"]);
  });
});

describe("buildRedirectUri", () => {
  it("is the callback path on the browser's origin", () => {
    expect(buildRedirectUri("https://n.tail.ts.net")).toBe("https://n.tail.ts.net/oauth/callback");
  });

  it("does not double the slash when the origin ends in one", () => {
    expect(buildRedirectUri("https://n.tail.ts.net/")).toBe("https://n.tail.ts.net/oauth/callback");
  });
});

/** Returns a plugin from the plugin list, with the given contributions. */
const buildPlugin = (id: string, contributions: PluginDetail["contributions"]): PluginDetail => ({
  id,
  displayName: `Plugin ${id}`,
  hostApi: 1,
  capabilities: ["connections"],
  // Disabled, but `register()` still ran, so its types are still offered.
  enabled: false,
  status: { _tag: "active" },
  config: {},
  contributions,
});

const PAPER = {
  type: "paper-trail/paper",
  displayName: "Paper Trail",
  setup: [{ kind: "credentials", fields: [{ name: "token", label: "Access token" }] }],
  configSchema: { type: "object", properties: { folder: { type: "string" } } },
};

describe("listConnectionTypes", () => {
  it("returns every connection-type contribution, and no other contribution", () => {
    const types = listConnectionTypes([
      buildPlugin("paper-trail", [
        { extensionPoint: "connection-type", id: "paper-trail/paper", definition: PAPER },
      ]),
      buildPlugin("quiet-sink", [{ extensionPoint: "provider", id: "acme", definition: {} }]),
    ]);

    expect(types).toEqual([
      {
        type: "paper-trail/paper",
        displayName: "Paper Trail",
        pluginName: "Plugin paper-trail",
        setup: PAPER.setup,
        configSchema: PAPER.configSchema,
        feeds: [],
      },
    ]);
  });

  it("gives a type the feeds of the event source that polls for it", () => {
    const [paper] = listConnectionTypes([
      buildPlugin("paper-trail", [
        { extensionPoint: "connection-type", id: "paper-trail/paper", definition: PAPER },
        {
          extensionPoint: "event-source",
          id: "paper-trail/inbox",
          definition: {
            connectionType: "paper-trail/paper",
            kinds: {},
            feeds: {
              letters: { defaultIntervalSeconds: 120, minIntervalSeconds: 60 },
              parcels: { defaultIntervalSeconds: 300 },
            },
          },
        },
        // Polls for another type, so its feed is not the paper type's.
        {
          extensionPoint: "event-source",
          id: "paper-trail/fax",
          definition: { connectionType: "paper-trail/fax", kinds: {}, feeds: { pages: {} } },
        },
      ]),
    ]);

    expect(paper?.feeds).toEqual([
      { name: "letters", defaultIntervalSeconds: 120, minIntervalSeconds: 60 },
      // No minimum declared, so the default is the shortest interval allowed.
      { name: "parcels", defaultIntervalSeconds: 300, minIntervalSeconds: 300 },
    ]);
  });

  it("leaves out a feed whose declaration it cannot read", () => {
    const [paper] = listConnectionTypes([
      buildPlugin("paper-trail", [
        { extensionPoint: "connection-type", id: "paper-trail/paper", definition: PAPER },
        {
          extensionPoint: "event-source",
          id: "paper-trail/inbox",
          definition: {
            connectionType: "paper-trail/paper",
            feeds: {
              letters: { defaultIntervalSeconds: 120 },
              noDefault: { minIntervalSeconds: 60 },
              textMinimum: { defaultIntervalSeconds: 60, minIntervalSeconds: "30" },
              notAnObject: 60,
            },
          },
        },
        {
          extensionPoint: "event-source",
          id: "paper-trail/broken",
          definition: { connectionType: "paper-trail/paper", feeds: ["letters"] },
        },
      ]),
    ]);

    expect(paper?.feeds.map((feed) => feed.name)).toEqual(["letters"]);
  });

  it("tells apart two plugins that declare a type with the same name, by type and by plugin", () => {
    const buildGmailType = (displayName: string) => ({ type: "x", displayName, setup: [] });
    const types = listConnectionTypes([
      buildPlugin("first", [
        {
          extensionPoint: "connection-type",
          id: "first/gmail",
          definition: { ...buildGmailType("Gmail"), type: "first/gmail" },
        },
      ]),
      buildPlugin("second", [
        {
          extensionPoint: "connection-type",
          id: "second/gmail",
          definition: { ...buildGmailType("Gmail"), type: "second/gmail" },
        },
      ]),
    ]);

    expect(types.map((one) => [one.type, one.pluginName])).toEqual([
      ["first/gmail", "Plugin first"],
      ["second/gmail", "Plugin second"],
    ]);
  });
});

/** Returns a connection type with only the setup under test; no other field is read. */
const withSetup = (setup: ConnectionType["setup"]): ConnectionType => ({
  type: "p/t",
  displayName: "T",
  pluginName: "P",
  setup,
  feeds: [],
});

describe("showsPluginName", () => {
  it("is true when the plugin's name differs from the type's", () => {
    expect(showsPluginName(withSetup([]))).toBe(true);
  });

  it("is false when the plugin is named like its type", () => {
    expect(showsPluginName({ ...withSetup([]), displayName: "GitHub", pluginName: "GitHub" })).toBe(
      false,
    );
  });
});

describe("listSetupFlows", () => {
  it("returns the one flow a type with a single step offers", () => {
    expect(
      listSetupFlows(withSetup([{ kind: "checklist", markdown: "do this" }, { kind: "oauth" }])),
    ).toEqual(["oauth"]);
    expect(
      listSetupFlows(
        withSetup([{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }]),
      ),
    ).toEqual(["credentials"]);
    expect(listSetupFlows(withSetup([{ kind: "device" }]))).toEqual(["device"]);
    expect(listSetupFlows(withSetup([{ kind: "pairing" }]))).toEqual(["pairing"]);
  });

  it("returns every flow a type offers, in the order its setup declares them", () => {
    const token = { kind: "credentials", fields: [{ name: "token", label: "Token" }] } as const;
    expect(listSetupFlows(withSetup([{ kind: "device" }, token]))).toEqual([
      "device",
      "credentials",
    ]);
    expect(listSetupFlows(withSetup([token, { kind: "oauth" }]))).toEqual(["credentials", "oauth"]);
  });

  it("returns one credentials flow for several credential steps", () => {
    expect(
      listSetupFlows(
        withSetup([
          { kind: "credentials", fields: [{ name: "token", label: "Token" }] },
          { kind: "credentials", fields: [{ name: "secret", label: "Secret" }] },
        ]),
      ),
    ).toEqual(["credentials"]);
  });

  it("leaves out a step kind this build does not know", () => {
    const unknown = { kind: "carrier-pigeon" } as unknown as ConnectionType["setup"][number];
    expect(listSetupFlows(withSetup([]))).toEqual([]);
    expect(listSetupFlows(withSetup([unknown]))).toEqual([]);
    expect(listSetupFlows(withSetup([unknown, { kind: "device" }]))).toEqual(["device"]);
  });
});

describe("decideDeviceFlowStep", () => {
  const deviceStart = {
    setupId: "s-1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://example.test/device",
    expiresAt: "2026-10-02T12:15:00.000Z",
    interval: 5,
  };
  // Five minutes before the code expires.
  const NOW = Date.parse("2026-10-02T12:10:00.000Z");

  it("waits the start's interval before the first poll", () => {
    expect(decideDeviceFlowStep(deviceStart, undefined, NOW)).toEqual({
      kind: "waiting",
      status: "pending",
      delay: 5000,
    });
  });

  it("waits the interval the last reply returned while the flow is open", () => {
    expect(decideDeviceFlowStep(deviceStart, { status: "pending", interval: 5 }, NOW)).toEqual({
      kind: "waiting",
      status: "pending",
      delay: 5000,
    });
    expect(decideDeviceFlowStep(deviceStart, { status: "slow-down", interval: 10 }, NOW)).toEqual({
      kind: "waiting",
      status: "slow-down",
      delay: 10_000,
    });
    expect(decideDeviceFlowStep(deviceStart, { status: "unreachable", interval: 5 }, NOW)).toEqual({
      kind: "waiting",
      status: "unreachable",
      delay: 5000,
    });
  });

  it("ends the flow with the controller's reason", () => {
    for (const status of ["expired", "denied", "failed"] as const) {
      const message = "the code expired before it was approved";
      expect(decideDeviceFlowStep(deviceStart, { status, message }, NOW)).toEqual({
        kind: "ended",
        status,
        message,
      });
    }
  });

  it("never waits past the moment the code expires", () => {
    const threeSecondsLeft = Date.parse(deviceStart.expiresAt) - 3000;
    expect(decideDeviceFlowStep(deviceStart, undefined, threeSecondsLeft)).toEqual({
      kind: "waiting",
      status: "pending",
      delay: 3000,
    });
    expect(
      decideDeviceFlowStep(deviceStart, { status: "slow-down", interval: 10 }, threeSecondsLeft),
    ).toEqual({ kind: "waiting", status: "slow-down", delay: 3000 });
  });

  it("ends the flow as expired once the code's expiry has passed, whatever the last reply", () => {
    const expiry = Date.parse(deviceStart.expiresAt);
    const ending = { kind: "ended", status: "expired", message: DEVICE_CODE_EXPIRED };
    expect(decideDeviceFlowStep(deviceStart, undefined, expiry)).toEqual(ending);
    for (const status of ["pending", "slow-down", "unreachable"] as const) {
      expect(decideDeviceFlowStep(deviceStart, { status, interval: 5 }, expiry + 1)).toEqual(
        ending,
      );
    }
  });

  it("still returns a reply that ended the flow after the code's expiry", () => {
    const connection = {} as Connection;
    const late = Date.parse(deviceStart.expiresAt) + 60_000;
    expect(decideDeviceFlowStep(deviceStart, { status: "done", connection }, late)).toEqual({
      kind: "done",
      connection,
    });
  });

  it("returns the new connection once the flow is done", () => {
    // The connection is passed through untouched, so any record will do.
    const connection = {} as Connection;
    expect(decideDeviceFlowStep(deviceStart, { status: "done", connection }, NOW)).toEqual({
      kind: "done",
      connection,
    });
  });
});

describe("listCredentialFields", () => {
  it("returns every declared field, in order, across the credential steps", () => {
    const fields = listCredentialFields(
      withSetup([
        { kind: "checklist", markdown: "first" },
        { kind: "credentials", fields: [{ name: "token", label: "Token", help: "paste it" }] },
        { kind: "credentials", fields: [{ name: "secret", label: "Secret" }] },
      ]),
    );

    expect(fields).toEqual([
      { name: "token", label: "Token", help: "paste it" },
      { name: "secret", label: "Secret" },
    ]);
  });

  it("returns no fields for a setup that asks the user to paste nothing", () => {
    expect(listCredentialFields(withSetup([{ kind: "oauth" }]))).toEqual([]);
  });
});

describe("describeDeviceFlowWait", () => {
  it("names the provider while the flow waits, and says a failed check is retried", () => {
    expect(describeDeviceFlowWait("pending", "GitHub")).toBe(
      "Waiting for you to approve Hercule on GitHub.",
    );
    expect(describeDeviceFlowWait("slow-down", "GitHub")).toBe(
      "GitHub asked for slower checks. Still waiting for you to approve the code.",
    );
    expect(describeDeviceFlowWait("unreachable", "GitHub")).toBe(
      "Cannot reach GitHub right now. Still trying.",
    );
    expect(describeDeviceFlowWait("request-failed", "GitHub")).toBe(
      "The last check did not go through. Still trying.",
    );
  });
});

describe("waitForDeviceFlow", () => {
  const POLL = "POST /api/v1/oauth/device/poll";
  const DEVICE_START = {
    setupId: "s-1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://example.test/device",
    expiresAt: "2026-10-02T12:15:00.000Z",
    interval: 5,
  };
  const CONNECTION = {
    id: "0199c0ff-aaaa-7000-8000-000000000001",
    type: "github/github",
    label: "octocat",
    displayName: "octocat",
    status: "connected",
    labels: [],
    config: {},
    feedIntervals: {},
    credentials: [],
    createdAt: "2026-10-02T08:15:00.000Z",
    updatedAt: "2026-10-02T08:15:00.000Z",
  } satisfies Connection;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Fifteen minutes before the code expires.
    vi.setSystemTime("2026-10-02T12:00:00.000Z");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Returns a handler that answers each poll with the next answer, then repeats the last. */
  const answerPolls = (...answers: readonly Answer[]): Handler => {
    let index = 0;
    return () => answers[Math.min(index++, answers.length - 1)]!;
  };

  /** Starts the wait on a stub controller, and records what it reports. */
  const startWait = (poll: Handler, deviceStart = DEVICE_START) => {
    const api = createApiStub({ [POLL]: poll });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });
    const stop = new AbortController();
    const steps: DeviceFlowStep[] = [];
    const failures: unknown[] = [];
    const last = waitForDeviceFlow(client, deviceStart, {
      signal: stop.signal,
      onStep: (step) => steps.push(step),
      onRequestFailure: (error) => failures.push(error),
    });
    const countPolls = () => api.calls.length;
    return { stop, steps, failures, last, countPolls };
  };

  it("polls at the start's interval, then at each reply's, until the flow is done", async () => {
    const wait = startWait(
      answerPolls(
        { body: { status: "pending", interval: 5 } },
        { body: { status: "slow-down", interval: 10 } },
        { body: { status: "done", connection: CONNECTION } },
      ),
    );

    await vi.advanceTimersByTimeAsync(4999);
    expect(wait.countPolls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.countPolls()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(wait.countPolls()).toBe(2);
    // The slow-down reply asked for ten seconds.
    await vi.advanceTimersByTimeAsync(9999);
    expect(wait.countPolls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(await wait.last).toEqual({ kind: "done", connection: CONNECTION });
    expect(wait.steps.map((step) => step.kind)).toEqual(["waiting", "waiting", "done"]);
    expect(wait.countPolls()).toBe(3);
  });

  it("stops at the first reply that ends the flow", async () => {
    const message = "the code expired before it was approved";
    const wait = startWait(answerPolls({ body: { status: "expired", message } }));

    await vi.advanceTimersByTimeAsync(5000);

    expect(await wait.last).toEqual({ kind: "ended", status: "expired", message });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.countPolls()).toBe(1);
  });

  it("keeps polling at the last interval after a poll request fails", async () => {
    const wait = startWait(
      answerPolls(
        { body: { status: "slow-down", interval: 10 } },
        { status: 500, body: buildErrorBody("internal", "the database is locked") },
        { body: { status: "done", connection: CONNECTION } },
      ),
    );

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wait.countPolls()).toBe(2);
    expect(wait.failures).toHaveLength(1);
    expect(readErrorMessage(wait.failures[0])).toBe("the database is locked");

    await vi.advanceTimersByTimeAsync(9999);
    expect(wait.countPolls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await wait.last).kind).toBe("done");
  });

  it("ends as expired when the code expires, without another poll", async () => {
    // The code expires 12 seconds from now: polls go out at 5 and 10 seconds.
    const wait = startWait(answerPolls({ body: { status: "pending", interval: 5 } }), {
      ...DEVICE_START,
      expiresAt: "2026-10-02T12:00:12.000Z",
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(wait.countPolls()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);

    const ending = { kind: "ended", status: "expired", message: DEVICE_CODE_EXPIRED };
    expect(await wait.last).toEqual(ending);
    expect(wait.steps.at(-1)).toEqual(ending);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.countPolls()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends as expired when the code expires after a poll request failed", async () => {
    const wait = startWait(
      answerPolls(
        { body: { status: "pending", interval: 5 } },
        { status: 500, body: buildErrorBody("internal", "the database is locked") },
      ),
      { ...DEVICE_START, expiresAt: "2026-10-02T12:00:12.000Z" },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(wait.failures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);

    expect(await wait.last).toMatchObject({ kind: "ended", status: "expired" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.countPolls()).toBe(2);
  });

  it("reports a code that has expired already as expired, and never polls", async () => {
    const wait = startWait(answerPolls({ body: { status: "pending", interval: 5 } }), {
      ...DEVICE_START,
      expiresAt: "2026-10-02T11:59:00.000Z",
    });

    const ending = { kind: "ended", status: "expired", message: DEVICE_CODE_EXPIRED };
    expect(await wait.last).toEqual(ending);
    expect(wait.steps).toEqual([ending]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.countPolls()).toBe(0);
  });

  it("stops polling and leaves no timer once the signal aborts", async () => {
    const wait = startWait(answerPolls({ body: { status: "pending", interval: 5 } }));

    wait.stop.abort();

    expect(await wait.last).toEqual({ kind: "waiting", status: "pending", delay: 5000 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.countPolls()).toBe(0);
  });

  it("reports no reply that arrives after the signal aborted, but returns it", async () => {
    let answer: (reply: Answer) => void = () => undefined;
    const wait = startWait(
      () =>
        new Promise<Answer>((resolve) => {
          answer = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(wait.countPolls()).toBe(1);

    wait.stop.abort();
    answer({ body: { status: "done", connection: CONNECTION } });

    expect(await wait.last).toEqual({ kind: "done", connection: CONNECTION });
    expect(wait.steps).toEqual([]);
  });
});

describe("describeGitHubSignInEnding", () => {
  it("says how long a code lasts when it expired", () => {
    expect(
      describeGitHubSignInEnding({ kind: "ended", status: "expired", message: "" }, 15),
    ).toEqual({
      kind: "ended",
      status: "expired",
      line: "The sign-in expired before it was approved.",
      next: "A code lasts 15 minutes. Start again for a new one.",
    });
  });

  it("says where the sign-in was declined", () => {
    expect(
      describeGitHubSignInEnding({ kind: "ended", status: "denied", message: "" }, 15).next,
    ).toBe("Hercule was declined on GitHub’s approval page. Start again if that was a mistake.");
  });

  it("passes on the controller's message when the sign-in failed", () => {
    expect(
      describeGitHubSignInEnding(
        { kind: "ended", status: "failed", message: "GitHub could not be reached." },
        15,
      ),
    ).toEqual(describeGitHubSignInFailure("GitHub could not be reached."));
  });
});

describe("describeGitHubSignInFailure", () => {
  it("says nothing changed, then gives the controller's reason", () => {
    expect(describeGitHubSignInFailure("GitHub could not be reached.")).toEqual({
      kind: "ended",
      status: "failed",
      line: "The sign-in did not finish, so nothing changed.",
      next: "GitHub could not be reached.",
    });
  });
});

const REPOS: ConnectionFeed = {
  name: "repos",
  defaultIntervalSeconds: 120,
  minIntervalSeconds: 60,
};
const CHECKS: ConnectionFeed = {
  name: "check_runs",
  defaultIntervalSeconds: 60,
  minIntervalSeconds: 30,
};

describe("describeFeedName", () => {
  it("capitalizes the name and turns dashes and underscores into spaces", () => {
    expect(describeFeedName(REPOS)).toBe("Repos");
    expect(describeFeedName(CHECKS)).toBe("Check runs");
    expect(describeFeedName({ ...REPOS, name: "pull-requests" })).toBe("Pull requests");
  });
});

describe("describeFeedInterval", () => {
  it("names the default and the shortest interval when the default is above it", () => {
    expect(describeFeedInterval(REPOS, "GitHub")).toBe(
      "Every 120 seconds by default. At least 60 seconds.",
    );
  });

  it("says the default is the shortest interval when the two are the same", () => {
    const floor = { ...REPOS, defaultIntervalSeconds: 60, minIntervalSeconds: 60 };
    expect(describeFeedInterval(floor, "GitHub")).toBe(
      "Every 60 seconds by default, the shortest GitHub allows.",
    );
  });
});

describe("buildFeedIntervalsDraft", () => {
  it("holds each stored interval as text, and an empty string for a feed on its default", () => {
    expect(buildFeedIntervalsDraft([REPOS, CHECKS], { repos: 300 })).toEqual({
      repos: "300",
      check_runs: "",
    });
  });

  it("leaves out an interval stored for a feed the type no longer declares", () => {
    expect(buildFeedIntervalsDraft([REPOS], { repos: 300, gone: 90 })).toEqual({ repos: "300" });
  });
});

describe("buildFeedIntervalsPayload", () => {
  it("sends each typed interval as a number and leaves out the empty fields", () => {
    expect(
      buildFeedIntervalsPayload([REPOS, CHECKS], { repos: " 300 ", check_runs: "  " }),
    ).toEqual({ repos: 300 });
  });

  it("sends an empty map when every feed is back on its default", () => {
    expect(buildFeedIntervalsPayload([REPOS, CHECKS], { repos: "", check_runs: "" })).toEqual({});
  });

  it("leaves the minimum to the controller, so a value below it is still sent", () => {
    expect(buildFeedIntervalsPayload([REPOS], { repos: "10" })).toEqual({ repos: 10 });
  });
});

describe("readConnectionIssues", () => {
  const fields = [{ name: "folder" }];

  it("puts each error under the setting or the feed it names", () => {
    const refusal = new ApiError("validation", "refused", {
      issues: [
        { path: ["config", "folder"], message: "must not be empty" },
        { path: ["feedIntervals", "repos"], message: "Poll repos every 60 seconds or slower" },
        { path: ["feedIntervals", "repos"], message: "a second error for the same feed" },
      ],
    });

    expect(readConnectionIssues(refusal, fields, [REPOS])).toEqual({
      config: { folder: "must not be empty" },
      configEntries: {},
      feedIntervals: { repos: "Poll repos every 60 seconds or slower" },
      rest: false,
    });
  });

  it("puts an error about one entry of a list setting under that entry", () => {
    const refusal = new ApiError("validation", "refused", {
      issues: [
        { path: ["config", "repos", "1"], message: "Write the repository as owner/repo." },
        { path: ["config", "repos", "3"], message: "Write the repository as owner/repo." },
      ],
    });

    expect(readConnectionIssues(refusal, [{ name: "repos" }], [REPOS])).toEqual({
      config: {},
      configEntries: {
        repos: {
          1: "Write the repository as owner/repo.",
          3: "Write the repository as owner/repo.",
        },
      },
      feedIntervals: {},
      rest: false,
    });
  });

  it("sets rest for an error on no rendered field, or a failure that is not a validation error", () => {
    const refusal = new ApiError("validation", "refused", {
      issues: [
        { path: ["feedIntervals", "gone"], message: "no feed named gone" },
        { path: ["config", "repos"], message: "a setting, not a feed" },
      ],
    });
    expect(readConnectionIssues(refusal, fields, [REPOS])).toEqual({
      config: {},
      configEntries: {},
      feedIntervals: {},
      rest: true,
    });

    const whole = new ApiError("validation", "refused", {
      issues: [{ path: ["feedIntervals"], message: "too many feeds" }],
    });
    expect(readConnectionIssues(whole, fields, [REPOS]).rest).toBe(true);
    expect(readConnectionIssues(new Error("offline"), fields, [REPOS]).rest).toBe(true);
  });

  it("finds nothing before the first save", () => {
    expect(readConnectionIssues(null, fields, [REPOS])).toEqual({
      config: {},
      configEntries: {},
      feedIntervals: {},
      rest: false,
    });
  });
});
