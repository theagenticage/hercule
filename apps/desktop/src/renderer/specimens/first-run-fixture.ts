/**
 * The scenes of the first-run specimen (first-run.tsx): for each state in
 * first-run-states.ts, what main and the controller answer, and the clicks
 * and typing that bring the real first run to that state.
 *
 * The records match the Bureau book's desktop/first-run.html: the user
 * rogier on studio-mac, whose runner has Claude Code and Codex in
 * /opt/homebrew/bin, the GitHub account rogier, and the repository
 * ~/Dev/webshop.
 *
 * Nothing here imports vitest, so the specimen can run it in a plain page.
 */
import type { FetchLike } from "@hercule/client-core";
import { createApiStub, type Answer, type Handler } from "@hercule/client-core/testing";
import { buildProject, buildRepo, buildRunner } from "@hercule/client-core/threads/testing";
import {
  GITHUB_CONNECTION_TYPE,
  type Assistant,
  type Connection,
  type ProviderInstance,
  type Project,
  type Resource,
  type Runner,
} from "@hercule/contract";
import type { Bridge } from "../../ipc/bridge";
import type {
  FirstRunProgress,
  FolderPickOutcome,
  LocalControllerFindOutcome,
  LocalControllerStartOutcome,
  SetupTokenReadOutcome,
} from "../../ipc/contract";
import type { FirstRunStateName } from "./first-run-states";

/** What main and the controller answer in one state, and how the page gets there. */
export interface FirstRunScene {
  readonly bridge: Bridge;
  /** The `fetch` the app's client sends its requests to. */
  readonly fetch: FetchLike;
  /** Clicks and types in the page until it shows the state. Absent when the first render shows it. */
  readonly drive?: (() => Promise<void>) | undefined;
}

/** Returns a promise that never settles, for a request or a call the state waits on. */
const hang = <T>(): Promise<T> => new Promise<T>(() => {});

/** The controller on this Mac, which the welcome greets as found. */
const LOCAL_URL = "http://127.0.0.1:4937";

/** The controller on another machine, as the book's REMOTE. */
const REMOTE_URL = "http://build-box-1:4937";

/** The book's start-error line: the service's own refusal, shown as it is. */
const START_ERROR_LINE =
  "/opt/tools/bin is on the PATH the service runs with, and every user on this machine can write to it, so anyone could put a program there that the service runs. Remove /opt/tools/bin from PATH, or run chmod o-w /opt/tools/bin, then run this again.";

const AT = "2026-09-05T09:00:00.000Z";

/** The runner on this Mac, with Claude Code and Codex installed and six desks. */
const STUDIO: Runner = {
  ...buildRunner("01a06d02-beff-7037-9f5b-000000000001", "studio-mac"),
  maxConcurrentSessions: 6,
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 64 * 1024 * 1024 * 1024,
    docker: true,
    toolchains: [],
    providers: [
      { name: "claude", present: true, path: "/opt/homebrew/bin/claude" },
      { name: "codex", present: true, path: "/opt/homebrew/bin/codex" },
      { name: "pi", present: false },
    ],
    adapters: ["claude-code", "codex", "pi"],
    identityPort: 4939,
  },
};

/** The same runner on a Mac with none of the coding tools installed. */
const BARE_STUDIO: Runner = {
  ...STUDIO,
  facts: {
    ...STUDIO.facts!,
    providers: [
      { name: "claude", present: false },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ],
  },
};

/** Returns a provider instance with one snapshot on studio-mac, logged in or not. */
const buildInstance = (
  id: string,
  providerId: string,
  displayName: string,
  binaryName: string,
  loggedIn: boolean,
): ProviderInstance => ({
  id,
  providerId,
  name: displayName,
  config: {},
  displayName,
  binaryName,
  declared: {
    steering: "native",
    fork: "native",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "native",
      "full-access": "native",
    },
    mcpPassthrough: "native",
    disallowedTools: "native",
    structuredOutput: "supported",
  },
  secretFields: [],
  snapshots: [buildSnapshot(loggedIn)],
  createdAt: AT,
  updatedAt: AT,
});

/** Returns a snapshot of an instance on studio-mac, logged in or not. */
const buildSnapshot = (loggedIn: boolean): ProviderInstance["snapshots"][number] => ({
  runnerId: STUDIO.id,
  probedAt: AT,
  harnessVersion: "1.0.0",
  versionVerdict: "ok",
  auth: loggedIn ? { status: "ok", identity: "rogier@example.com" } : { status: "unauthenticated" },
  models: [],
});

