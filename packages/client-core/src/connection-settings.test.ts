import { describe, expect, it } from "vitest";
import type { Connection } from "@hercule/contract";
import {
  buildFeedIntervalsDraft,
  buildFeedIntervalsPayload,
  buildRedirectUriToRegister,
  buildTopicsUpdate,
  decideFieldChoices,
  describeConnectionHealth,
  describeConnectionTypeName,
  describeFeedInterval,
  describeFeedName,
  FEED_INTERVAL_UNREADABLE,
  findOAuthConnection,
  listFlowSwitches,
  readConnectionIssues,
  summarizeConnections,
  summarizeConnectionType,
} from "./connection-settings";
import type { ConnectionFeed, ConnectionType } from "./connection-types";
import { ApiError, readErrorMessage } from "./errors";

const withSetup = (setup: ConnectionType["setup"]): ConnectionType => ({
  type: "p/t",
  displayName: "T",
  pluginName: "P",
  setup,
  hasPublicClient: false,
  feeds: [],
});

const CONNECTION = {
  id: "0199c0ff-aaaa-7000-8000-000000000001",
  type: "p/t",
  label: "work",
  displayName: "work",
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [{ name: "token", rotatedAt: "2026-10-02T08:15:00.000Z" }],
  createdAt: "2026-10-02T08:15:00.000Z",
  updatedAt: "2026-10-02T08:15:00.000Z",
} satisfies Connection;

describe("describeConnectionHealth", () => {
  it("words every status, drawing only an error as a failure", () => {
    expect(describeConnectionHealth({ status: "connected" })).toEqual({
      text: "healthy",
      failing: false,
    });
    expect(describeConnectionHealth({ status: "needs-reauth" })).toEqual({
      text: "needs sign-in",
      failing: false,
    });
    expect(describeConnectionHealth({ status: "disabled" })).toEqual({
      text: "disabled",
      failing: false,
    });
    expect(
      describeConnectionHealth({ status: "error", statusDetail: "rate limited by GitHub" }),
    ).toEqual({ text: "rate limited by GitHub", failing: true });
  });

  it("says error when the controller gave no detail", () => {
    expect(describeConnectionHealth({ status: "error" }).text).toBe("error");
    expect(describeConnectionHealth({ status: "error", statusDetail: "  " }).text).toBe("error");
  });
});

describe("summarizeConnections", () => {
  const quiet = { ...CONNECTION, id: "0199c0ff-aaaa-7000-8000-000000000002" };
  const failing = {
    ...CONNECTION,
    id: "0199c0ff-aaaa-7000-8000-000000000003",
    status: "error",
  } satisfies Connection;
  const hours = (busy: Readonly<Record<number, number>>): ReadonlyArray<number> =>
    Array.from({ length: 24 }, (_, index) => busy[index] ?? 0);

  const summary = summarizeConnections([CONNECTION, quiet, failing], {
    connections: [
      { connectionId: CONNECTION.id, hourly: hours({ 0: 1, 22: 3, 23: 4 }) },
      { connectionId: failing.id, hourly: hours({ 5: 2 }) },
      // A Connection deleted since the counts were read.
      { connectionId: "0199c0ff-aaaa-7000-8000-0000000000ff", hourly: hours({ 0: 100 }) },
    ],
  });

  it("totals each Connection's hours, and the listed Connections' totals", () => {
    expect(summary.activity.get(CONNECTION.id)?.total).toBe(8);
    expect(summary.activity.get(failing.id)?.total).toBe(2);
    expect(summary.eventCount).toBe(10);
  });

  it("draws each hour's bar against the Connection's busiest hour", () => {
    expect(summary.activity.get(CONNECTION.id)?.barHeights).toEqual(
      hours({ 0: 25, 22: 75, 23: 100 }),
    );
  });

  it("gives a Connection the counts leave out 24 empty hours", () => {
    expect(summary.activity.get(quiet.id)).toEqual({
      hourly: hours({}),
      barHeights: hours({}),
      total: 0,
    });
  });

  it("counts the failing Connections", () => {
    expect(summary.failingCount).toBe(1);
  });
});

describe("describeConnectionTypeName", () => {
  it("is the type's display name when the type is known", () => {
    expect(describeConnectionTypeName(CONNECTION, withSetup([]))).toBe("T");
  });

  it("is the raw type when no plugin declares the type", () => {
    expect(describeConnectionTypeName(CONNECTION, undefined)).toBe("p/t");
  });
});

