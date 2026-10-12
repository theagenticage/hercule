/**
 * Tests the setup of a Connection in Settings > Connections, opened from Add
 * a Connection and from a row's Reconnect…: pasted credentials, the device
 * flow, OAuth, and a setup this version cannot run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection, PluginDetail } from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Call,
  type Handler,
} from "../../../../app/testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

// The sidebar's thread list draws only the rows that fit its height.
beforeEach(() => {
  stubElementSize(272, 800);
});

// The section opened last is kept in memory for as long as the app runs,
// which in a test file is every test.
afterEach(() => {
  forgetLastSettingsSection();
  vi.useRealTimers();
});

/** Returns a plugin that declares one Connection type, `<id>/<word>`, with `setup`. */
const buildPlugin = (
  id: string,
  word: string,
  displayName: string,
  setup: ReadonlyArray<PluginDetail["contributions"][number]["definition"]>,
): PluginDetail => ({
  id,
  displayName: `Plugin ${id}`,
  hostApi: 1,
  capabilities: ["connections"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [
    {
      extensionPoint: "connection-type",
      id: `${id}/${word}`,
      definition: { type: `${id}/${word}`, displayName, setup },
    },
  ],
  intake: { eventKinds: [], signalKinds: [] },
});

const PLUGINS: readonly PluginDetail[] = [
  buildPlugin("github", "github", "GitHub", [
    { kind: "device" },
    {
      kind: "credentials",
      fields: [{ name: "pat", label: "Personal access token" }],
    },
  ]),
  buildPlugin("paper-trail", "paper", "Paper Trail", [
    { kind: "checklist", markdown: "Create a key under Settings › API.\nIt shows only once." },
    {
      kind: "credentials",
      fields: [
        { name: "token", label: "Access token" },
        { name: "secret", label: "Signing secret", help: "Under the key, on the same page." },
      ],
    },
  ]),
  // No plugin in the binary uses OAuth, so this one stands in.
  buildPlugin("mailbox", "mail", "Mailbox", [{ kind: "oauth" }]),
  buildPlugin("chatter", "chat", "Chatter", [{ kind: "pairing" }]),
  // A step kind from a newer host, which this version does not know.
  buildPlugin("pigeon", "coop", "Pigeon Post", [{ kind: "carrier-pigeon" }]),
];

/** Returns a Connection of `type`, labelled `label`. */
const buildConnection = (id: string, type: string, label: string): Connection => ({
  id,
  type,
  label,
  displayName: label,
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

const OFFICE_PAPERS: Connection = {
  ...buildConnection("01a06d02-7700-7000-8000-000000000002", "paper-trail/paper", "Office papers"),
  status: "needs-reauth",
};

const START_PATH = "/api/v1/oauth/device/start";
const POLL_PATH = "/api/v1/oauth/device/poll";

/** A device code that lasts 15 minutes from the moment it is built. */
const buildDeviceStart = () => ({
  setupId: "setup-1",
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  interval: 5,
});

/**
 * Opens Settings > Connections on a controller that holds `connections`,
 * with the test's `handlers` over the defaults, and returns the app, the
 * calls and the fake bridge. `connections` may be a function, so a test can
 * change what the controller holds.
 */
const openConnections = async (
  handlers: Readonly<Record<string, Handler>> = {},
  connections: () => readonly Connection[] = () => [OFFICE_PAPERS],
) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, plugins: PLUGINS }),
    "GET /api/v1/connections": () => ({ body: { items: connections() } }),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path: "/settings/connections" });
  return { calls, fake, ...app };
};

/**
 * Presses `button`, then the item named `name` in the menu it opens. jsdom
 * has no popover API, so the menu counts as hidden there, and a hidden menu
 * has no accessible name to find it by.
 */
const chooseMenuItem = async (button: HTMLElement, name: string | RegExp): Promise<void> => {
  await userEvent.click(button);
  const menu = document.getElementById(button.getAttribute("popovertarget")!)!;
  await userEvent.click(within(menu).getByRole("menuitem", { name, hidden: true }), {
    pointerEventsCheck: 0,
  });
};