const CLAUDE_ID = "01a06d02-1000-7000-8000-000000000001";
const CODEX_ID = "01a06d02-1000-7000-8000-000000000002";
const PI_ID = "01a06d02-1000-7000-8000-000000000003";

/** Returns the three instances setup creates, with the ones in `loggedIn` logged in. */
const buildInstances = (loggedIn: readonly string[] = []): ProviderInstance[] => [
  buildInstance(CLAUDE_ID, "claude-code", "Claude Code", "claude", loggedIn.includes(CLAUDE_ID)),
  buildInstance(CODEX_ID, "codex", "Codex", "codex", loggedIn.includes(CODEX_ID)),
  buildInstance(PI_ID, "pi", "pi", "pi", loggedIn.includes(PI_ID)),
];

/** Hercule, the assistant setup creates. */
const HERCULE: Assistant = {
  id: "01a06d02-a000-7000-8000-000000000001",
  name: "Hercule",
  systemPrompt: "You are Hercule.",
  instanceId: CLAUDE_ID,
  permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
  accessMode: "auto-accept-edits",
  model: null,
  disallowedTools: [],
  unenforced: [],
  heartbeat: { enabled: false, schedule: "0 7-23 * * *", prompt: "Check in.", target: "web" },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
  createdAt: AT,
  updatedAt: AT,
};

/** The GitHub Connection for the account rogier. */
const GITHUB: Connection = {
  id: "01a06d02-7700-7000-8000-000000000001",
  type: GITHUB_CONNECTION_TYPE,
  label: "rogier",
  displayName: "rogier",
  status: "connected",
  labels: [],
  config: {},
  credentials: [],
  createdAt: AT,
  updatedAt: AT,
};

const WEBSHOP: Project = buildProject("01a06d02-7000-7000-8000-000000000001", "webshop");

const WEBSHOP_REPO: Resource = buildRepo(
  "01a06d02-7100-7000-8000-000000000001",
  "git@github.com:rogier/webshop.git",
  "github.com/rogier/webshop",
  [WEBSHOP.id],
);

/** What the stubbed controller holds once the user has an account. A scene's clicks may change it. */
interface ControllerRecords {
  localRunner: Runner | null;
  instances: ProviderInstance[];
  connections: Connection[];
  projects: Project[];
  resources: Resource[];
}

/** Returns the records of a controller just set up on studio-mac: no login, no GitHub, no project. */
const buildRecords = (records: Partial<ControllerRecords> = {}): ControllerRecords => ({
  localRunner: STUDIO,
  instances: buildInstances(),
  connections: [],
  projects: [],
  resources: [],
  ...records,
});

/**
 * Returns the controller's answers for a signed-in first run, read from
 * `records` at each request. The live connection's ticket never comes, so no
 * live connection opens.
 */
const buildSignedInHandlers = (records: ControllerRecords): Record<string, Handler> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/controller": () => ({
    body: {
      id: "01a06d02-7800-7000-8000-000000000001",
      publicKey: "controller-key",
      version: "0.4.2",
      defaultRunnerId: null,
      localRunnerId: records.localRunner?.id ?? null,
    },
  }),
  "GET /api/v1/runners": () => ({
    body: { items: records.localRunner === null ? [] : [records.localRunner] },
  }),
  "GET /api/v1/providers": () => ({ body: records.instances }),
  "GET /api/v1/connections": () => ({ body: { items: records.connections } }),
  "GET /api/v1/projects": () => ({ body: { items: records.projects } }),
  "GET /api/v1/resources": () => ({ body: { items: records.resources } }),
  "GET /api/v1/assistants": { body: { items: [HERCULE] } },
  "GET /api/v1/user": { body: { username: "rogier" } },
  "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "Europe/Amsterdam" } } },
  "POST /api/v1/auth/ws-ticket": () => hang<Answer>(),
});

/** Returns a validation error the controller sends, with its one issue at `path`. */
const buildValidationError = (message: string, path: readonly string[]): Answer => ({
  status: 400,
  body: { error: { code: "validation", message, details: { issues: [{ path, message }] } } },
});

/** What main answers, for the options a scene sets; every other call succeeds and does nothing. */
interface MainAnswers {
  readonly controllerUrl?: string | null;
  readonly token?: string | null;
  readonly find?: () => Promise<LocalControllerFindOutcome>;
  readonly start?: () => Promise<LocalControllerStartOutcome>;
  readonly setupToken?: SetupTokenReadOutcome | undefined;
  readonly pickFolder?: (() => Promise<FolderPickOutcome>) | undefined;
  readonly firstRun?: FirstRunProgress | null;
}

