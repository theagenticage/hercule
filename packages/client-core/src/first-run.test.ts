import { GITHUB_CONNECTION_TYPE, type Assistant, type Connection } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildAllSetRecap,
  buildFirstRunFacts,
  buildFirstRunHost,
  buildFirstRunLadder,
  buildProvidersStepText,
  buildRoomContents,
  countCodeMinutes,
  decideFirstRunStep,
  describeGitHubSignInEnding,
  formatControllerAddress,
  isLoopbackOrigin,
  TRIAGE_READING_GITHUB,
  TRIAGE_WITHOUT_CONNECTIONS,
  type FirstRunFacts,
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

describe("isLoopbackOrigin", () => {
  it("accepts an origin on this machine", () => {
    for (const origin of ["http://127.0.0.1:4937", "http://localhost:4937", "http://[::1]:4937"]) {
      expect(isLoopbackOrigin(origin)).toBe(true);
    }
  });

  it("refuses an origin on another machine, and one that does not parse", () => {
    for (const origin of ["http://10.0.0.2:4937", "https://hercule.example", "not a url"]) {
      expect(isLoopbackOrigin(origin)).toBe(false);
    }
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
    expect(text.sub).toContain("the one on this Mac hasn’t joined Hercule yet");
    expect(text.rows).toEqual([]);
  });

  it("names and lists only the harnesses found on the machine", () => {
    const text = buildProvidersStepText(buildProviderRows(WITH_CLAUDE, INSTANCES), THIS_MAC);

    expect(text.heading).toBe("Claude Code is on this Mac");
    expect(text.sub).toBe(
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
    expect(text.sub).toContain("The login runs on moss and its credential stays there.");
  });

  it("lists every harness when none was found", () => {
    const text = buildProvidersStepText(buildProviderRows(BARE, INSTANCES), THIS_MAC);

    expect(text.heading).toBe("Your agents need a coding tool");
    expect(text.sub).toBe(
      "Hercule drives Claude Code, Codex or pi, and found none of them on this Mac. Install one and log in to it; Hercule can install it for you.",
    );
    expect(text.rows).toHaveLength(3);
  });
});

describe("countCodeMinutes", () => {
  const NOW = Date.parse("2026-10-02T09:00:00.000Z");

  it("rounds the time a code has left up to whole minutes", () => {
    expect(countCodeMinutes("2026-10-02T09:15:00.000Z", NOW)).toBe(15);
    expect(countCodeMinutes("2026-10-02T09:14:01.000Z", NOW)).toBe(15);
  });

  it("never says less than a minute", () => {
    expect(countCodeMinutes("2026-10-02T08:59:00.000Z", NOW)).toBe(1);
  });
});

describe("describeGitHubSignInEnding", () => {
  it("says how long a code lasts when it expired", () => {
    expect(
      describeGitHubSignInEnding({ kind: "ended", status: "expired", message: "" }, 15),
    ).toEqual({
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
    ).toEqual({
      line: "The sign-in did not finish, so nothing changed.",
      next: "GitHub could not be reached.",
    });
  });
});

describe("buildFirstRunLadder", () => {
  const NONE: FirstRunFacts = { account: false, providers: false, github: false, project: false };

  it("marks the step on screen, the steps done, and the steps put off", () => {
    expect(
      buildFirstRunLadder("github", { ...NONE, account: true }, ["providers"]).map(
        (rung) => rung.status,
      ),
    ).toEqual(["done", "put-off", "now", "next"]);
  });

  it("ticks a step done after the current one, when the user went back", () => {
    expect(
      buildFirstRunLadder("providers", { ...NONE, account: true, project: true }, []).map(
        (rung) => rung.status,
      ),
    ).toEqual(["done", "now", "next", "done"]);
  });

  it("shows every step as done or put off on All set", () => {
    expect(
      buildFirstRunLadder(
        "done",
        { account: true, providers: true, github: false, project: true },
        ["github"],
      ).map((rung) => rung.status),
    ).toEqual(["done", "done", "put-off", "done"]);
  });
});

describe("formatControllerAddress", () => {
  it("drops the scheme", () => {
    expect(formatControllerAddress("http://127.0.0.1:4937")).toBe("127.0.0.1:4937");
  });

  it("returns what does not parse unchanged", () => {
    expect(formatControllerAddress("not an origin")).toBe("not an origin");
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

  it("says when nothing is logged in and the project has no repository", () => {
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