/** Picks `typeName` from Add a Connection and returns the dialog it opens. */
const openSetup = async (typeName: string): Promise<HTMLDialogElement> => {
  await chooseMenuItem(
    await screen.findByRole("button", { name: "Add a Connection" }),
    new RegExp(`^${typeName}`),
  );
  return screen.findByRole<HTMLDialogElement>("dialog", { name: `Connect ${typeName}` });
};

/** Returns the requests sent to `method` `path`. */
const readCalls = (calls: readonly Call[], method: string, path: string): readonly Call[] =>
  calls.filter((call) => call.method === method && call.path === path);

/** Waits until no dialog is open. */
const waitForClosed = () =>
  waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });

describe("the setup of a Connection with pasted credentials", () => {
  it("shows the type's instructions, sends the credentials and closes", async () => {
    let connections: readonly Connection[] = [];
    const created = buildConnection(
      "01a06d02-7700-7000-8000-000000000003",
      "paper-trail/paper",
      "acme",
    );
    const { calls } = await openConnections(
      {
        "POST /api/v1/connections": () => {
          connections = [created];
          return { status: 201, body: created };
        },
      },
      () => connections,
    );
    const view = within(await openSetup("Paper Trail"));

    expect(view.getByText(/^Create a key under Settings › API\./).textContent).toBe(
      "Create a key under Settings › API.\nIt shows only once.",
    );
    const token = view.getByLabelText<HTMLInputElement>("Access token");
    expect(token.type).toBe("password");
    expect(token.value).toBe("");
    expect(token.autocomplete).toBe("off");
    expect(view.getByText("Under the key, on the same page.")).toBeTruthy();

    await userEvent.type(token, "k-123");
    await userEvent.type(view.getByLabelText("Signing secret"), "s-456{Enter}");

    await waitForClosed();
    expect(readCalls(calls, "POST", "/api/v1/connections").map((call) => call.body)).toEqual([
      { type: "paper-trail/paper", credentials: { token: "k-123", secret: "s-456" } },
    ]);
    // The list is read again, so the new Connection shows at once.
    await waitFor(() => {
      expect(readCalls(calls, "GET", "/api/v1/connections").length).toBeGreaterThan(1);
    });
  });

  it("shows a refused field under that field, and any other failure under the form", async () => {
    let answer: { status: number; body: unknown } = {
      status: 400,
      body: {
        error: {
          code: "validation",
          message: "The credentials were refused.",
          details: {
            issues: [{ path: ["credentials", "token"], message: "that key was revoked" }],
          },
        },
      },
    };
    await openConnections({ "POST /api/v1/connections": () => answer });
    const dialog = await openSetup("Paper Trail");
    const view = within(dialog);

    await userEvent.type(view.getByLabelText("Access token"), "old");
    await userEvent.click(view.getByRole("button", { name: "Connect" }));

    expect((await view.findByRole("alert")).textContent).toBe("that key was revoked");
    expect(view.getByLabelText("Access token").parentElement?.className).toBe("field is-bad");
    expect(dialog.open).toBe(true);

    // Typing clears the error, which was about the old value.
    await userEvent.type(view.getByLabelText("Access token"), "-new");
    expect(view.queryByRole("alert")).toBeNull();

    // A refusal that names no field, as when the provider turns the pair down.
    answer = { status: 400, body: buildErrorBody("validation", "Paper Trail refused the pair.") };
    await userEvent.click(view.getByRole("button", { name: "Connect" }));
    expect((await view.findByRole("alert")).textContent).toBe("Paper Trail refused the pair.");
    expect(view.getByLabelText("Access token").parentElement?.className).toBe("field");
  });

  it("keeps the form as sent while the save is pending, and closes once it lands", async () => {
    let answerCreate: (answer: { status: number; body: unknown }) => void = () => undefined;
    const created = buildConnection(
      "01a06d02-7700-7000-8000-000000000007",
      "github/github",
      "rogier",
    );
    const { calls, context } = await openConnections({
      "POST /api/v1/connections": () =>
        new Promise((resolve) => {
          answerCreate = resolve;
        }),
    });
    const view = within(await openSetup("GitHub"));
    await userEvent.click(view.getByRole("button", { name: "Paste a token instead" }));
    const token = view.getByLabelText<HTMLInputElement>("Personal access token");
    await userEvent.type(token, "ghp-1{Enter}");
    expect(view.getByRole("button", { name: "Connecting…" }).getAttribute("aria-busy")).toBe(
      "true",
    );

    // Neither typing nor a switch of flow can drop the pending save.
    await userEvent.type(token, "-more");
    expect(token.value).toBe("ghp-1");
    const toSignIn = view.getByRole<HTMLButtonElement>("button", {
      name: "Sign in with GitHub instead",
    });
    expect(toSignIn.disabled).toBe(true);
    await userEvent.click(view.getByRole("button", { name: "Connecting…" }));

    answerCreate({ status: 201, body: created });
    await waitForClosed();
    expect(readCalls(calls, "POST", "/api/v1/connections").map((call) => call.body)).toEqual([
      { type: "github/github", credentials: { pat: "ghp-1" } },
    ]);
    // The app drops a finished mutation, and the pasted secret with it, once
    // the dialog is gone.
    await waitFor(() => {
      expect(context.queryClient.getMutationCache().getAll()).toHaveLength(0);
    });
  });

  it("forgets what was typed when the user switches flow", async () => {
    await openConnections();
    const view = within(await openSetup("GitHub"));
    await userEvent.click(view.getByRole("button", { name: "Paste a token instead" }));
    await userEvent.type(view.getByLabelText("Personal access token"), "ghp-1");
    await userEvent.click(view.getByRole("button", { name: "Sign in with GitHub instead" }));
    await userEvent.click(view.getByRole("button", { name: "Paste a token instead" }));
    expect(view.getByLabelText<HTMLInputElement>("Personal access token").value).toBe("");
  });

  it("gives an existing Connection fresh credentials on Reconnect", async () => {
    const path = `/api/v1/connections/${OFFICE_PAPERS.id}/credentials`;
    const { calls } = await openConnections({
      [`POST ${path}`]: { body: { ...OFFICE_PAPERS, status: "connected" } },
    });
    await chooseMenuItem(
      await screen.findByRole("button", { name: "More for Paper Trail · Office papers" }),
      "Reconnect…",
    );
    const view = within(
      await screen.findByRole("dialog", { name: "Reconnect Paper Trail · Office papers" }),
    );

    await userEvent.type(view.getByLabelText("Access token"), "k-789");
    await userEvent.type(view.getByLabelText("Signing secret"), "s-000");
    await userEvent.click(view.getByRole("button", { name: "Connect" }));

    await waitForClosed();
    expect(readCalls(calls, "POST", path).map((call) => call.body)).toEqual([
      { credentials: { token: "k-789", secret: "s-000" } },
    ]);
    expect(readCalls(calls, "POST", "/api/v1/connections")).toHaveLength(0);
  });

  it("closes on Cancel without sending anything", async () => {
    const { calls } = await openConnections();
    const view = within(await openSetup("Paper Trail"));
    await userEvent.click(view.getByRole("button", { name: "Cancel" }));
    await waitForClosed();
    expect(readCalls(calls, "POST", "/api/v1/connections")).toHaveLength(0);
  });
});

