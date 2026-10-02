/**
 * Tests the first run as the app shows it, through the real router, the
 * entry guard and the stubbed controller:
 *
 * - the welcome with no controller saved, in each state the look for and the
 *   start of Hercule on this Mac can leave it in;
 * - a saved controller that is not set up: the welcome, the remote screen and
 *   the account step;
 * - each step once the user has an account, and All set.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ONBOARDING_STEPS } from "@hercule/client-core";
import {
  GITHUB_CONNECTION_TYPE,
  MIN_PASSWORD_LENGTH,
  type Connection,
  type Project,
} from "@hercule/contract";
import type {
  FirstRunProgress,
  LocalControllerStartOutcome,
  SetupTokenReadOutcome,
} from "../../../ipc/contract";
import {
  buildErrorBody,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../app/testing";
import { markStartRequested, takeStartRequested } from "./-start-flag";

/** A controller on this Mac, which the welcome greets as found. */
const LOCAL_URL = "http://127.0.0.1:4937";

const SETUP_TOKEN: SetupTokenReadOutcome = { _tag: "Token", token: "setup-token" };

const PASSWORD = "p".repeat(MIN_PASSWORD_LENGTH);

const [MOSS] = SIDEBAR_FIXTURE.runners;
const [WEBSHOP] = SIDEBAR_FIXTURE.projects;

