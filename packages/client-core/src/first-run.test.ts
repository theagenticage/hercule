import { GITHUB_CONNECTION_TYPE, type Assistant, type Connection } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  addPutOffStep,
  buildAllSetRecap,
  findDoneSteps,
  buildFirstRunHost,
  buildFirstRunLadder,
  buildProvidersStepText,
  buildRoomContents,
  decideFirstRunStep,
  findGitHubAccount,
  TRIAGE_READING_GITHUB,
  TRIAGE_WITHOUT_CONNECTIONS,
  type FirstRunDoneSteps,
  type FirstRunReads,
} from "./first-run";
import { buildProviderRows } from "./provider-rows";
import { BARE, buildInstance, buildSnapshot, WITH_CLAUDE } from "./providers.testing";
import { buildProject, buildRepo } from "./threads/workspaces.testing";

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

const NONE_DONE: FirstRunDoneSteps = {
  account: false,
  providers: false,
  github: false,
  project: false,
};

describe("findDoneSteps", () => {
  it("marks nothing done on a fresh controller", () => {
    expect(findDoneSteps(NOTHING)).toEqual(NONE_DONE);
  });

  it("marks every step done when the controller holds each piece", () => {
    expect(findDoneSteps(EVERYTHING)).toEqual({
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

    expect(findDoneSteps({ ...EVERYTHING, instances: [elsewhere] }).providers).toBe(false);
    expect(findDoneSteps({ ...EVERYTHING, localRunner: null }).providers).toBe(false);
  });

  it("does not count a login that failed", () => {
    const loggedOut = buildInstance("claude-code", "Claude", [
      buildSnapshot({ auth: { status: "unauthenticated" } }),
    ]);

    expect(findDoneSteps({ ...EVERYTHING, instances: [loggedOut] }).providers).toBe(false);
  });

  it("counts only a GitHub Connection", () => {
    const slack = { ...GITHUB, type: "slack/slack" };

    expect(findDoneSteps({ ...EVERYTHING, connections: [slack] }).github).toBe(false);
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

  it("returns all-set when every step is done or put off", () => {
    expect(
      decideFirstRunStep({ account: true, providers: true, github: false, project: true }, [
        "github",
      ]),
    ).toBe("all-set");
  });
});

describe("addPutOffStep", () => {
  it("adds the step after the steps already put off", () => {
    expect(addPutOffStep(["providers"], "github")).toEqual(["providers", "github"]);
  });

  it("keeps both steps of two put off in quick succession", () => {
    // Each put-off reads the list the one before it returned.
    const first = addPutOffStep([], "providers");
    expect(addPutOffStep(first, "github")).toEqual(["providers", "github"]);
  });

  it("returns the list itself when the step is already put off", () => {
    const putOff = ["providers"] as const;
    expect(addPutOffStep(putOff, "providers")).toBe(putOff);
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
    canSignInOrSetUp: true,
    controllerOnThisMac: true,
    assistants: [HERCULE],
    putOff: [],
  } as const;

  it("draws a dimmed, empty room until Hercule answers", () => {
    expect(buildRoomContents({ ...NOTHING, ...ROOM, canSignInOrSetUp: false })).toEqual({
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

  it("seats at most eight desks but writes the runner's real count on the plate, and leaves this Mac off the plate of a remote controller", () => {
    const room = buildRoomContents({
      ...EVERYTHING,
      ...ROOM,
      controllerOnThisMac: false,
      localRunner: { ...BARE, maxConcurrentSessions: 12 },
    });

    expect(room.wing).toMatchObject({ deskCount: 8, note: "12 desks" });
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

describe("buildFirstRunHost", () => {
  it("names this Mac for a controller on this machine", () => {
    expect(buildFirstRunHost("http://127.0.0.1:4937", null)).toEqual({
      name: "this Mac",
      isThisMac: true,
    });
  });

  it("names the controller's runner for a controller elsewhere", () => {
    expect(buildFirstRunHost("http://build-box:4937", WITH_CLAUDE)).toEqual({
      name: WITH_CLAUDE.name,
      isThisMac: false,
    });
    expect(buildFirstRunHost("http://build-box:4937", null).name).toBe(
      "the machine that runs Hercule",
    );
  });
});

describe("buildProvidersStepText", () => {
  const INSTANCES = [
    buildInstance("claude-code", "Claude Code"),
    buildInstance("codex", "Codex"),
    buildInstance("pi", "pi"),
  ];
  const THIS_MAC = { name: "this Mac", isThisMac: true };

  it("waits for the runner while the controller has none", () => {
    const text = buildProvidersStepText(null, THIS_MAC);

    expect(text.heading).toBe("Waiting for the runner");
    expect(text.subheading).toContain("the one on this Mac hasn’t joined Hercule yet");
    expect(text.rows).toEqual([]);
  });

  it("names and lists only the harnesses found on the machine", () => {
    const text = buildProvidersStepText(buildProviderRows(WITH_CLAUDE, INSTANCES), THIS_MAC);

    expect(text.heading).toBe("Claude Code is on this Mac");
    expect(text.subheading).toBe(
      "Log in to the ones you want your agents to use. The login runs on this Mac and its credential stays here.",
    );
    expect(text.rows.map((row) => row.name)).toEqual(["Claude Code"]);
  });

  it("joins several found harnesses with and, and says the credential stays on another machine", () => {
    const runner = {
      ...WITH_CLAUDE,
      facts: {
        ...WITH_CLAUDE.facts!,
        providers: [
          { name: "claude", present: true, path: "/usr/local/bin/claude" },
          { name: "codex", present: true },
          { name: "pi", present: false },
        ],
      },
    };
    const text = buildProvidersStepText(buildProviderRows(runner, INSTANCES), {
      name: "moss",
      isThisMac: false,
    });

    expect(text.heading).toBe("Claude Code and Codex are on moss");
    expect(text.subheading).toContain("The login runs on moss and its credential stays there.");
  });

  it("lists every harness when none was found", () => {
    const text = buildProvidersStepText(buildProviderRows(BARE, INSTANCES), THIS_MAC);

    expect(text.heading).toBe("Your agents need a coding tool");
    expect(text.subheading).toBe(
      "Hercule drives Claude Code, Codex or pi, and found none of them on this Mac. Install one and log in to it; Hercule can install it for you.",
    );
    expect(text.rows).toHaveLength(3);
  });
});

describe("buildFirstRunLadder", () => {
  it("marks the step on screen, the steps done, and the steps put off", () => {
    expect(
      buildFirstRunLadder("github", { ...NONE_DONE, account: true }, ["providers"]).map(
        (rung) => rung.status,
      ),
    ).toEqual(["done", "put-off", "now", "next"]);
  });

  it("ticks a step done after the current one, when the user went back", () => {
    expect(
      buildFirstRunLadder("providers", { ...NONE_DONE, account: true, project: true }, []).map(
        (rung) => rung.status,
      ),
    ).toEqual(["done", "now", "next", "done"]);
  });

  it("shows every step as done or put off on All set", () => {
    expect(
      buildFirstRunLadder(
        "all-set",
        { account: true, providers: true, github: false, project: true },
        ["github"],
      ).map((rung) => rung.status),
    ).toEqual(["done", "done", "put-off", "done"]);
  });
});

describe("buildAllSetRecap", () => {
  const PROJECT_ID = "01a06d02-7000-7000-8000-000000000001";

  it("lists the providers logged in, the GitHub account, and the project with its repository", () => {
    const recap = buildAllSetRecap({
      ...EVERYTHING,
      resources: [
        buildRepo("r1", "git@github.com:rogier/webshop.git", "github.com/rogier/webshop", [
          PROJECT_ID,
        ]),
      ],
    });

    expect(recap).toEqual({
      providerNames: "Claude",
      providerId: "claude-code",
      gitHubAccount: "rogier",
      project: { id: PROJECT_ID, name: "webshop", repository: "rogier/webshop" },
    });
  });

  it("names a repository whose remote has no owner/name by its label", () => {
    const recap = buildAllSetRecap({
      ...EVERYTHING,
      resources: [
        { ...buildRepo("r1", "/srv/git/webshop", null, [PROJECT_ID]), label: "webshop on the NAS" },
      ],
    });

    expect(recap.project?.repository).toBe("webshop on the NAS");
  });

  it("leaves everything empty when nothing is logged in and the project has no repository", () => {
    const recap = buildAllSetRecap({
      ...EVERYTHING,
      instances: [buildInstance("claude-code", "Claude Code")],
      connections: [],
      resources: [],
    });

    expect(recap.providerNames).toBeNull();
    // The row still draws a mark: the first provider listed.
    expect(recap.providerId).toBe("claude-code");
    expect(recap.gitHubAccount).toBeNull();
    expect(recap.project?.repository).toBeNull();
  });
});

describe("findGitHubAccount", () => {
  // The New project form clones through the first GitHub Connection in the
  // list, so All set names that one, not the oldest.
  it("returns the account of the first GitHub Connection in the list", () => {
    const older = {
      ...GITHUB,
      id: "c2",
      displayName: "older",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    expect(findGitHubAccount([GITHUB, older])).toBe("rogier");
  });

  it("returns the label of a Connection with no account name", () => {
    expect(findGitHubAccount([{ ...GITHUB, displayName: " ", label: "GitHub" }])).toBe("GitHub");
  });

  it("returns null without a GitHub Connection", () => {
    expect(findGitHubAccount([{ ...GITHUB, type: "gmail" }])).toBeNull();
  });
});