describe("the setup of a Connection with a device code", () => {
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
   * Opens GitHub's setup, answering each poll with the next of `polls`, then
   * the last again. A `done` poll adds a Connection to the list, as the
   * controller does.
   */
  const openGitHub = async (polls: readonly unknown[] = [{ status: "pending", interval: 5 }]) => {
    let connections: readonly Connection[] = [];
    let index = 0;
    const github = buildConnection(
      "01a06d02-7700-7000-8000-000000000004",
      "github/github",
      "rogier",
    );
    const app = await openConnections(
      {
        [`POST ${START_PATH}`]: () => ({ body: buildDeviceStart() }),
        [`POST ${POLL_PATH}`]: () => {
          const poll = polls[Math.min(index++, polls.length - 1)] as { status: string };
          if (poll.status === "done") {
            connections = [github];
            return { body: { status: "done", connection: github } };
          }
          return { body: poll };
        },
      },
      () => connections,
    );
    const dialog = await openSetup("GitHub");
    return { ...app, dialog, view: within(dialog) };
  };

  /** Presses Sign in with GitHub in `dialog` under a fake clock, and waits for the code. */
  const signIn = async (dialog: HTMLElement): Promise<void> => {
    const view = within(dialog);
    // `Date` is faked too, so the code's expiry moves with the fake time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fireEvent.click(view.getByRole("button", { name: "Sign in with GitHub" }));
    await pumpUntil(() => view.queryByText("WDJB-MJHT") !== null);
  };

  it("shows the code, opens the provider, and closes once the user approves", async () => {
    const { calls, dialog, fake, view } = await openGitHub([
      { status: "pending", interval: 5 },
      { status: "done" },
    ]);
    expect(view.getByText("You get a code to enter on GitHub.")).toBeTruthy();
    await signIn(dialog);

    expect(view.getByText("WDJB-MJHT").tagName).toBe("B");
    expect(view.getByRole("status").textContent).toBe(
      "Waiting for you to approve Hercule on GitHub. The code expires in 15 minutes.",
    );
    expect(view.getByText("github.com/login/device")).toBeTruthy();
    // The button that started the sign-in is gone, so the focus moves to the next step.
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Open GitHub" }));
    fireEvent.click(view.getByRole("button", { name: "Open GitHub" }));
    expect(fake.openedLinks).toEqual(["https://github.com/login/device"]);

    await advanceClock(10_000);
    await pumpUntil(() => screen.queryByRole("dialog") === null);
    expect(readCalls(calls, "POST", START_PATH).map((call) => call.body)).toEqual([
      { type: "github/github" },
    ]);
    expect(readCalls(calls, "POST", POLL_PATH)).toHaveLength(2);
  });

  it("says when the user declined, and asks for a new code on Start again", async () => {
    const { calls, dialog, view } = await openGitHub([
      { status: "denied", message: "The user declined." },
    ]);
    await signIn(dialog);
    await advanceClock(5_000);
    await pumpUntil(() => view.queryByRole("button", { name: "Start again" }) !== null);

    expect(
      view.getByText("The sign-in was declined, so nothing changed.").parentElement?.textContent,
    ).toBe(
      "The sign-in was declined, so nothing changed. Hercule was declined on GitHub’s approval page. Start again if that was a mistake.",
    );
    fireEvent.click(view.getByRole("button", { name: "Start again" }));
    await pumpUntil(() => readCalls(calls, "POST", START_PATH).length === 2);
    await pumpUntil(() => view.queryByText("WDJB-MJHT") !== null);
  });

  it("says when the code expired, with how long a code lasts", async () => {
    const { dialog, view } = await openGitHub();
    await signIn(dialog);
    await advanceClock(15 * 60_000);
    await pumpUntil(() => view.queryByRole("button", { name: "Start again" }) !== null);
    expect(
      view.getByText("The sign-in expired before it was approved.").parentElement?.textContent,
    ).toBe(
      "The sign-in expired before it was approved. A code lasts 15 minutes. Start again for a new one.",
    );
  });

  it("stops polling on Cancel, and when the dialog closes", async () => {
    const { calls, dialog, view } = await openGitHub();
    await signIn(dialog);
    await advanceClock(5_000);
    await pumpUntil(() => readCalls(calls, "POST", POLL_PATH).length === 1);

    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await pumpUntil(() => view.queryByRole("button", { name: "Sign in with GitHub" }) !== null);
    await advanceClock(60_000);
    expect(readCalls(calls, "POST", POLL_PATH)).toHaveLength(1);

    // A new sign-in polls again, until the dialog closes.
    await signIn(dialog);
    await advanceClock(5_000);
    await pumpUntil(() => readCalls(calls, "POST", POLL_PATH).length === 2);
    act(() => {
      dialog.close();
    });
    await pumpUntil(() => screen.queryByRole("dialog") === null);
    await advanceClock(60_000);
    expect(readCalls(calls, "POST", POLL_PATH)).toHaveLength(2);
  });

  it("drops a code that arrives after the user switched to pasting a token", async () => {
    let answerStart: (answer: { body: unknown }) => void = () => undefined;
    const { calls, context } = await openConnections({
      [`POST ${START_PATH}`]: () =>
        new Promise((resolve) => {
          answerStart = resolve;
        }),
    });
    const view = within(await openSetup("GitHub"));
    // With no field to type in, Enter signs in rather than pressing Cancel.
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Sign in with GitHub" }));
    await userEvent.click(view.getByRole("button", { name: "Sign in with GitHub" }));
    await userEvent.click(view.getByRole("button", { name: "Sign in with GitHub" }));
    expect(readCalls(calls, "POST", START_PATH)).toHaveLength(1);

    await userEvent.click(view.getByRole("button", { name: "Paste a token instead" }));
    answerStart({ body: buildDeviceStart() });
    // The answer has passed through the client and the mutation once no
    // mutation is pending.
    await waitFor(() => {
      expect(context.queryClient.isMutating()).toBe(0);
    });
    expect(view.queryByText("WDJB-MJHT")).toBeNull();
    expect(view.getByLabelText("Personal access token")).toBeTruthy();
    expect(view.getByRole("button", { name: "Sign in with GitHub instead" })).toBeTruthy();
  });

  it("says why when the code cannot be started", async () => {
    await openConnections({
      [`POST ${START_PATH}`]: {
        status: 409,
        body: buildErrorBody("invalid_state", "GitHub could not be reached."),
      },
    });
    const view = within(await openSetup("GitHub"));
    await userEvent.click(view.getByRole("button", { name: "Sign in with GitHub" }));
    expect(
      (await view.findByText("The sign-in did not finish, so nothing changed.")).parentElement
        ?.textContent,
    ).toBe("The sign-in did not finish, so nothing changed. GitHub could not be reached.");
    // The token stays one click away.
    expect(view.getByRole("button", { name: "Paste a token instead" })).toBeTruthy();
  });
});