const GITHUB: Connection = {
  id: "01a06d02-7700-7000-8000-000000000001",
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

/** The project the controller creates on the project step. */
const SHOP: Project = { ...WEBSHOP!, id: "01a06d02-7000-7000-8000-0000000000aa", name: "shop" };

/** The remote of the folder the user picks on the project step. */
const REMOTE = "git@github.com:rogier/shop.git";

/** Returns the controller's record, with `localRunnerId` as the runner it started. */
const buildControllerInfo = (localRunnerId: string | null) => ({
  id: "01a06d02-7800-7000-8000-000000000001",
  publicKey: "controller-key",
  version: "0.4.2",
  defaultRunnerId: null,
  localRunnerId,
});

/** The reads the first run makes once signed in that `stubApi` does not answer. */
const FIRST_RUN_HANDLERS: Readonly<Record<string, Handler>> = {
  "GET /api/v1/controller": { body: buildControllerInfo(null) },
  "GET /api/v1/assistants": { body: { items: [] } },
};

/** Returns the requests sent to `path` with `method`. */
const readCalls = (calls: readonly Call[], method: string, path: string): readonly Call[] =>
  calls.filter((call) => call.method === method && call.path === path);

/** Returns the room the first run draws behind its card. */
const readRoom = (): Element | null => document.querySelector(".fr-stage > *");

/** Returns the step heading on the card. */
const readHeading = (): string | null => screen.getByRole("heading", { level: 1 }).textContent;

/**
 * Opens the first run on `CONTROLLER_URL` for a signed-in user, with
 * `firstRun` as what main keeps of it and `handlers` on top of the reads
 * every first run makes.
 */
const openSignedIn = async ({
  firstRun = { putOff: [] },
  handlers = {},
}: {
  readonly firstRun?: FirstRunProgress;
  readonly handlers?: Readonly<Record<string, Handler>>;
} = {}) => {
  const calls = stubApi({ ...FIRST_RUN_HANDLERS, ...handlers });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer", firstRun });
  const app = await renderApp(fake);
  return { calls, fake, ...app };
};

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("the welcome, with no controller saved", () => {
  it("shows that it looks for Hercule on this Mac, and holds Open the office until it knows", async () => {
    await renderApp(createFakeBridge({ find: () => new Promise(() => {}) }));
    expect(screen.getByRole("status").textContent).toBe("Looking for Hercule on this Mac…");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Open the office" }).disabled,
    ).toBe(true);
  });

  it("offers to run Hercule on this Mac when it finds nothing", async () => {
    await renderApp(createFakeBridge());
    await screen.findByText("Hercule will run on this Mac");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Open the office" }).disabled,
    ).toBe(false);
    // The welcome has no steps yet, so the ladder is not drawn.
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();
  });

  it("explains that this Mac is a runner, and connects only to another machine", async () => {
    const user = userEvent.setup();
    await renderApp(
      createFakeBridge({ find: () => Promise.resolve({ _tag: "Runner", running: true }) }),
    );
    expect(await screen.findByRole("heading", { name: "This Mac is a runner" })).toBeTruthy();
    expect(screen.getByText("Hercule’s runner is running on this Mac")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Connect to it" }));
    expect(readHeading()).toBe("Connect to Hercule on another machine");
    expect(screen.queryByRole("button", { name: "Use this Mac" })).toBeNull();
  });

  it("starts Hercule on Open the office, and keeps showing the start until the window reloads", async () => {
    const user = userEvent.setup();
    const fake = createFakeBridge({
      start: () => Promise.resolve({ _tag: "Saved", origin: LOCAL_URL }),
    });
    await renderApp(fake);
    await user.click(await screen.findByRole("button", { name: "Open the office" }));
    expect(fake.startCount()).toBe(1);
    const button = screen.getByRole("button", { name: "Starting Hercule…" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    // The page after the reload learns of the start from the mark.
    expect(takeStartRequested()).toBe(true);
  });

  it.each<[string, () => Promise<LocalControllerStartOutcome>, string]>([
    [
      "NoAnswer",
      () => Promise.resolve({ _tag: "NoAnswer", address: LOCAL_URL, logsDir: "~/.hercule/logs" }),
      "The app started Hercule in the background, but it never answered.",
    ],
    [
      "StartError",
      () => Promise.resolve({ _tag: "StartError", line: "launchctl: service not found" }),
      "launchctl: service not found",
    ],
    [
      "NotController",
      () => Promise.resolve({ _tag: "NotController", origin: LOCAL_URL }),
      `${LOCAL_URL} answered, but it is not a Hercule controller.`,
    ],
    [
      "NotInstalled",
      () => Promise.resolve({ _tag: "NotInstalled" }),
      "Hercule is not installed on this Mac.",
    ],
    ["a rejection", () => Promise.reject(new Error("main failed")), "main failed"],
  ])(
    "explains a start that ended in %s, offers Try again, and drops the mark",
    async (_tag, start, line) => {
      const user = userEvent.setup();
      const fake = createFakeBridge({ start });
      await renderApp(fake);
      await user.click(await screen.findByRole("button", { name: "Open the office" }));
      expect(await screen.findByRole("heading", { name: "Hercule didn’t start" })).toBeTruthy();
      expect(document.querySelector(".fr-body")?.textContent).toContain(line);
      expect(takeStartRequested()).toBe(false);
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(fake.startCount()).toBe(2);
    },
  );

  it("shows the logs folder in Finder when nothing answered after the start", async () => {
    const user = userEvent.setup();
    const fake = createFakeBridge({
      start: () =>
        Promise.resolve({ _tag: "NoAnswer", address: LOCAL_URL, logsDir: "~/.hercule/logs" }),
    });
    await renderApp(fake);
    await user.click(await screen.findByRole("button", { name: "Open the office" }));
    expect(await screen.findByText("~/.hercule/logs")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(fake.logsFolderShowCount()).toBe(1);
  });

  it("saves the address of Hercule on another machine, explains a refusal, and goes back on Use this Mac", async () => {
    const user = userEvent.setup();
    const fake = createFakeBridge({
      save: () => Promise.resolve({ _tag: "Unreachable", origin: "http://build-box-1:4937" }),
    });
    await renderApp(fake);
    await user.click(await screen.findByRole("button", { name: "Connect to it" }));
    await user.type(screen.getByRole("textbox", { name: "Address" }), "http://build-box-1:4937");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(fake.savedUrls).toEqual(["http://build-box-1:4937"]);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not reach http://build-box-1:4937. Check that the controller is running.",
    );
    await user.click(screen.getByRole("button", { name: "Use this Mac" }));
    expect(screen.getByRole("button", { name: "Open the office" })).toBeTruthy();
  });
});

describe("the first run on a controller that is not set up", () => {
  /**
   * Opens the first run on the controller at `url`, which is not set up, with
   * `setupToken` as main's answer for its setup token. Setup completes the
   * way the controller's would: `GET /setup` answers complete from then on.
   */
  const openNotSetUp = async ({
    url = CONTROLLER_URL,
    setupToken = SETUP_TOKEN,
    handlers = {},
  }: {
    readonly url?: string;
    readonly setupToken?: SetupTokenReadOutcome;
    readonly handlers?: Readonly<Record<string, Handler>>;
  } = {}) => {
    let setUp = false;
    const calls = stubApi({
      ...FIRST_RUN_HANDLERS,
      "GET /api/v1/setup": () => ({ body: { complete: setUp } }),
      "POST /api/v1/setup/complete": () => {
        setUp = true;
        return { body: { token: "login-token" } };
      },
      "PATCH /api/v1/settings": { body: { controller: {}, user: {} } },
      ...handlers,
    });
    const fake = createFakeBridge({ controllerUrl: url, setupToken });
    const app = await renderApp(fake);
    return { calls, fake, ...app };
  };

  it("greets Hercule found on this Mac, and Open the office goes to the account step without a start", async () => {
    const user = userEvent.setup();
    const { fake } = await openNotSetUp({ url: LOCAL_URL });
    expect(screen.getByText("Hercule is running on this Mac")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open the office" }));
    expect(readHeading()).toBe("Create your account");
    expect(fake.startCount()).toBe(0);
  });

  it("goes straight to the account step after a start of Hercule on this Mac", async () => {
    markStartRequested();
    await openNotSetUp({ url: LOCAL_URL });
    expect(readHeading()).toBe("Create your account");
    // The mark is read once, so a later launch greets Hercule again.
    expect(takeStartRequested()).toBe(false);
  });

  it("asks for the setup address when main has no setup token for the controller", async () => {
    await openNotSetUp({ setupToken: { _tag: "PasteNeeded" } });
    expect(readHeading()).toBe("Connect to Hercule on another machine");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Address" }).value).toBe(
      CONTROLLER_URL,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Hercule on controller.test isn’t set up yet. On that machine, run hercule setup-url and paste the address it prints.",
    );
  });

  it("refuses a password that is too short without asking the controller", async () => {
    const user = userEvent.setup();
    const { calls } = await openNotSetUp();
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("alert").textContent).toBe(
      `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
    );
    expect(readCalls(calls, "POST", "/api/v1/setup/complete")).toHaveLength(0);
  });

  it("sets Hercule up, marks onboarding done, keeps the first run, and moves to providers in the same room", async () => {
    const user = userEvent.setup();
    let firstRunWritesAtSettings = -1;
    const { calls, fake } = await openNotSetUp({
      handlers: {
        "PATCH /api/v1/settings": () => {
          firstRunWritesAtSettings = fake.firstRunWrites.length;
          return { body: { controller: {}, user: {} } };
        },
      },
    });
    const frame = document.querySelector(".fr");
    const room = readRoom();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Username" }).value).toBe("ada");

    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await screen.findByRole("heading", { name: "Waiting for the runner" });
    const [setup] = readCalls(calls, "POST", "/api/v1/setup/complete");
    expect(setup?.body).toMatchObject({ username: "ada", password: PASSWORD });
    expect(fake.tokenWrites).toEqual(["login-token"]);
    expect(readCalls(calls, "PATCH", "/api/v1/settings").map((call) => call.body)).toEqual([
      { user: { "onboarding.completedSteps": [...ONBOARDING_STEPS] } },
    ]);
    // The settings are written before the first run is kept.
    expect(firstRunWritesAtSettings).toBe(0);
    expect(fake.firstRunWrites).toEqual([{ putOff: [] }]);
    // Nothing remounted: no fallback replaced the frame, and the room only moved its camera.
    expect(document.querySelector(".fr")).toBe(frame);
    expect(readRoom()).toBe(room);
  });

  it("explains a refused setup token, and reads a new one for the next try", async () => {
    const user = userEvent.setup();
    let refuse = true;
    const { fake } = await openNotSetUp({
      handlers: {
        "POST /api/v1/setup/complete": () =>
          refuse
            ? { status: 401, body: buildErrorBody("unauthenticated", "bad setup token") }
            : { body: { token: "login-token" } },
      },
    });
    const read = vi.spyOn(fake.bridge.setupToken, "read");
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(
      await screen.findByText(
        "Hercule refused the setup token, which may be out of date. Create account tries again with a new one.",
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(1);
    });
    refuse = false;
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Waiting for the runner" })).toBeTruthy();
  });
});

describe("the first run's steps", () => {
  it("waits for the runner, then shows its coding tools once a push says it joined", async () => {
    let localRunnerId: string | null = null;
    const { live } = await openSignedIn({
      handlers: {
        "GET /api/v1/controller": () => ({ body: buildControllerInfo(localRunnerId) }),
        "GET /api/v1/runners": { body: { items: [MOSS] } },
      },
    });
    expect(readHeading()).toBe("Waiting for the runner");
    await waitFor(() => {
      expect(live.readTopics()).toContain("runner");
    });
    localRunnerId = MOSS!.id;
    act(() => {
      live.pushInvalidation("runner", [MOSS!.id]);
    });
    await waitFor(() => {
      expect(readHeading()).not.toBe("Waiting for the runner");
    });
  });

  it("puts the providers off on Do this later, and marks them so in the ladder", async () => {
    const user = userEvent.setup();
    const { fake } = await openSignedIn();
    await user.click(screen.getByRole("button", { name: "Do this later" }));
    expect(await screen.findByRole("heading", { name: "Connect GitHub" })).toBeTruthy();
    expect(fake.firstRunWrites).toEqual([{ putOff: ["providers"] }]);

    const rungs = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    const [account, providers, github] = rungs;
    expect(github?.getAttribute("aria-current")).toBe("step");
    // A step put off draws a pause mark where a finished one draws a tick.
    expect(providers?.className).toBe("is-done");
    expect(providers?.querySelector("svg")?.innerHTML).not.toBe(
      account?.querySelector("svg")?.innerHTML,
    );
  });

  describe("GitHub", () => {
    const START = {
      setupId: "setup-1",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresAt: "2099-01-01T00:00:00.000Z",
      interval: 5,
    };
    const POLL_PATH = "/api/v1/oauth/device/poll";

    /** Advances the fake clock, and lets React and the promises it resolves catch up. */
    const advanceClock = (milliseconds: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(milliseconds);
      });

    /** Advances the fake clock a millisecond at a time until `predicate` returns true. */
    const pumpUntil = async (predicate: () => boolean): Promise<void> => {
      for (let step = 0; step < 50; step++) {
        if (predicate()) return;
        await advanceClock(1);
      }
      throw new Error("the condition never became true");
    };

    /**
     * Opens the GitHub step, with the providers put off, and answers each poll
     * with the next of `polls`, then the last again. A `done` poll adds the
     * Connection to the list, as the controller does.
     */
    const openGitHub = async (polls: readonly unknown[] = [{ status: "pending", interval: 5 }]) => {
      let connections: readonly Connection[] = [];
      let index = 0;
      const app = await openSignedIn({
        firstRun: { putOff: ["providers"] },
        handlers: {
          "GET /api/v1/connections": () => ({ body: { items: connections } }),
          "POST /api/v1/oauth/device/start": { body: START },
          [`POST ${POLL_PATH}`]: () => {
            const poll = polls[Math.min(index++, polls.length - 1)];
            if ((poll as { status: string }).status === "done") connections = [GITHUB];
            return { body: poll };
          },
          "POST /api/v1/connections": () => {
            connections = [GITHUB];
            return { status: 201, body: GITHUB };
          },
          "GET /api/v1/projects": { body: { items: [] } },
        },
      });
      expect(readHeading()).toBe("Connect GitHub");
      return app;
    };

    /** Presses Sign in with GitHub under a fake clock, and waits for the code. */
    const signIn = async (): Promise<void> => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
      await pumpUntil(() => screen.queryByText(START.userCode) !== null);
    };

    it("shows the code, opens GitHub, and shows the Connection once the user approves", async () => {
      const { fake } = await openGitHub([
        { status: "pending", interval: 5 },
        { status: "done", connection: GITHUB },
      ]);
      await signIn();
      fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));
      expect(fake.openedLinks).toEqual([START.verificationUri]);
      await advanceClock(10_000);
      await pumpUntil(() => screen.queryByText("GitHub is connected") !== null);
      expect(screen.getByText("Connected as rogier")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await pumpUntil(() => screen.queryByText("Add your first project") !== null);
    });

    it("stops polling once the user skips the step, and puts GitHub off", async () => {
      const { calls, fake } = await openGitHub();
      await signIn();
      await advanceClock(5_000);
      fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
      await pumpUntil(() => screen.queryByText("Add your first project") !== null);
      const polls = readCalls(calls, "POST", POLL_PATH).length;
      await advanceClock(60_000);
      expect(readCalls(calls, "POST", POLL_PATH)).toHaveLength(polls);
      expect(fake.firstRunWrites).toEqual([{ putOff: ["providers", "github"] }]);
    });

    it("explains a sign-in the user declined, and starts again", async () => {
      const { calls } = await openGitHub([{ status: "denied", message: "The user declined." }]);
      await signIn();
      await advanceClock(5_000);
      await pumpUntil(() => screen.queryByRole("button", { name: "Start again" }) !== null);
      fireEvent.click(screen.getByRole("button", { name: "Start again" }));
      await pumpUntil(() => readCalls(calls, "POST", "/api/v1/oauth/device/start").length === 2);
    });

    it("connects with a pasted token, and shows the check while the controller makes it", async () => {
      const user = userEvent.setup();
      const { calls } = await openGitHub();
      await user.click(screen.getByRole("button", { name: "Paste a token instead" }));
      await user.type(
        screen.getByRole("textbox", { name: "Personal access token" }),
        " ghp_secret ",
      );
      await user.click(screen.getByRole("button", { name: "Connect" }));
      expect(await screen.findByText("GitHub is connected")).toBeTruthy();
      expect(readCalls(calls, "POST", "/api/v1/connections").map((call) => call.body)).toEqual([
        { type: GITHUB_CONNECTION_TYPE, credentials: { pat: "ghp_secret" } },
      ]);
    });

    it("shows the controller's refusal of a pasted token under the field", async () => {
      const user = userEvent.setup();
      await openGitHub();
      stubApi({
        ...FIRST_RUN_HANDLERS,
        "POST /api/v1/connections": {
          status: 400,
          body: buildErrorBody("validation", "GitHub refused the token."),
        },
      });
      await user.click(screen.getByRole("button", { name: "Paste a token instead" }));
      await user.type(screen.getByRole("textbox", { name: "Personal access token" }), "ghp_bad");
      await user.click(screen.getByRole("button", { name: "Connect" }));
      expect((await screen.findByRole("alert")).textContent).toContain("GitHub refused the token.");
    });
  });

  it("creates the project without a repository while GitHub is put off, and offers to connect it now", async () => {
    const user = userEvent.setup();
    let projects: readonly Project[] = [];
    const calls = stubApi({
      ...FIRST_RUN_HANDLERS,
      "GET /api/v1/projects": () => ({ body: { items: projects } }),
      "POST /api/v1/projects": () => {
        projects = [SHOP];
        return { body: SHOP };
      },
    });
    const fake = createFakeBridge({
      controllerUrl: CONTROLLER_URL,
      token: "bearer",
      firstRun: { putOff: ["providers", "github"] },
      pickFolder: () =>
        Promise.resolve({ _tag: "Repository", name: "shop", remote: REMOTE, branch: "main" }),
    });
    await renderApp(fake);
    expect(readHeading()).toBe("Add your first project");

    await user.click(screen.getByRole("button", { name: "Choose a folder…" }));
    await user.click(await screen.findByRole("button", { name: "Connect GitHub now" }));
    expect(readHeading()).toBe("Connect GitHub");
    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(await screen.findByText("Add your first project")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Choose a folder…" }));
    await user.click(
      await screen.findByRole("button", { name: "Add project without a repository" }),
    );
    expect(await screen.findByText("Your office is open")).toBeTruthy();
    expect(readCalls(calls, "POST", "/api/v1/projects")).toHaveLength(1);
    expect(readCalls(calls, "POST", "/api/v1/resources")).toHaveLength(0);
  });

  describe("All set", () => {
    it("ends the first run and opens the New thread draft in the project on Start your first thread", async () => {
      const user = userEvent.setup();
      const { fake, router } = await openSignedIn({
        firstRun: { putOff: [] },
        handlers: {
          "GET /api/v1/controller": { body: buildControllerInfo(MOSS!.id) },
          "GET /api/v1/runners": { body: { items: [MOSS] } },
          "GET /api/v1/providers": { body: [FIXTURE_INSTANCE] },
          "GET /api/v1/connections": { body: { items: [GITHUB] } },
          "GET /api/v1/projects": { body: { items: [WEBSHOP] } },
        },
      });
      expect(screen.getByText("Your office is open")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Start your first thread" }));
      await waitFor(() => {
        expect(router.state.location.href).toBe(`/?project=${WEBSHOP!.id}`);
      });
      expect(fake.firstRunWrites).toEqual([null]);
    });

    it("offers a provider login, and Do it now, for a step put off", async () => {
      const user = userEvent.setup();
      const { fake, router } = await openSignedIn({
        firstRun: { putOff: ["providers", "github"] },
        handlers: { "GET /api/v1/projects": { body: { items: [WEBSHOP] } } },
      });
      expect(screen.getByText("No provider yet")).toBeTruthy();
      const [doProviders] = screen.getAllByRole("button", { name: "Do it now" });
      await user.click(doProviders!);
      expect(readHeading()).toBe("Waiting for the runner");
      // The step stays put off until the user acts on it again.
      expect(fake.firstRunWrites).toEqual([]);
      await user.click(screen.getByRole("button", { name: "Do this later" }));
      await user.click(await screen.findByRole("button", { name: "Log in to a provider" }));
      await waitFor(() => {
        expect(router.state.location.href).toBe(`/?project=${WEBSHOP!.id}`);
      });
      expect(fake.firstRunWrites.at(-1)).toBeNull();
    });
  });
});