describe("summarizeConnectionType", () => {
  it("leads with the plugin, then joins the flows, reading two sign-ins as one", () => {
    const type = withSetup([
      { kind: "device" },
      { kind: "oauth" },
      { kind: "credentials", fields: [{ name: "pat", label: "Token" }] },
    ]);
    expect(summarizeConnectionType(type)).toBe("P · sign in with T or paste a token");
  });

  it("words the credentials setup as its switch does, from the fields it asks for", () => {
    const type = withSetup([
      { kind: "device" },
      {
        kind: "credentials",
        fields: [
          { name: "token", label: "Token" },
          { name: "org", label: "Organization slug" },
        ],
      },
    ]);
    expect(summarizeConnectionType(type)).toBe("P · sign in with T or enter credentials");
  });

  it("describes a pairing setup", () => {
    expect(summarizeConnectionType(withSetup([{ kind: "pairing" }]))).toBe(
      "P · pair a chat account",
    );
  });

  it("leaves out a plugin named like its type", () => {
    expect(summarizeConnectionType({ ...withSetup([{ kind: "device" }]), pluginName: "T" })).toBe(
      "sign in with T",
    );
  });

  it("shows the type's id for a setup this build cannot show", () => {
    expect(summarizeConnectionType({ ...withSetup([]), pluginName: "T" })).toBe("p/t");
  });
});

describe("listFlowSwitches", () => {
  const token = {
    kind: "credentials",
    fields: [{ name: "pat", label: "Personal access token" }],
  } as const;

  it("offers every flow but the current one, in declared order", () => {
    const type = withSetup([{ kind: "device" }, token]);
    expect(listFlowSwitches(type, "device")).toEqual([
      { flow: "credentials", label: "Paste a token instead" },
    ]);
    expect(listFlowSwitches(type, "credentials")).toEqual([
      { flow: "device", label: "Sign in with T instead" },
    ]);
  });

  it("never offers pairing, which no screen can run yet", () => {
    const type = withSetup([token, { kind: "pairing" }]);
    expect(listFlowSwitches(type, "credentials")).toEqual([]);
  });

  it("tells the two sign-in flows apart when the type offers both", () => {
    const type = withSetup([{ kind: "device" }, { kind: "oauth" }, token]);
    expect(listFlowSwitches(type, "credentials")).toEqual([
      { flow: "device", label: "Sign in with a code instead" },
      { flow: "oauth", label: "Sign in with T in the browser instead" },
    ]);
  });

  it("names a redirect sign-in after the provider when it is the only sign-in", () => {
    expect(listFlowSwitches(withSetup([token, { kind: "oauth" }]), "credentials")).toEqual([
      { flow: "oauth", label: "Sign in with T instead" },
    ]);
  });

  it("names the one field a credentials flow asks for when it is not a token", () => {
    const apiKey = withSetup([
      { kind: "device" },
      { kind: "credentials", fields: [{ name: "key", label: "API key" }] },
    ]);
    expect(listFlowSwitches(apiKey, "device")).toEqual([
      { flow: "credentials", label: "Enter your API key instead" },
    ]);
    const password = withSetup([
      { kind: "device" },
      { kind: "credentials", fields: [{ name: "password", label: "Password" }] },
    ]);
    expect(listFlowSwitches(password, "device")).toEqual([
      { flow: "credentials", label: "Enter your password instead" },
    ]);
  });

  it("asks for credentials when the flow has several fields", () => {
    const type = withSetup([
      { kind: "oauth" },
      {
        kind: "credentials",
        fields: [
          { name: "token", label: "Bot token" },
          { name: "secret", label: "Signing secret" },
        ],
      },
    ]);
    expect(listFlowSwitches(type, "oauth")).toEqual([
      { flow: "credentials", label: "Enter credentials instead" },
    ]);
  });
});