describe("the setup of a Connection with OAuth", () => {
  it("opens the provider's page with the controller's origin, and closes when the Connection arrives", async () => {
    let connections: readonly Connection[] = [OFFICE_PAPERS];
    const authorizationUrl = "https://mail.example/authorize?state=abc";
    const { calls, fake, live } = await openConnections(
      { "POST /api/v1/oauth/start": { body: { authorizationUrl } } },
      () => connections,
    );
    const dialog = await openSetup("Mailbox");
    const view = within(dialog);

    expect(view.getByText("You sign in to Mailbox in your browser.")).toBeTruthy();
    expect(view.getByText("http://controller.test/oauth/callback")).toBeTruthy();
    await userEvent.click(view.getByRole("button", { name: "Sign in with Mailbox" }));

    expect(await view.findByText("Finish in your browser")).toBeTruthy();
    expect(fake.openedLinks).toEqual([authorizationUrl]);
    expect(readCalls(calls, "POST", "/api/v1/oauth/start").map((call) => call.body)).toEqual([
      { type: "mailbox/mail", origin: "http://controller.test" },
    ]);

    // A Connection of another type is not the one the sign-in writes.
    const other = buildConnection("01a06d02-7700-7000-8000-000000000005", "paper-trail/paper", "b");
    connections = [OFFICE_PAPERS, other];
    live.pushInvalidation("connection", [other.id]);
    await waitFor(() => {
      expect(readCalls(calls, "GET", "/api/v1/connections").length).toBeGreaterThan(1);
    });
    expect(dialog.open).toBe(true);

    const mail = buildConnection("01a06d02-7700-7000-8000-000000000006", "mailbox/mail", "me");
    connections = [OFFICE_PAPERS, other, mail];
    live.pushInvalidation("connection", [mail.id]);
    await waitForClosed();
  });

  it("waits without a spinner, and opens the page again on Open again", async () => {
    const authorizationUrl = "https://mail.example/authorize?state=abc";
    const { fake } = await openConnections({
      "POST /api/v1/oauth/start": { body: { authorizationUrl } },
    });
    const view = within(await openSetup("Mailbox"));
    await userEvent.click(view.getByRole("button", { name: "Sign in with Mailbox" }));
    await view.findByText("Finish in your browser");

    // The user may give up in the browser, so the wait may never end.
    expect(view.getByRole("status").querySelector(".spin")).toBeNull();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Open again" }));
    await userEvent.click(view.getByRole("button", { name: "Open again" }));
    expect(fake.openedLinks).toEqual([authorizationUrl, authorizationUrl]);
  });

  it("says when the browser did not open the page", async () => {
    const authorizationUrl = "https://mail.example/authorize?state=abc";
    const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
    vi.spyOn(fake.bridge.link, "open").mockRejectedValueOnce(new Error("No browser is set."));
    stubApi({
      ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, plugins: PLUGINS }),
      "GET /api/v1/connections": { body: { items: [] } },
      "POST /api/v1/oauth/start": { body: { authorizationUrl } },
    });
    await renderApp(fake, { path: "/settings/connections" });
    const view = within(await openSetup("Mailbox"));
    await userEvent.click(view.getByRole("button", { name: "Sign in with Mailbox" }));

    expect((await view.findByRole("alert")).textContent).toBe(
      "The browser did not open the sign-in page: No browser is set.",
    );
    // A second try that opens the page clears the error.
    await userEvent.click(view.getByRole("button", { name: "Open again" }));
    await waitFor(() => {
      expect(view.queryByRole("alert")).toBeNull();
    });
  });

  it("does not open a sign-in page that is not a web address", async () => {
    const { fake } = await openConnections({
      "POST /api/v1/oauth/start": { body: { authorizationUrl: "file:///etc/passwd" } },
    });
    const view = within(await openSetup("Mailbox"));
    await userEvent.click(view.getByRole("button", { name: "Sign in with Mailbox" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "The sign-in page is not a web address, so it was not opened: file:///etc/passwd",
    );
    expect(fake.openedLinks).toEqual([]);
  });

  it("closes on Cancel while the sign-in finishes in the browser", async () => {
    await openConnections({
      "POST /api/v1/oauth/start": { body: { authorizationUrl: "https://mail.example/a" } },
    });
    const view = within(await openSetup("Mailbox"));
    await userEvent.click(view.getByRole("button", { name: "Sign in with Mailbox" }));
    await view.findByText("Finish in your browser");
    await userEvent.click(view.getByRole("button", { name: "Cancel" }));
    await waitForClosed();
  });

  it("shows why the sign-in could not start under the form", async () => {
    await openConnections({
      "POST /api/v1/oauth/start": {
        status: 409,
        body: buildErrorBody("invalid_state", "Mailbox has no client credentials."),
      },
    });
    const view = within(await openSetup("Mailbox"));
    await userEvent.click(view.getByRole("button", { name: "Sign in with Mailbox" }));
    expect((await view.findByRole("alert")).textContent).toBe("Mailbox has no client credentials.");
    expect(view.getByRole("button", { name: "Sign in with Mailbox" })).toBeTruthy();
  });
});

describe("a setup this version cannot run", () => {
  it("says that pairing is not built yet", async () => {
    await openConnections();
    const view = within(await openSetup("Chatter"));
    expect(view.getByText("Pairing a chat account is not built yet.")).toBeTruthy();
    await userEvent.click(view.getByRole("button", { name: "Close" }));
    await waitForClosed();
  });

  it("says that the setup takes a step this version does not know", async () => {
    await openConnections();
    const view = within(await openSetup("Pigeon Post"));
    expect(
      view.getByText("Setting up Pigeon Post takes a step this version of Hercule does not know."),
    ).toBeTruthy();
  });
});
