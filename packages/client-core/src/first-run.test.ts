import { GITHUB_CONNECTION_TYPE, type Connection } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildFirstRunFacts,
  buildRoomContents,
  decideFirstRunStep,
  TRIAGE_READING,
  TRIAGE_WITHOUT_CONNECTIONS,
  type FirstRunFacts,
  type FirstRunReads,
} from "./first-run";
import { BARE, buildInstance, buildSnapshot } from "./providers.testing";
import { buildProject } from "./threads/workspaces.testing";

const GITHUB: Connection = {
  id: "01a06d02-7200-7000-8000-000000000001",
  type: GITHUB_CONNECTION_TYPE,
  label: "rogier",
  displayName: "rogier",
  status: "connected",
  labels: [],
  config: {},
  credentials: [],
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
};

const LOGGED_IN = buildInstance("claude-code", "Claude", [buildSnapshot()]);

/** Reads with nothing done yet. */
const NOTHING: FirstRunReads = {
  setupComplete: false,
  localRunner: null,
  instances: [],
  connections: [],
  projects: [],
};

/** Reads with every step done, on a runner that hosts six sessions. */
const EVERYTHING: FirstRunReads = {
  setupComplete: true,
  localRunner: { ...BARE, maxConcurrentSessions: 6 },
  instances: [LOGGED_IN],
  connections: [GITHUB],
  projects: [buildProject("01a06d02-7000-7000-8000-000000000001", "webshop")],
};

const NONE_DONE: FirstRunFacts = {
  account: false,
  providers: false,
  github: false,
  project: false,
};

describe("buildFirstRunFacts", () => {
  it("marks nothing done on a fresh controller", () => {
    expect(buildFirstRunFacts(NOTHING)).toEqual(NONE_DONE);
  });

  it("marks every step done when the controller holds each piece", () => {
    expect(buildFirstRunFacts(EVERYTHING)).toEqual({
      account: true,
      providers: true,
      github: true,
      project: true,
    });
  });

  it("counts only a login on the controller's local runner", () => {
    const elsewhere = buildInstance("claude-code", "Claude", [
      buildSnapshot({ runnerId: "01a06d02-beff-7037-9f5b-000000000000" }),
    ]);

    expect(buildFirstRunFacts({ ...EVERYTHING, instances: [elsewhere] }).providers).toBe(false);
    expect(buildFirstRunFacts({ ...EVERYTHING, localRunner: null }).providers).toBe(false);
  });

  it("does not count a login that failed", () => {
    const loggedOut = buildInstance("claude-code", "Claude", [
      buildSnapshot({ auth: { status: "unauthenticated" } }),
    ]);

    expect(buildFirstRunFacts({ ...EVERYTHING, instances: [loggedOut] }).providers).toBe(false);
  });

  it("counts only a GitHub Connection", () => {
    const slack = { ...GITHUB, type: "slack/slack" };

    expect(buildFirstRunFacts({ ...EVERYTHING, connections: [slack] }).github).toBe(false);
  });
});

describe("decideFirstRunStep", () => {
  it("returns the first step not done", () => {
    expect(decideFirstRunStep(NONE_DONE, [])).toBe("account");
    expect(decideFirstRunStep({ ...NONE_DONE, account: true }, [])).toBe("providers");
  });

  it("skips a step the user put off", () => {
    expect(decideFirstRunStep({ ...NONE_DONE, account: true }, ["providers", "github"])).toBe(
      "project",
    );
  });

  it("returns a step done before an earlier one", () => {
    expect(decideFirstRunStep({ ...NONE_DONE, account: true, github: true }, [])).toBe("providers");
  });

  it("returns done when every step is done or put off", () => {
    expect(
      decideFirstRunStep({ account: true, providers: true, github: false, project: true }, [
        "github",
      ]),
    ).toBe("done");
  });
});

describe("buildRoomContents", () => {
  const ROOM = { answered: true, controllerOnThisMac: true, putOff: [] } as const;

  it("draws a dark, empty room until Hercule answers", () => {
    expect(buildRoomContents({ ...NOTHING, ...ROOM, answered: false })).toEqual({
      lights: false,
      yourDesk: false,
      wing: null,
      triage: null,
      github: null,
      firstThread: null,
    });
  });

  it("puts your desk in the room once the account exists", () => {
    const room = buildRoomContents({ ...NOTHING, ...ROOM, setupComplete: true });

    expect(room.lights).toBe(true);
    expect(room.yourDesk).toBe(true);
    expect(room.wing).toBeNull();
  });

  it("draws everything once every step is done", () => {
    expect(buildRoomContents({ ...EVERYTHING, ...ROOM })).toEqual({
      lights: true,
      yourDesk: true,
      wing: { runnerName: "moss", desks: 6, note: "this Mac · 6 desks" },
      triage: { label: TRIAGE_READING },
      github: { account: "rogier" },
      firstThread: { projectId: "01a06d02-7000-7000-8000-000000000001", projectName: "webshop" },
    });
  });

  it("names no time in Triage's line", () => {
    expect(TRIAGE_READING).not.toMatch(/\d/);
    expect(TRIAGE_WITHOUT_CONNECTIONS).not.toMatch(/\d/);
  });

  it("seats at most eight desks, and leaves this Mac off the plate of a remote controller", () => {
    const room = buildRoomContents({
      ...EVERYTHING,
      ...ROOM,
      controllerOnThisMac: false,
      localRunner: { ...BARE, maxConcurrentSessions: 12 },
    });

    expect(room.wing).toEqual({ runnerName: "moss", desks: 8, note: "8 desks" });
  });

  it("writes one desk in the singular", () => {
    const room = buildRoomContents({
      ...EVERYTHING,
      ...ROOM,
      localRunner: { ...BARE, maxConcurrentSessions: 1 },
    });

    expect(room.wing?.note).toBe("this Mac · 1 desk");
  });

  it("seats Triage with no Connection when the user put GitHub off", () => {
    const room = buildRoomContents({
      ...EVERYTHING,
      ...ROOM,
      connections: [],
      putOff: ["github"],
    });

    expect(room.triage).toEqual({ label: TRIAGE_WITHOUT_CONNECTIONS });
    expect(room.github).toBeNull();
  });

  it("names the plaque after the Connection when its account has no name", () => {
    const room = buildRoomContents({
      ...EVERYTHING,
      ...ROOM,
      connections: [{ ...GITHUB, label: "GitHub", displayName: " " }],
    });

    expect(room.github).toEqual({ account: "GitHub" });
  });

  it("draws the first thread only when a provider is logged in, in the oldest project", () => {
    const older = {
      ...buildProject("01a06d02-7000-7000-8000-000000000002", "ops"),
      createdAt: "2026-09-01T09:00:00.000Z",
    };
    const room = buildRoomContents({
      ...EVERYTHING,
      ...ROOM,
      projects: [...EVERYTHING.projects, older],
    });

    expect(room.firstThread?.projectName).toBe("ops");
    expect(buildRoomContents({ ...EVERYTHING, ...ROOM, instances: [] }).firstThread).toBeNull();
  });
});