describe("findOAuthConnection", () => {
  const added = { ...CONNECTION, id: "0199c0ff-aaaa-7000-8000-000000000002" };
  const otherType = { ...added, type: "p/other" };
  const reconnect = { type: "p/t", connectionId: CONNECTION.id };
  const later = "2026-10-02T09:00:00.000Z";
  const waiting = { ...CONNECTION, status: "needs-reauth" as const };

  it("finds a new Connection of the type", () => {
    expect(findOAuthConnection([CONNECTION], [CONNECTION, added], { type: "p/t" })).toBe(added);
  });

  it("finds nothing while no new Connection of the type is there", () => {
    expect(findOAuthConnection([CONNECTION], [CONNECTION], { type: "p/t" })).toBeUndefined();
    expect(
      findOAuthConnection([CONNECTION], [CONNECTION, otherType], { type: "p/t" }),
    ).toBeUndefined();
  });

  it("finds a reconnected Connection once its credential is rotated and it is connected", () => {
    const after = { ...CONNECTION, credentials: [{ name: "token", rotatedAt: later }] };
    expect(findOAuthConnection([waiting], [after], reconnect)).toBe(after);
  });

  it("finds a reconnected Connection that gained a credential under a new name", () => {
    const after = {
      ...CONNECTION,
      credentials: [...CONNECTION.credentials, { name: "refresh", rotatedAt: later }],
    };
    expect(findOAuthConnection([waiting], [after], reconnect)).toBe(after);
  });

  it("does not count a write that replaced no credential", () => {
    const renamed = { ...CONNECTION, label: "renamed", updatedAt: later };
    const configured = { ...CONNECTION, config: { org: "acme" }, updatedAt: later };
    const recovered = { ...CONNECTION, updatedAt: later };
    expect(findOAuthConnection([CONNECTION], [renamed], reconnect)).toBeUndefined();
    expect(findOAuthConnection([CONNECTION], [configured], reconnect)).toBeUndefined();
    expect(findOAuthConnection([waiting], [recovered], reconnect)).toBeUndefined();
  });

  it("does not count a rotated credential while the Connection is not connected", () => {
    const after = { ...waiting, credentials: [{ name: "token", rotatedAt: later }] };
    expect(findOAuthConnection([waiting], [after], reconnect)).toBeUndefined();
  });

  it("finds nothing when the Connection is gone from the later list", () => {
    expect(findOAuthConnection([waiting], [], reconnect)).toBeUndefined();
  });

  it("reads every credential as new when the earlier list did not have the Connection", () => {
    expect(findOAuthConnection([], [CONNECTION], reconnect)).toBe(CONNECTION);
    const noCredentials = { ...CONNECTION, credentials: [] };
    expect(findOAuthConnection([], [noCredentials], reconnect)).toBeUndefined();
  });
});

describe("decideFieldChoices", () => {
  const choices = [{ value: "acme", label: "Acme" }];

  it("is loading until the data is there", () => {
    expect(decideFieldChoices({ isError: false, error: null, data: undefined })).toEqual({
      status: "loading",
    });
  });

  it("is loaded with the data", () => {
    expect(decideFieldChoices({ isError: false, error: null, data: choices })).toEqual({
      status: "loaded",
      choices,
    });
  });

  it("is failed with the error's message, even when older data is there", () => {
    const error = new ApiError("internal", "GitHub is down");
    expect(decideFieldChoices({ isError: true, error, data: choices })).toEqual({
      status: "failed",
      message: readErrorMessage(error),
    });
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

describe("buildRedirectUriToRegister", () => {
  const OAUTH_TYPE = withSetup([{ kind: "oauth" }]);

  it("is the callback path on the browser's origin", () => {
    expect(buildRedirectUriToRegister(OAUTH_TYPE, "https://n.tail.ts.net")).toBe(
      "https://n.tail.ts.net/oauth/callback",
    );
  });

  it("does not double the slash when the origin ends in one", () => {
    expect(buildRedirectUriToRegister(OAUTH_TYPE, "https://n.tail.ts.net/")).toBe(
      "https://n.tail.ts.net/oauth/callback",
    );
  });

  it("is absent for a type whose plugin ships a public client, which registered its own", () => {
    expect(
      buildRedirectUriToRegister({ ...OAUTH_TYPE, hasPublicClient: true }, "http://127.0.0.1:4937"),
    ).toBeUndefined();
  });
});

/** Returns a plugin from the plugin list, with the given contributions. */

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
    ).toEqual({ feedIntervals: { repos: 300 } });
  });

  it("sends an empty map when every feed is back on its default", () => {
    expect(buildFeedIntervalsPayload([REPOS, CHECKS], { repos: "", check_runs: "" })).toEqual({
      feedIntervals: {},
    });
  });

  it("leaves the minimum to the controller, so a value below it is still sent", () => {
    expect(buildFeedIntervalsPayload([REPOS], { repos: "10" })).toEqual({
      feedIntervals: { repos: 10 },
    });
  });

  it("refuses text that is not a whole number of seconds, on the feed that holds it", () => {
    expect(buildFeedIntervalsPayload([REPOS, CHECKS], { repos: "abc", check_runs: "90" })).toEqual({
      errors: { repos: FEED_INTERVAL_UNREADABLE },
    });
  });

  // `Number` reads every one of these as a number or as NaN, so each would
  // otherwise save a value the user did not type or fail with a type error.
  it.each(["1.5", "-5", "1e3", "0x10", "12 s", "+60"])("refuses %j", (typed) => {
    expect(buildFeedIntervalsPayload([REPOS], { repos: typed })).toEqual({
      errors: { repos: FEED_INTERVAL_UNREADABLE },
    });
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