/** Returns a bridge that answers as main does with `answers`. */
const createScriptedBridge = ({
  controllerUrl = null,
  token = null,
  find = () => Promise.resolve({ _tag: "NotFound", line: null }),
  start = () => hang(),
  setupToken = { _tag: "Token", token: "setup-token" },
  pickFolder = () => Promise.resolve({ _tag: "Cancelled" }),
  firstRun = null,
}: MainAnswers): Bridge => {
  let kept = firstRun;
  const done = (): Promise<undefined> => Promise.resolve(undefined);
  return {
    controllerUrl: {
      read: () => Promise.resolve(controllerUrl),
      save: (url) => Promise.resolve({ _tag: "Saved", origin: url }),
    },
    token: { read: () => Promise.resolve(token), write: done },
    runnerIdentity: { read: () => Promise.resolve(null) },
    firstScreen: { report: done },
    goMenu: { set: done },
    waitingThreads: { set: done },
    localController: { find, start },
    logsFolder: { show: done },
    setupToken: { read: () => Promise.resolve(setupToken) },
    macUser: { read: () => Promise.resolve({ username: "rogier" }) },
    folder: { pick: pickFolder },
    firstRunProgress: {
      read: () => Promise.resolve(kept),
      save: (next) => {
        kept = next;
        return done();
      },
    },
    link: { open: done },
    menu: { onCommand: () => () => undefined },
    thread: { onOpen: () => () => undefined },
  };
};

/** Returns a scene with no controller saved, where main answers with `answers`. */
const buildWelcomeScene = (answers: MainAnswers, drive?: () => Promise<void>): FirstRunScene => ({
  bridge: createScriptedBridge(answers),
  fetch: createApiStub({}).fetch,
  drive,
});

/**
 * Returns a scene on a controller that is not set up, at `url`. Create
 * account sends `setup.complete`, which `completeSetup` answers.
 */
const buildNotSetUpScene = (
  {
    url = LOCAL_URL,
    setupToken,
    completeSetup = () => hang<Answer>(),
  }: {
    readonly url?: string;
    readonly setupToken?: SetupTokenReadOutcome;
    readonly completeSetup?: () => Promise<Answer>;
  },
  drive?: () => Promise<void>,
): FirstRunScene => ({
  bridge: createScriptedBridge({ controllerUrl: url, setupToken }),
  fetch: createApiStub({
    "GET /api/v1/setup": { body: { complete: false } },
    "POST /api/v1/setup/complete": completeSetup,
  }).fetch,
  drive,
});

/**
 * Returns a scene on the set-up controller on this Mac, signed in, holding
 * `records`, where main keeps `firstRun`. `handlers` answer what the scene's
 * clicks send.
 */
const buildSignedInScene = (
  {
    records = buildRecords(),
    firstRun = { putOff: [] },
    pickFolder,
    handlers = {},
  }: {
    readonly records?: ControllerRecords;
    readonly firstRun?: FirstRunProgress;
    readonly pickFolder?: () => Promise<FolderPickOutcome>;
    readonly handlers?: Readonly<Record<string, Handler>>;
  },
  drive?: () => Promise<void>,
): FirstRunScene => ({
  bridge: createScriptedBridge({ controllerUrl: LOCAL_URL, token: "bearer", firstRun, pickFolder }),
  fetch: createApiStub({ ...buildSignedInHandlers(records), ...handlers }).fetch,
  drive,
});

/** Returns the first-run progress where the user put off `steps`. */
const putOff = (...steps: FirstRunProgress["putOff"]): FirstRunProgress => ({ putOff: steps });

// The page is driven the way a user would: by the text on a button and the
// label of a field. Each wait polls once a frame and fails after five seconds,
// naming what it waited for.

/** Waits until `find` returns something, and returns it. Fails after five seconds. */
const waitFor = async <T>(find: () => T | null | undefined, what: string): Promise<T> => {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const found = find();
    if (found !== null && found !== undefined) return found;
    if (performance.now() > deadline) throw new Error(`The first run never showed ${what}.`);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
};

/** Returns the enabled button in `within` whose text is `text`, or undefined. */
const findButton = (text: string, within: ParentNode): HTMLButtonElement | undefined =>
  [...within.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === text && !button.disabled,
  );

