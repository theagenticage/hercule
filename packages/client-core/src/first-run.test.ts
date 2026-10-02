import { GITHUB_CONNECTION_TYPE, type Assistant, type Connection } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildFirstRunFacts,
  buildRoomContents,
  decideFirstRunStep,
  TRIAGE_READING_GITHUB,
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
  const HERCULE: Assistant = {
    id: "01a06d02-a000-7000-8000-000000000001",
    name: "Hercule",
    systemPrompt: "You are Hercule.",
    instanceId: "01a06d02-1000-7000-8000-000000000001",
    permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
    accessMode: "auto-accept-edits",
    model: null,
    disallowedTools: [],
    unenforced: [],
    heartbeat: { enabled: false, schedule: "0 7-23 * * *", prompt: "Check in.", target: "web" },
    rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
    reply: "turn-end",
    createdAt: "2026-09-05T09:00:00.000Z",
    updatedAt: "2026-09-05T09:00:00.000Z",
  };
  const ROOM = {
    answered: true,
    controllerOnThisMac: true,
    assistants: [HERCULE],
    putOff: [],
  } as const;

  it("draws a dimmed, empty room until Hercule answers", () => {
    expect(buildRoomContents({ ...NOTHING, ...ROOM, answered: false })).toEqual({
      lightsOn: false,
      wing: null,
      yourDesk: false,
      assistant: null,
      triage: null,
      gitHubAccount: null,
    });
  });

  it("stands the wing, with no desks, as soon as the local runner is known", () => {
    const room = buildRoomContents({ ...NOTHING, ...ROOM, localRunner: BARE });

    expect(room.wing).toEqual({
      runnerName: "moss",
      note: "this Mac",
      deskCount: 0,
      firstThread: null,
    });
    expect(
      buildRoomContents({ ...NOTHING, ...ROOM, localRunner: BARE, controllerOnThisMac: false }).wing
        ?.note,
    ).toBe("");
  });

  it("puts your desk and the assistant in the room once the account exists", () => {
    const room = buildRoomContents({ ...NOTHING, ...ROOM, setupComplete: true });

    expect(room.lightsOn).toBe(true);
    expect(room.yourDesk).toBe(true);
    expect(room.assistant).toEqual({ name: "Hercule" });
  });

  it("draws everything once every step is done", () => {
    expect(buildRoomContents({ ...EVERYTHING, ...ROOM })).toEqual({
      lightsOn: true,
      wing: {
        runnerName: "moss",
        note: "this Mac · 6 desks",
        deskCount: 6,
        firstThread: {
          projectId: "01a06d02-7000-7000-8000-000000000001",
          projectName: "webshop",
        },
      },
      yourDesk: true,
      assistant: { name: "Hercule" },
      triage: { note: TRIAGE_READING_GITHUB },
      gitHubAccount: "rogier",
    });
  });

  it("names no time in Triage's note", () => {
    expect(TRIAGE_READING_GITHUB).not.toMatch(/\d/);
    expect(TRIAGE_WITHOUT_CONNECTIONS).not.toMatch(/\d/);
  });

  it("seats at most eight desks, and leaves this Mac off the plate of a remote controller", () => {
    const room = buildRoomContents({
      ...EVERYTHING,
      ...ROOM,
      controllerOnThisMac: false,
      localRunner: { ...BARE, maxConcurrentSessions: 12 },
    });

    expect(room.wing).toMatchObject({ deskCount: 8, note: "8 desks" });
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

    expect(room.triage).toEqual({ note: TRIAGE_WITHOUT_CONNECTIONS });
    expect(room.gitHubAccount).toBeNull();
  });

  it("names the plaque after the Connection when its account has no name", () => {
    const room = buildRoomContents({
      ...EVERYTHING,
      ...ROOM,
      connections: [{ ...GITHUB, label: "GitHub", displayName: " " }],
    });

    expect(room.gitHubAccount).toBe("GitHub");
  });

  it("seats the oldest assistant", () => {
    const newer = { ...HERCULE, name: "Ada", createdAt: "2026-09-06T09:00:00.000Z" };
    const room = buildRoomContents({ ...EVERYTHING, ...ROOM, assistants: [newer, HERCULE] });

    expect(room.assistant).toEqual({ name: "Hercule" });
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

    expect(room.wing?.firstThread?.projectName).toBe("ops");
    expect(
      buildRoomContents({ ...EVERYTHING, ...ROOM, instances: [] }).wing?.firstThread,
    ).toBeNull();
  });
});