/** Waits for the enabled button `text` in `within` and clicks it. */
const clickButton = async (text: string, within: ParentNode = document): Promise<void> => {
  (await waitFor(() => findButton(text, within), `the button ${text}`)).click();
};

/** Returns the provider row named `name` on the providers step, or undefined. */
const findProviderRow = (name: string): Element | undefined =>
  [...document.querySelectorAll(".hx-row")].find(
    (row) => row.querySelector(".hx-name b")?.textContent === name,
  );

/** Waits for the button `text` in the provider row `name` and clicks it. */
const clickInProviderRow = async (name: string, text: string): Promise<void> => {
  const row = await waitFor(() => findProviderRow(name), `the row ${name}`);
  await clickButton(text, row);
};

/** Returns the input of the field labelled `label`, by its form label or its `aria-label`. */
const findInput = (label: string): HTMLInputElement | undefined =>
  [...document.querySelectorAll<HTMLInputElement>("input")].find(
    (input) =>
      input.getAttribute("aria-label") === label ||
      input.closest("label")?.querySelector(".fl-label")?.textContent === label,
  );

/**
 * Types `value` into the field labelled `label`. The value is set through
 * the input's own setter and announced with an `input` event, because React
 * ignores a value set on the element directly.
 */
const fillField = async (label: string, value: string): Promise<void> => {
  const input = await waitFor(() => findInput(label), `the field ${label}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

/** Waits until the page's text includes `text`. */
const waitForText = async (text: string): Promise<void> => {
  await waitFor(() => (document.body.textContent.includes(text) ? true : null), `"${text}"`);
};

/** Logs Claude Code in by pasting a code, and waits until its row says Logged in. */
const logInClaudeByPaste = async (): Promise<void> => {
  await clickInProviderRow("Claude Code", "Log in");
  await fillField("Code", "4f9a-77c1");
  await clickButton("Submit");
  await waitFor(
    () => (findProviderRow("Claude Code")?.textContent.includes("Logged in") ? true : null),
    "Claude Code logged in",
  );
};

/**
 * Returns the controller's answers to a login of the instance `id` that
 * hands out a page to paste a code from, and logs the instance in in
 * `records` when the code arrives.
 */
const buildPasteLoginHandlers = (
  records: ControllerRecords,
  id: string,
): Record<string, Handler> => ({
  [`POST /api/v1/providers/${id}/login`]: { body: { url: "https://claude.ai/oauth/authorize" } },
  [`POST /api/v1/providers/${id}/login-code`]: () => {
    records.instances = records.instances.map((instance) =>
      instance.id === id ? { ...instance, snapshots: [buildSnapshot(true)] } : instance,
    );
    return { body: buildSnapshot(true) };
  },
});

/** Returns when a code handed out now runs out, so the steps say it lasts 15 minutes. */
const readCodeExpiry = (): string => new Date(Date.now() + 15 * 60_000 - 30_000).toISOString();

/** The GitHub device flow's start, with a poll after `interval` seconds. */
const buildGitHubDeviceStart = (interval: number): Answer => ({
  body: {
    setupId: "setup-1",
    userCode: "4C2F-9H7K",
    verificationUri: "https://github.com/login/device",
    expiresAt: readCodeExpiry(),
    interval,
  },
});

/** Returns a GitHub step scene whose sign-in with a code ends with `ending` at the first poll. */
const buildGitHubEndingScene = (ending: {
  readonly status: "expired" | "denied" | "failed";
  readonly message: string;
}): FirstRunScene =>
  buildSignedInScene(
    {
      records: buildRecords({ instances: buildInstances([CLAUDE_ID, CODEX_ID]) }),
      handlers: {
        "POST /api/v1/oauth/device/start": () => buildGitHubDeviceStart(1),
        "POST /api/v1/oauth/device/poll": { body: ending },
      },
    },
    async () => {
      await clickButton("Sign in with GitHub");
      // Start again shows once the sign-in has ended.
      await waitFor(() => findButton("Start again", document), "the button Start again");
    },
  );

/** Returns the records of the GitHub step: both providers logged in, nothing else yet. */
const buildGitHubRecords = (): ControllerRecords =>
  buildRecords({ instances: buildInstances([CLAUDE_ID, CODEX_ID]) });

/** Returns the records of the project step: logged in and GitHub connected. */
const buildProjectRecords = (): ControllerRecords =>
  buildRecords({ instances: buildInstances([CLAUDE_ID, CODEX_ID]), connections: [GITHUB] });

/** Returns a project step scene where the folder dialog answers `outcome`, after a click on Choose a folder. */
const buildPickedScene = (
  outcome: FolderPickOutcome,
  { gitHub = true }: { readonly gitHub?: boolean } = {},
): FirstRunScene =>
  buildSignedInScene(
    {
      records: gitHub
        ? buildProjectRecords()
        : buildRecords({ instances: buildInstances([CLAUDE_ID, CODEX_ID]) }),
      firstRun: gitHub ? putOff() : putOff("github"),
      pickFolder: () => Promise.resolve(outcome),
    },
    () => clickButton("Choose a folder…"),
  );

/** The scene of each state, built fresh for each page. */
export const FIRST_RUN_SCENES: { readonly [Name in FirstRunStateName]: () => FirstRunScene } = {
  "welcome-searching": () => buildWelcomeScene({ find: () => hang() }),
  "welcome-fresh": () => buildWelcomeScene({}),
  "welcome-starting": () => buildWelcomeScene({}, () => clickButton("Open the office")),
  "welcome-start-failed": () =>
    buildWelcomeScene(
      {
        start: () =>
          Promise.resolve({ _tag: "NoAnswer", origin: LOCAL_URL, logsFolder: "~/.hercule/logs" }),
      },
      () => clickButton("Open the office"),
    ),
  "welcome-start-error": () =>
    buildWelcomeScene(
      { start: () => Promise.resolve({ _tag: "StartFailed", line: START_ERROR_LINE }) },
      () => clickButton("Open the office"),
    ),
  "welcome-not-installed": () =>
    buildWelcomeScene({ start: () => Promise.resolve({ _tag: "NotInstalled" }) }, () =>
      clickButton("Open the office"),
    ),
  "welcome-runner": () =>
    buildWelcomeScene({ find: () => Promise.resolve({ _tag: "Runner", running: true }) }),
  "welcome-found": () => buildNotSetUpScene({}),
  "welcome-remote": () => buildWelcomeScene({}, () => clickButton("Connect to it")),
  "welcome-remote-not-set-up": () =>
    buildNotSetUpScene({ url: REMOTE_URL, setupToken: { _tag: "PasteNeeded" } }),

  "account-default": () => buildNotSetUpScene({}, () => clickButton("Open the office")),
  "account-error": () =>
    buildNotSetUpScene({}, async () => {
      await clickButton("Open the office");
      await fillField("Password", "hunter2");
      await clickButton("Create account");
    }),
  "account-submitting": () =>
    buildNotSetUpScene({}, async () => {
      await clickButton("Open the office");
      await fillField("Password", "correct horse");
      await clickButton("Create account");
    }),

  "providers-waiting": () => buildSignedInScene({ records: buildRecords({ localRunner: null }) }),
  "providers-idle": () => buildSignedInScene({}),
  "providers-claude-paste": () => {
    const records = buildRecords();
    return buildSignedInScene(
      { records, handlers: buildPasteLoginHandlers(records, CLAUDE_ID) },
      () => clickInProviderRow("Claude Code", "Log in"),
    );
  },
  "providers-claude-error": () =>
    buildSignedInScene(
      {
        handlers: {
          [`POST /api/v1/providers/${CLAUDE_ID}/login`]: {
            body: { url: "https://claude.ai/oauth/authorize" },
          },
          [`POST /api/v1/providers/${CLAUDE_ID}/login-code`]: buildValidationError(
            "The vendor did not accept the code.",
            ["code"],
          ),
        },
      },
      async () => {
        await clickInProviderRow("Claude Code", "Log in");
        await fillField("Code", "4f9a");
        await clickButton("Submit");
        await waitForText("That code wasn’t accepted.");
      },
    ),
  "providers-codex-device": () => {
    const records = buildRecords();
    return buildSignedInScene(
      {
        records,
        handlers: {
          ...buildPasteLoginHandlers(records, CLAUDE_ID),
          [`POST /api/v1/providers/${CODEX_ID}/login`]: () => ({
            body: {
              url: "https://auth.openai.com/codex/device",
              userCode: "K7QF-2MXD",
              expiresAt: readCodeExpiry(),
            },
          }),
        },
      },
      async () => {
        await logInClaudeByPaste();
        await clickInProviderRow("Codex", "Log in");
        await waitForText("K7QF-2MXD");
      },
    );
  },
  "providers-ready": () => {
    const records = buildRecords();
    return buildSignedInScene(
      {
        records,
        handlers: {
          ...buildPasteLoginHandlers(records, CLAUDE_ID),
          ...buildPasteLoginHandlers(records, CODEX_ID),
        },
      },
      async () => {
        await logInClaudeByPaste();
        await clickInProviderRow("Codex", "Log in");
        await fillField("Code", "9c2e-41d0");
        await clickButton("Submit");
        await waitFor(
          () => (findProviderRow("Codex")?.textContent.includes("Logged in") ? true : null),
          "Codex logged in",
        );
      },
    );
  },
  "providers-none-found": () =>
    buildSignedInScene({ records: buildRecords({ localRunner: BARE_STUDIO }) }),

  "github-empty": () => buildSignedInScene({ records: buildGitHubRecords() }),
  "github-code": () =>
    buildSignedInScene(
      {
        records: buildGitHubRecords(),
        handlers: {
          // The first poll is an hour away, so the code stays on screen.
          "POST /api/v1/oauth/device/start": () => buildGitHubDeviceStart(3600),
        },
      },
      async () => {
        await clickButton("Sign in with GitHub");
        await waitForText("4C2F-9H7K");
      },
    ),
  "github-connected": () => {
    const records = buildGitHubRecords();
    return buildSignedInScene(
      {
        records,
        handlers: {
          "POST /api/v1/connections": () => {
            records.connections = [GITHUB];
            return { status: 201, body: GITHUB };
          },
        },
      },
      async () => {
        await clickButton("Paste a token instead");
        await fillField("Personal access token", "github_pat_11ABX3Q");
        await clickButton("Connect");
        await waitForText("GitHub is connected");
      },
    );
  },
  "github-expired": () =>
    buildGitHubEndingScene({ status: "expired", message: "The device code expired." }),
  "github-denied": () =>
    buildGitHubEndingScene({ status: "denied", message: "The user declined the request." }),
  "github-failed": () =>
    buildGitHubEndingScene({
      status: "failed",
      message:
        "Device flow is turned off on the provider’s OAuth App for this type, so signing in with a code cannot work: paste a token instead.",
    }),
  "github-token": () =>
    buildSignedInScene({ records: buildGitHubRecords() }, () =>
      clickButton("Paste a token instead"),
    ),
  "github-token-checking": () =>
    buildSignedInScene(
      {
        records: buildGitHubRecords(),
        handlers: { "POST /api/v1/connections": () => hang<Answer>() },
      },
      async () => {
        await clickButton("Paste a token instead");
        await fillField("Personal access token", "github_pat_11ABX3Q…");
        await clickButton("Connect");
        await waitForText("Checking the token…");
      },
    ),
  "github-token-refused": () =>
    buildSignedInScene(
      {
        records: buildGitHubRecords(),
        handlers: {
          // The GitHub plugin's own words for a token GitHub answers with 401.
          "POST /api/v1/connections": buildValidationError("GitHub rejected the token.", []),
        },
      },
      async () => {
        await clickButton("Paste a token instead");
        await fillField("Personal access token", "ghp_2c41d9e0a7f3…");
        await clickButton("Connect");
        await waitForText("GitHub rejected the token.");
      },
    ),

  "project-empty": () => buildSignedInScene({ records: buildProjectRecords() }),
  "project-picked": () =>
    buildPickedScene({
      _tag: "Repository",
      name: "webshop",
      remote: "git@github.com:rogier/webshop.git",
      branch: "main",
    }),
  "project-no-remote": () =>
    buildPickedScene({ _tag: "NoRemote", name: "webshop", branch: "main" }),
  "project-not-git": () => buildPickedScene({ _tag: "NotGit", name: "webshop" }),
  "project-picked-without-github": () =>
    buildPickedScene(
      {
        _tag: "Repository",
        name: "webshop",
        remote: "git@github.com:rogier/webshop.git",
        branch: "main",
      },
      { gitHub: false },
    ),

  "done-default": () =>
    buildSignedInScene({
      records: buildRecords({
        instances: buildInstances([CLAUDE_ID, CODEX_ID]),
        connections: [GITHUB],
        projects: [WEBSHOP],
        resources: [WEBSHOP_REPO],
      }),
    }),
  "done-put-off": () =>
    buildSignedInScene({
      records: buildRecords({ projects: [WEBSHOP] }),
      firstRun: putOff("providers", "github"),
    }),
};
