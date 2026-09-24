/**
 * Tests the composer on a draft thread against a stubbed controller. Also
 * checks that `/threads/new` matches the static route, and that the
 * `$sessionId` route does not read "new" as a session id.
 *
 * The tests drive the app only through `renderApp` and the stubbed `fetch`.
 * They never import the screen's own modules.
 *
 * Where the spec leaves a rendering detail open, these tests assume:
 * - The `+` and voice buttons show why they are disabled in a `title`
 *   attribute (`screen.getByTitle(...)`). The codebase has no convention yet
 *   for a lone icon button; `ListRow`'s "dimmed, second line" rule is for
 *   menu rows.
 * - The send button's accessible name contains "send".
 * - The model options selector is labelled with the chosen effort choice's
 *   `label` in lower case (e.g. "Medium" shows as "medium").
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Connection,
  ModelOption,
  Profile,
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  Workspace,
} from "@hercule/contract";
import { buildThreadsWorld } from "@hercule/client-core/threads/testing";
import {
  buildErrorBody,
  pickRow,
  readPageText,
  renderApp,
  stubApi,
  type Handler,
} from "../../../app/testing";

const ZONE = "Europe/Amsterdam";

const RUNNER: Runner = {
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "moss",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.4.2",
  labels: [],
  facts: null,
  watermark: null,
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 10 * 1024 * 1024 * 1024,
  lastSeenAt: "2026-09-05T09:14:00.000Z",
};

const DECLARED: ProviderInstance["declared"] = {
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
};

const EFFORT: ModelOption = {
  id: "effort",
  label: "Reasoning effort",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  default: "medium",
};

const THINKING: ModelOption = {
  id: "thinking",
  label: "Extended thinking",
  kind: "boolean",
  default: true,
};

const buildSnapshot = (
  runnerId: string,
  identity: string,
  planLabel: string,
  models: ProviderInstance["snapshots"][number]["models"],
): ProviderInstance["snapshots"][number] => ({
  runnerId,
  probedAt: "2026-09-05T09:10:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "ok", identity, planLabel },
  models,
});

const buildProviderInstance = (
  id: string,
  name: string,
  displayName: string,
  snapshots: ProviderInstance["snapshots"],
): ProviderInstance => ({
  id,
  providerId: "claude-code",
  secretFields: [],
  name,
  config: {},
  displayName,
  binaryName: "claude",
  declared: DECLARED,
  snapshots,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

/** Logged in on the one runner, two models, the default one carrying options. */
const INSTANCE_A = buildProviderInstance(
  "01a06d02-1000-7000-8000-000000000001",
  "personal",
  "Claude Code",
  [
    buildSnapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        isDefault: true,
        options: [EFFORT, THINKING],
      },
      { slug: "claude-opus-5", name: "Claude Opus 5", options: [] },
    ]),
  ],
);

/** A second account of the same provider, one model, no options. */
const INSTANCE_B = buildProviderInstance(
  "01a06d02-1000-7000-8000-000000000002",
  "work",
  "Claude Code",
  [
    buildSnapshot(RUNNER.id, "work@example.com", "Claude Pro", [
      { slug: "claude-haiku-5", name: "Claude Haiku 5", isDefault: true, options: [] },
    ]),
  ],
);

/**
 * The real first-run state: the instance exists (spec 06 §2, one per shipped
 * provider) but nothing has logged in on the one runner yet, so there is no
 * snapshot at all - `buildRunnerMenu`'s only row dims "not logged in" and its
 * `defaultRunnerId` is null.
 */
const INSTANCE_FRESH = buildProviderInstance(
  "01a06d02-1000-7000-8000-000000000003",
  "Claude Code",
  "Claude Code",
  [],
);

const PROFILE_UNRESTRICTED: Profile = {
  id: "01a06d02-3000-7000-8000-000000000001",
  name: "unrestricted",
  grants: [],
  shipped: true,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
};

const PROFILE_WORKER: Profile = {
  ...PROFILE_UNRESTRICTED,
  id: "01a06d02-3000-7000-8000-000000000002",
  name: "worker",
};

const NEW_SESSION: Session = {
  id: "01a06d02-4000-7000-8000-000000000001",
  title: "Fix the login bug",
  status: "starting",
  resumable: false,
  permissionProfileId: PROFILE_UNRESTRICTED.id,
  agentId: null,
  instanceId: INSTANCE_A.id,
  runnerId: RUNNER.id,
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequest: null,
  createdAt: "2026-09-08T10:00:00.000Z",
  startedAt: null,
  exitedAt: null,
  lastActivityAt: "2026-09-08T10:00:00.000Z",
  unenforced: [],
};

const buildController = (
  instances: readonly ProviderInstance[],
  user: Record<string, unknown> = {},
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: ZONE, ...user },
    },
  },
  "GET /api/v1/providers": { body: instances },
  "GET /api/v1/runners": { body: { items: [RUNNER] } },
  "GET /api/v1/profiles": { body: { items: [PROFILE_UNRESTRICTED, PROFILE_WORKER] } },
  // After a send, the app navigates to the new thread. These stubs
  // serve the session that the spawn returns, so the thread route's loader
  // does not fail with a 404 and break the navigation under test.
  [`GET /api/v1/sessions/${NEW_SESSION.id}`]: { body: NEW_SESSION },
  [`GET /api/v1/sessions/${NEW_SESSION.id}/transcript`]: { body: { items: [] } },
  ...extra,
});

const openApp = async (
  instances: readonly ProviderInstance[] = [INSTANCE_A, INSTANCE_B],
  user: Record<string, unknown> = {},
  extra: Readonly<Record<string, Handler>> = {},
  storage: Readonly<Record<string, string>> = {},
) => {
  const api = stubApi(buildController(instances, user, extra));
  const app = await renderApp({
    path: "/threads/new",
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(RUNNER.id),
    storage,
  });
  return { ...app, api };
};

describe("Composer: draft defaults", () => {
  it("prefills from the spawn defaults when no thread.* setting is stored", async () => {
    await openApp([INSTANCE_A]);

    expect(screen.getByRole("heading", { name: "What should the agent do?" })).toBeDefined();

    expect(screen.getByRole("textbox")).toBeDefined();

    const attach = screen.getByTitle<HTMLButtonElement>("Attachments are not built yet");
    expect(attach.disabled).toBe(true);

    const voice = screen.getByTitle<HTMLButtonElement>("Dictation is not built yet");
    expect(voice.disabled).toBe(true);

    // The model pill shows the default model. Its options are in the selector
    // next to it, labelled with the effort choice "Medium" in lower case.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Claude Sonnet 5" })).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "medium" })).toBeDefined();

    expect(screen.getByRole("button", { name: /approval-required/i })).toBeDefined();

    expect(screen.getByText("No workspace")).toBeDefined();
    expect(screen.getByText(RUNNER.name)).toBeDefined();

    const send = screen.getByRole<HTMLButtonElement>("button", { name: /send/i });
    expect(send.disabled).toBe(true);
  });

  it("prefills from the thread.* settings when they are stored", async () => {
    await openApp([INSTANCE_A, INSTANCE_B], {
      "thread.instanceId": INSTANCE_B.id,
      "thread.model": "claude-haiku-5",
      "thread.accessMode": "auto",
      "thread.profileId": PROFILE_WORKER.id,
    });

    // There are two accounts of one provider, so the pill includes the
    // account name. claude-haiku-5 has no options, so no options selector
    // appears next to the pill.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "work Claude Haiku 5" })).toBeDefined();
    });
    expect(screen.getByRole("button", { name: /^auto$/i })).toBeDefined();
  });
});

describe("Composer: a fresh install, nothing logged in on the one runner yet", () => {
  it("shows only the pill parts it has, with no dangling separator, when there is no model to offer", async () => {
    await openApp([INSTANCE_FRESH]);

    // There is no model to show, and no separator is left over.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "No model" })).toBeDefined();
    });
  });

  it("shows the runner's name and why it is dimmed on the runner button, not just the word Runner", async () => {
    await openApp([INSTANCE_FRESH]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: `machine ${RUNNER.name} · not logged in` }),
      ).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: "Runner" })).toBeNull();
  });

  it("explains why the draft cannot start, and offers no Log in on a machine where the instance was never found", async () => {
    await openApp([INSTANCE_FRESH]);

    // This instance was never probed on the only runner, so there is nothing
    // to log in to there. The screen shows only the reason.
    await waitFor(() => {
      expect(readPageText()).toContain(`Can't start yet. Claude Code is not on ${RUNNER.name}.`);
    });
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  it("keeps send disabled and shows the reason, instead of spawning with empty ids", async () => {
    // Nothing is logged in, so `buildRunnerMenu` offers no selectable row, and
    // the draft's runner, model and profile stay null. Sending would post ids
    // that the contract's `Id` schema rejects, and the error would be about
    // fields the user never touched.
    const user = userEvent.setup();
    const { api } = await openApp([INSTANCE_FRESH]);

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    const send = await screen.findByRole<HTMLButtonElement>("button", { name: /send/i });
    await waitFor(() => {
      expect(send.disabled).toBe(true);
    });
    expect(readPageText()).toContain(`Claude Code is not on ${RUNNER.name}`);
    expect(
      api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
    ).toBe(false);
  });

  it("keeps send disabled with the reason when no provider instance exists at all", async () => {
    const user = userEvent.setup();
    await openApp([]);

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    const send = screen.getByRole<HTMLButtonElement>("button", { name: /send/i });
    await waitFor(() => {
      expect(send.disabled).toBe(true);
    });
    expect(readPageText()).toContain("no provider instance is set up");
  });
});

describe("Composer: selector popovers", () => {
  it("opens one popover at a time, closes on Esc and on an outside click, and keeps typed text", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    // On a draft with no project, the workspace selector is locked text, so
    // this test uses the machine and model selectors.
    await user.click(screen.getByRole("button", { name: /^machine / }));
    expect(await screen.findByText("Machine")).toBeDefined();

    // Opening a second selector closes the first. The new popover's content
    // mounts through Radix's `Presence` one microtask after the click, so the
    // test waits for it instead of asserting right away.
    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    await waitFor(() => {
      expect(screen.queryByText("Machine")).toBeNull();
    });
    expect(await screen.findByRole("button", { name: /claude opus 5/i })).toBeDefined();

    // Esc closes the open popover.
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /claude opus 5/i })).toBeNull();
    });

    // An outside click closes it too.
    await user.click(screen.getByRole("button", { name: /^machine / }));
    expect(await screen.findByText("Machine")).toBeDefined();
    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByText("Machine")).toBeNull();
    });

    // The text typed at the start is still there.
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Fix the login bug");
  });

  // A draft in no project has no workspace to choose, so the workspace field
  // is greyed-out text. Its tooltip asks the user to pick a project, because
  // adding a repo makes no sense while the draft is in no project.
  it("shows No workspace as locked text on a draft in no project", async () => {
    const user = userEvent.setup();
    await openApp();

    const locked = await screen.findByTitle("Pick a project to work in a repository");
    expect(readPageText(locked)).toContain("No workspace");
    expect(locked.closest("button")).toBeNull();

    await user.click(locked);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the runner menu with each machine's state and capacity beside it, and its description below", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole("button", { name: "machine moss" }));

    // The state word is in its own colored span, so the row's text spans
    // several elements. The test reads the whole dialog's text instead of
    // looking for one element with the exact string.
    const dialog = readPageText(await screen.findByRole("dialog"));
    // The row shows the machine, its state and how many session slots are
    // used, with a description below. The model menu shows who is logged in,
    // not this menu.
    expect(dialog).toContain("moss online 0/4");
    expect(dialog).toContain("this machine · default");
    expect(dialog).toContain("The thread runs where you say; nothing moves it later.");
  });
});

describe("Composer: model menu", () => {
  it("expands the current instance, collapses the others and offers no free-text entry", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    const menu = await screen.findByRole("dialog");

    // The other account's row shows its identity and plan, from its snapshot.
    expect(readPageText()).toContain("work@example.com");
    expect(readPageText()).toContain("Claude Pro");

    // The current instance (A) is expanded, with both its models listed.
    expect(within(menu).getByRole("button", { name: /claude sonnet 5/i })).toBeDefined();
    expect(within(menu).getByRole("button", { name: /claude opus 5/i })).toBeDefined();

    // The other instance (B) is collapsed to one row: "<n> models".
    expect(readPageText()).toContain("1 models");

    expect(screen.queryByText(/custom model/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/model/i)).toBeNull();
  });

  it("renders a select option as a segmented row and a boolean option as an off · on row", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole("button", { name: "medium" }));

    // `SegmentedControl` is built on Radix's `ToggleGroup` with
    // `type="single"`, which gives each item `role="radio"` (see the
    // SegmentedControl tests in `packages/ui/src/primitives/primitives.test.tsx`).
    // A radio group is more accessible than plain buttons that act like one.
    // The composer reuses the control that Settings > Threads uses for its
    // access mode row, so no new UI dependency is needed.
    for (const choice of ["Low", "Medium", "High"]) {
      expect(screen.getByRole("radio", { name: choice })).toBeDefined();
    }
    // A boolean descriptor is the same segmented row with two choices.
    expect(screen.getByRole("radio", { name: "on" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "off" })).toBeDefined();
  });

  it("switches the pill's instance when a model of another instance is chosen", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    // Instance B is collapsed to a one-row summary. Clicking that row is the
    // "click to switch" of spec 14 §The composer.
    await user.click(screen.getByRole("button", { name: /work.*1 models/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "work Claude Haiku 5" })).toBeDefined();
    });
  });

  it("changes the options selector's label when an option is chosen", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole("button", { name: "medium" }));
    // As in the "renders a select option..." test above, `SegmentedControl`
    // gives each choice `role="radio"`, not `role="button"`.
    await user.click(screen.getByRole("radio", { name: "High" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "high" })).toBeDefined();
    });
  });
});

describe("Composer: sending", () => {
  it("spawns with exactly the selectors' values, navigates to the new thread, and never patches settings", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp(
      [INSTANCE_A],
      {},
      {
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    );

    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${NEW_SESSION.id}`);
    });

    const spawn = api.calls.find(
      (call) => call.method === "POST" && call.path === "/api/v1/sessions",
    );
    expect(spawn?.body).toEqual({
      prompt: "Fix the login bug",
      instanceId: INSTANCE_A.id,
      model: "claude-sonnet-5",
      accessMode: "approval-required",
      runnerId: RUNNER.id,
      permissionProfileId: PROFILE_UNRESTRICTED.id,
      // A spawn always sends the option picks, so a thread started with no
      // picks sends an empty record instead of leaving the field out.
      options: {},
    });

    expect(
      api.calls.some((call) => call.method === "PATCH" && call.path === "/api/v1/settings"),
    ).toBe(false);
  });

  it("spawns with the model options picked in the pill", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp(
      [INSTANCE_A],
      {},
      {
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    );

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    // The picks are made in the model options popover: the `effort` row, and
    // the `thinking` row, which is on by default and is turned off here.
    await user.click(screen.getByRole("button", { name: "medium" }));
    await user.click(await screen.findByRole("radio", { name: "High" }));
    await user.click(screen.getByRole("radio", { name: "off" }));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${NEW_SESSION.id}`);
    });

    const spawn = api.calls.find(
      (call) => call.method === "POST" && call.path === "/api/v1/sessions",
    );
    expect(spawn?.body).toEqual({
      prompt: "Fix the login bug",
      instanceId: INSTANCE_A.id,
      model: "claude-sonnet-5",
      accessMode: "approval-required",
      runnerId: RUNNER.id,
      permissionProfileId: PROFILE_UNRESTRICTED.id,
      options: { effort: "high", thinking: false },
    });
  });

  it("sends on Enter, inserts a newline on Shift+Enter, and never sends on an IME's Enter", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp(
      [INSTANCE_A],
      {},
      {
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    );

    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox");
    await user.type(textbox, "First line");

    // Shift+Enter is a newline, never a send.
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(textbox, "second line");
    expect(textbox.value).toBe("First line\nsecond line");
    expect(
      api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
    ).toBe(false);

    // The Enter that commits an IME composition does not send either, or it
    // would cut off a Japanese or Chinese sentence mid-word. Typing one more
    // character afterwards gives a wrongly sent request time to show up, so
    // the assertion below does not pass just because it ran too early.
    fireEvent.keyDown(textbox, { key: "Enter", isComposing: true });
    await user.type(textbox, "!");
    expect(
      api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
    ).toBe(false);

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${NEW_SESSION.id}`);
    });
    const spawn = api.calls.find(
      (call) => call.method === "POST" && call.path === "/api/v1/sessions",
    );
    expect((spawn?.body as { prompt: string }).prompt).toBe("First line\nsecond line!");
  });

  it("leaves send disabled while the prompt is empty", async () => {
    await openApp([INSTANCE_A]);

    const send = screen.getByRole<HTMLButtonElement>("button", { name: /send/i });
    expect(send.disabled).toBe(true);
  });

  it("shows the API's error message under the card and keeps the typed text", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(
      [INSTANCE_A],
      {},
      {
        "POST /api/v1/sessions": {
          status: 409,
          body: buildErrorBody("invalid_state", "moss is not logged in to Claude Code"),
        },
      },
    );

    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "moss is not logged in to Claude Code",
    );
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Fix the login bug");
    expect(
      api.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
    ).toHaveLength(1);
  });
});

describe("Routing: /threads/new is the static route", () => {
  it("renders the composer rather than reading 'new' as a session id", async () => {
    const { api } = await openApp([INSTANCE_A]);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "What should the agent do?" })).toBeDefined();
    });
    expect(api.calls.some((call) => call.path === "/api/v1/sessions/new")).toBe(false);
  });
});

/**
 * Tests for the rebuilt composer on a draft thread, rendered with `renderApp`
 * at `/threads/new` and `stubApi`, like the tests above.
 *
 * How these tests find things on the page:
 * - The model pill is the button whose accessible name contains the model's
 *   *display* name ("Claude Sonnet 5").
 * - The model options selector is the button whose accessible name is its
 *   label text ("medium", "high", "high ⚡").
 * - A boolean descriptor is a segmented `off · on` row, like every other
 *   descriptor.
 * - The older-models fold and every menu row are buttons with their text.
 * - A menu is the Radix popover, found as `role="dialog"`. Queries for a row
 *   are scoped to it, because the page outside also holds the trigger.
 */

/** Builds a snapshot of an instance that is installed on the runner with nobody logged in. */
const buildUnauthenticatedSnapshot = (runnerId: string): ProviderInstance["snapshots"][number] => ({
  runnerId,
  probedAt: "2026-09-05T09:10:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "unauthenticated" },
  models: [],
});

const LOGGED_OUT = buildProviderInstance(
  "01a06d02-1000-7000-8000-000000000004",
  "Claude Code",
  "Claude Code",
  [buildUnauthenticatedSnapshot(RUNNER.id)],
);

/** The same instance after the login in the test below has finished. */
const LOGGED_IN: ProviderInstance = {
  ...LOGGED_OUT,
  snapshots: [
    buildSnapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
      { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isDefault: true, options: [] },
    ]),
  ],
};

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize?code=1";

describe("Composer: a login updates the open draft", () => {
  it("blocks the draft with the login message, then uses the new model list and spawns with it", async () => {
    const user = userEvent.setup();
    let held: readonly ProviderInstance[] = [LOGGED_OUT];
    const { api } = await openApp(
      [LOGGED_OUT],
      {},
      {
        "GET /api/v1/providers": () => ({ body: held }),
        [`POST /api/v1/providers/${LOGGED_OUT.id}/login`]: { body: { url: AUTHORIZE_URL } },
        [`POST /api/v1/providers/${LOGGED_OUT.id}/login-code`]: () => {
          held = [LOGGED_IN];
          return { body: LOGGED_IN.snapshots[0] };
        },
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    );

    // Nothing is logged in, so there is no model to show. The blocking
    // message names the provider and the machine, and what is missing.
    await waitFor(() => {
      expect(readPageText()).toContain(
        "Can't start yet. Claude Code is on moss but not logged in.",
      );
    });
    expect(screen.queryByRole("button", { name: /claude sonnet 5/i })).toBeNull();
    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /send/i }).disabled).toBe(true);

    // The Log in button is next to the blocking message, and the login runs
    // on the draft's runner.
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => {
      expect(readPageText()).toContain(AUTHORIZE_URL);
    });
    expect(api.calls.find((call) => call.path.endsWith("/login"))?.body).toEqual({
      runnerId: RUNNER.id,
    });

    await user.type(screen.getByLabelText("Code", { exact: true }), "the-whole-code");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    // The draft recomputes its defaults on every render, so the new model
    // list fills in what the user did not pick: the model appears and the
    // blocking message goes away.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /claude sonnet 5/i })).toBeDefined();
    });
    expect(readPageText()).not.toContain("Can't start yet.");
    const send = screen.getByRole<HTMLButtonElement>("button", { name: /send/i });
    await waitFor(() => {
      expect(send.disabled).toBe(false);
    });

    await user.click(send);

    const spawn = await waitFor(() => {
      const found = api.calls.find(
        (call) => call.method === "POST" && call.path === "/api/v1/sessions",
      );
      if (found === undefined) throw new Error("nothing spawned yet");
      return found;
    });
    expect(spawn.body).toMatchObject({
      prompt: "Fix the login bug",
      instanceId: LOGGED_OUT.id,
      model: "claude-sonnet-5",
      runnerId: RUNNER.id,
    });
  });
});

/** Builds a model with no options. `extra` adds or overrides fields. */
const buildModel = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name,
  options: [],
  ...extra,
});

/** With `MANY_B`: nine models across two accounts, one over the filter threshold. */
const MANY_A = buildProviderInstance(
  "01a06d02-1000-7000-8000-000000000011",
  "personal",
  "Claude Code",
  [
    buildSnapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
      buildModel("claude-sonnet-5", "Claude Sonnet 5", { isDefault: true }),
      buildModel("claude-opus-5", "Claude Opus 5"),
      buildModel("claude-haiku-5", "Claude Haiku 5"),
      buildModel("claude-sonnet-4", "Claude Sonnet 4"),
      buildModel("claude-haiku-4", "Claude Haiku 4"),
    ]),
  ],
);

const MANY_B = buildProviderInstance(
  "01a06d02-1000-7000-8000-000000000012",
  "work",
  "Claude Code",
  [
    buildSnapshot(RUNNER.id, "work@example.com", "Claude Pro", [
      buildModel("claude-opus-4", "Claude Opus 4", { isDefault: true }),
      buildModel("claude-sonnet-3", "Claude Sonnet 3"),
      buildModel("claude-haiku-3", "Claude Haiku 3"),
      buildModel("claude-sonnet-2", "Claude Sonnet 2"),
    ]),
  ],
);

/** With `MANY_A`: eight models in total, which is not over the filter threshold. */
const EIGHT_B: ProviderInstance = {
  ...MANY_B,
  snapshots: [
    buildSnapshot(RUNNER.id, "work@example.com", "Claude Pro", [
      buildModel("claude-opus-4", "Claude Opus 4", { isDefault: true }),
      buildModel("claude-sonnet-3", "Claude Sonnet 3"),
      buildModel("claude-haiku-3", "Claude Haiku 3"),
    ]),
  ],
};

/** An instance with one legacy model, which the menu hides under "older models". */
const WITH_LEGACY = buildProviderInstance(
  "01a06d02-1000-7000-8000-000000000013",
  "personal",
  "Claude Code",
  [
    buildSnapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
      buildModel("claude-sonnet-5", "Claude Sonnet 5", { isDefault: true }),
      buildModel("claude-opus-5", "Claude Opus 5"),
      buildModel("claude-sonnet-4", "Claude Sonnet 4", { isLegacy: true }),
    ]),
  ],
);

/** A second provider with one account, so its rows never show an account name. */
const CODEX: ProviderInstance = {
  ...buildProviderInstance("01a06d02-1000-7000-8000-000000000014", "openai", "Codex", [
    buildSnapshot(RUNNER.id, "rogier@openai.test", "Plus", [
      buildModel("gpt-5-codex", "GPT-5 Codex", { isDefault: true }),
    ]),
  ]),
  providerId: "codex",
  binaryName: "codex",
};

/** Another provider's account, which nobody has logged in to on this machine. */
const OTHER_LOGGED_OUT: ProviderInstance = {
  ...buildProviderInstance("01a06d02-1000-7000-8000-000000000015", "openai", "Codex", [
    buildUnauthenticatedSnapshot(RUNNER.id),
  ]),
  providerId: "codex",
  binaryName: "codex",
};

const RECENT_KEY = "hercule.recentModels";

/** Builds the `localStorage` contents for a draft whose Recent lane already holds `pairs`. */
const buildRecentStorage = (
  pairs: ReadonlyArray<{ instanceId: string; model: string }>,
): Record<string, string> => ({ [RECENT_KEY]: JSON.stringify(pairs) });

/** Opens the model menu by clicking its pill, and returns the popover. */
const openModelMenu = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog");
};

describe("Composer: model menu shapes", () => {
  it("(a) offers a focused filter above eight models, and shows only the matches in every account", async () => {
    const user = userEvent.setup();
    await openApp([MANY_A, MANY_B]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    const filter = within(menu).getByPlaceholderText("Filter models…");
    expect(document.activeElement).toBe(filter);

    await user.type(filter, "opus");

    // The current account shows only its match, and the other account is
    // expanded to show its match.
    await waitFor(() => {
      expect(within(menu).queryByRole("button", { name: /claude sonnet 5/i })).toBeNull();
    });
    expect(within(menu).getByRole("button", { name: /claude opus 5/i })).toBeDefined();
    expect(within(menu).getByRole("button", { name: /claude opus 4/i })).toBeDefined();
    expect(within(menu).queryByRole("button", { name: /claude haiku/i })).toBeNull();
  });

  it("(a) offers no filter at eight models", async () => {
    const user = userEvent.setup();
    await openApp([MANY_A, EIGHT_B]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(within(menu).queryByPlaceholderText("Filter models…")).toBeNull();
  });

  it("(b) lists the recent pairs newest first, and shows the account only when the provider has two", async () => {
    const user = userEvent.setup();
    await openApp(
      [INSTANCE_A, INSTANCE_B, CODEX],
      {},
      {},
      buildRecentStorage([
        { instanceId: CODEX.id, model: "gpt-5-codex" },
        { instanceId: INSTANCE_A.id, model: "claude-opus-5" },
      ]),
    );

    const menu = await openModelMenu(user, /claude sonnet 5/i);
    const lane = readPageText(menu);

    expect(lane).toContain("Recent");
    // Newest first, and both above the current account's lane.
    expect(lane.indexOf("Recent")).toBeLessThan(lane.indexOf("GPT-5 Codex"));
    expect(lane.indexOf("GPT-5 Codex")).toBeLessThan(lane.indexOf("Claude Opus 5"));

    // Claude Code has two accounts here, so its recent row shows the account.
    // The row of the provider with one account shows none.
    const recentOpus = within(menu).getAllByRole("button", { name: /claude opus 5/i })[0];
    expect(readPageText(recentOpus ?? null)).toContain("personal");
    expect(readPageText(within(menu).getByRole("button", { name: /gpt-5 codex/i }))).not.toContain(
      "openai",
    );
  });

  it("(c) hides a legacy model under older models (1) until that is opened", async () => {
    const user = userEvent.setup();
    await openApp([WITH_LEGACY]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(within(menu).queryByRole("button", { name: /claude sonnet 4/i })).toBeNull();
    expect(readPageText(menu)).toContain("older models (1)");

    await user.click(within(menu).getByRole("button", { name: /older models \(1\)/i }));

    expect(await within(menu).findByRole("button", { name: /claude sonnet 4/i })).toBeDefined();
  });

  it("(d) shows an unauthenticated account as one dimmed row with its own Log in", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(
      [INSTANCE_A, OTHER_LOGGED_OUT],
      {},
      {
        [`POST /api/v1/providers/${OTHER_LOGGED_OUT.id}/login`]: { body: { url: AUTHORIZE_URL } },
      },
    );

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(readPageText(menu)).toContain("not logged in");
    // The account is one row, not a lane of models, because it has no models
    // to pick.
    expect(within(menu).queryByRole("button", { name: /claude haiku 5/i })).toBeNull();

    await user.click(within(menu).getByRole("button", { name: "Log in" }));

    await waitFor(() => {
      expect(readPageText()).toContain(AUTHORIZE_URL);
    });
    // The row logs in to its own account, not the currently selected one, on
    // the machine where the credential will be stored.
    expect(screen.getByText("Log in to Codex on moss")).toBeDefined();
    expect(api.calls.find((call) => call.path.endsWith("/login"))?.body).toEqual({
      runnerId: RUNNER.id,
    });
  });

  it("(e) labels the current lane with the account name when the provider has two", async () => {
    const user = userEvent.setup();
    await openApp([INSTANCE_A, INSTANCE_B]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(readPageText(menu)).toContain("personal");
  });

  it("(e) labels the current lane with the provider's name when it has one", async () => {
    const user = userEvent.setup();
    await openApp([INSTANCE_A]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(readPageText(menu)).toContain("Claude Code");
    expect(readPageText(menu)).not.toContain("personal");
  });
});

describe("Composer: the Recent lane is written only after a successful spawn", () => {
  const pickOpusAndSend = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    await user.click(await screen.findByRole("button", { name: /claude sonnet 5/i }));
    await pickRow(user, /claude opus 5/i);
    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: /send/i }));
  };

  it("writes the pair the user picked once the spawn succeeds", async () => {
    const user = userEvent.setup();
    await openApp(
      [INSTANCE_A],
      {},
      { "POST /api/v1/sessions": { body: NEW_SESSION } },
      buildRecentStorage([]),
    );

    await pickOpusAndSend(user);

    await waitFor(() => {
      expect(localStorage.getItem(RECENT_KEY)).toBe(
        JSON.stringify([{ instanceId: INSTANCE_A.id, model: "claude-opus-5" }]),
      );
    });
  });

  it("writes nothing when the spawn fails, because no thread was started", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(
      [INSTANCE_A],
      {},
      {
        "POST /api/v1/sessions": {
          status: 409,
          body: buildErrorBody("invalid_state", "moss is not logged in to Claude Code"),
        },
      },
      buildRecentStorage([]),
    );

    await pickOpusAndSend(user);

    await waitFor(() => {
      expect(
        api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
      ).toBe(true);
    });
    // Unchanged: still the empty list it started with.
    expect(localStorage.getItem(RECENT_KEY)).toBe("[]");
  });
});

const FAST_MODE: ModelOption = {
  id: "fastMode",
  label: "Fast mode",
  kind: "boolean",
  default: false,
};

/** An instance with one model, which has a select descriptor and a boolean one. */
const WITH_OPTIONS = buildProviderInstance(
  "01a06d02-1000-7000-8000-000000000016",
  "personal",
  "Claude Code",
  [
    buildSnapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        isDefault: true,
        options: [EFFORT, FAST_MODE],
      },
    ]),
  ],
);

describe("Composer: the model options selector's label", () => {
  it("shows the effort choice in lower case, updates on a pick, and adds a bolt when fast mode is on", async () => {
    const user = userEvent.setup();
    await openApp([WITH_OPTIONS]);

    // `medium` is the descriptor's default, from its label "Medium" in lower case.
    const selector = await screen.findByRole("button", { name: "medium" });

    await user.click(selector);
    const menu = await screen.findByRole("dialog");
    // The header shows what is being changed, and for which model.
    expect(readPageText(menu)).toContain("Model options");
    expect(readPageText(menu)).toContain("Claude Sonnet 5");

    await user.click(within(menu).getByRole("radio", { name: "High" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "high" })).toBeDefined();
    });

    await user.click(within(menu).getByRole("radio", { name: "on" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "high ⚡" })).toBeDefined();
    });
  });
});

/**
 * An instance where `auto` is not native, so it runs as the nearest native
 * mode below it. It has a display name different from `INSTANCE_A`'s, so a
 * row that shows "Claude Code Work" must be reading this instance's
 * `displayName` (ticket #70).
 */
const NO_AUTO: ProviderInstance = {
  ...INSTANCE_A,
  displayName: "Claude Code Work",
  declared: { ...DECLARED, accessModes: { ...DECLARED.accessModes, auto: "unsupported" } },
};

describe("Composer: the access mode menu", () => {
  it("lists four modes with no header, and shows the fallback of a mode that is not native", async () => {
    const user = userEvent.setup();
    await openApp([NO_AUTO]);

    await user.click(screen.getByRole("button", { name: /approval-required/i }));
    const menu = await screen.findByRole("dialog");

    // The rows are found by their text, not by their accessible name. The
    // name joins the mode and its meaning, so "auto" would also match
    // "auto-accept-edits".
    for (const mode of ["approval-required", "auto-accept-edits", "auto", "full-access"]) {
      expect(within(menu).getByText(mode, { exact: true })).toBeDefined();
    }
    // The four modes need no introduction, so this menu has no header.
    expect(readPageText(menu)).not.toContain("Access mode");

    // The unsupported mode keeps its row and can still be picked. The row
    // shows which mode it will actually run as.
    expect(readPageText(menu)).toContain("runs as auto-accept-edits on Claude Code Work");
    await user.click(within(menu).getByText("auto", { exact: true }));
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("button", { name: /^auto$/i })).toBeDefined();
  });

  /**
   * The fallback annotation names the provider that caused the fallback (spec
   * 14 §The composer, `runs as auto-accept-edits on pi`). It is shown in the
   * attention color below the mode's meaning, which every row keeps
   * (ticket #70).
   */
  it("shows each mode's meaning and names the provider in the fallback annotation, in the attention color", async () => {
    const user = userEvent.setup();
    await openApp([NO_AUTO]);

    await user.click(screen.getByRole("button", { name: /approval-required/i }));
    const menu = await screen.findByRole("dialog");

    const MEANINGS = [
      "asks for every side-effecting action",
      "allows file edits, asks for the rest",
      "lets a harness-side reviewer judge routine actions",
      "allows everything",
    ];
    // Four rows, each with its meaning. The row that falls back shows the
    // fallback below its meaning, not instead of it.
    for (const meaning of MEANINGS) {
      expect(readPageText(menu)).toContain(meaning);
    }

    const annotation = within(menu).getByText("runs as auto-accept-edits on Claude Code Work");
    expect(annotation.className).toContain("text-attn");
    // The annotation names the provider, not a vague "this provider".
    expect(readPageText(menu)).not.toContain("on this provider");
  });
});

/**
 * On a draft too, the screen's first row is its own header, here with no
 * actions. As in `thread.integration.test.tsx`, the breadcrumb and the title
 * are siblings in one row.
 */
describe("Draft: the header is the screen's first row", () => {
  it("shows Threads / New thread, with no … button and no shell h1", async () => {
    await openApp([INSTANCE_A]);

    const crumb = await waitFor(() => screen.getByText("Threads /"));
    expect(readPageText(crumb.parentElement)).toBe("Threads / New thread");

    expect(screen.queryByRole("button", { name: "…" })).toBeNull();
    // The prompt "What should the agent do?" is an h2, and the shell's top bar
    // is hidden, so this route has no h1.
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Tests for the project picker and the workspace, branch and machine
 * selectors (#72). They drive the app through `renderApp` and the stubbed
 * `fetch`, like the tests above.
 *
 * The spec gives the text of these controls but not how to find them.
 * These tests assume:
 * - The picker is the Radix overlay, found as `role="dialog"`, and the
 *   sidebar's "Create new thread" opens it.
 * - A menu row is a button with its text, as in the menus above.
 * - The New project dialog is found as `role="dialog"` named "New
 *   project", like the picker. Its fields are labelled "Name", "Remote
 *   URL", "GitHub account" and "Setup command". "+ Git repository" adds a
 *   source, and the "Create project" button submits it.
 * ------------------------------------------------------------------ */

const AT = "2026-09-10T09:00:00.000Z";

const COVE: Runner = { ...RUNNER, id: "01a06d02-beff-7037-9f5b-042822015953", name: "cove" };

const GITHUB_ID = "01a06d02-7500-7000-8000-000000000001";

const BUMP_THE_BUN_PIN = "01a06d02-7400-7000-8000-000000000004";

/** The ids of the shared webshop/ops test data that every workspace suite
 * uses, in the format the contract accepts. The fixtures added below (the
 * edge and sandbox projects, the worktree on cove, the main workspaces of the
 * two ops repos) belong to this suite only. */
const IDS = {
  moss: RUNNER.id,
  cove: COVE.id,
  webshopProject: "01a06d02-7000-7000-8000-000000000001",
  opsProject: "01a06d02-7000-7000-8000-000000000002",
  webshop: "01a06d02-7100-7000-8000-000000000001",
  infra: "01a06d02-7100-7000-8000-000000000002",
  runbooks: "01a06d02-7100-7000-8000-000000000003",
  primary: "01a06d02-7200-7000-8000-000000000001",
  primaryCheckout: "01a06d02-7300-7000-8000-000000000001",
  run3f1: "01a06d02-7200-7000-8000-000000000002",
  run3f1Checkout: "01a06d02-7300-7000-8000-000000000002",
  flakyThread: "01a06d02-7400-7000-8000-000000000001",
  runbookThread: "01a06d02-7400-7000-8000-000000000002",
};

const WORLD = buildThreadsWorld(IDS);

const buildProject = (id: string, name: string): Project => ({
  id,
  name,
  createdAt: AT,
  updatedAt: AT,
});

const WEBSHOP = WORLD.WEBSHOP_PROJECT;
const OPS = WORLD.OPS_PROJECT;
/** A project whose one repo has never been cloned on any machine. */
const EDGE = buildProject("01a06d02-7000-7000-8000-000000000003", "edge");
/** A project with no repo at all. */
const SANDBOX = buildProject("01a06d02-7000-7000-8000-000000000004", "sandbox");

const buildRepoResource = (
  id: string,
  owner: string,
  name: string,
  projectIds: readonly string[],
): Resource => ({
  id,
  kind: "repo",
  remote: `git@github.com:${owner}/${name}.git`,
  canonicalRemote: `github.com/${owner}/${name}`,
  label: null,
  connectionId: "01a06d02-7500-7000-8000-000000000001",
  setupCommand: null,
  workspaceInclude: true,
  projectIds,
  createdAt: AT,
  updatedAt: AT,
});

const R_WEBSHOP = WORLD.WEBSHOP;
const R_INFRA = WORLD.INFRA;
const R_RUNBOOKS = WORLD.RUNBOOKS;
const R_EDGE = buildRepoResource("01a06d02-7100-7000-8000-000000000004", "acme", "edge-api", [
  EDGE.id,
]);

const buildCheckout = (
  id: string,
  resourceId: string,
  form: "clone" | "worktree",
  branch: string,
  branches: readonly string[],
  defaultBranch: string,
) => ({ checkoutId: id, resourceId, form, subdirectory: null, branch, branches, defaultBranch });

const buildWorkspace = (
  id: string,
  kind: "primary" | "ephemeral",
  runnerId: string,
  checkouts: Workspace["checkouts"],
  sessionIds: readonly string[] = [],
): Workspace => ({
  id,
  runnerId,
  kind,
  status: "ready",
  checkouts,
  designatedConnectionId: "01a06d02-7500-7000-8000-000000000001",
  message: null,
  sessionIds,
  createdAt: AT,
  provisionedAt: AT,
  lastUsedAt: AT,
  disposedAt: null,
});

/** webshop's main workspace on moss; `hercule/run-3f1` is one of its branches. */
const W_PRIMARY_WEBSHOP: Workspace = {
  ...WORLD.PRIMARY,
  designatedConnectionId: GITHUB_ID,
  sessionIds: [BUMP_THE_BUN_PIN],
};

const W_RUN_3F1: Workspace = { ...WORLD.RUN_3F1, designatedConnectionId: GITHUB_ID };

const W_RUN_8A0 = buildWorkspace(
  "01a06d02-7200-7000-8000-000000000003",
  "ephemeral",
  COVE.id,
  [
    buildCheckout(
      "01a06d02-7300-7000-8000-000000000003",
      R_WEBSHOP.id,
      "worktree",
      "hercule/run-8a0",
      ["hercule/run-8a0"],
      "main",
    ),
  ],
  ["01a06d02-7400-7000-8000-000000000003"],
);

const W_PRIMARY_INFRA = buildWorkspace(
  "01a06d02-7200-7000-8000-000000000004",
  "primary",
  RUNNER.id,
  [
    buildCheckout(
      "01a06d02-7300-7000-8000-000000000004",
      R_INFRA.id,
      "clone",
      "master",
      ["master", "hetzner-migration"],
      "master",
    ),
  ],
);

const W_PRIMARY_RUNBOOKS = buildWorkspace(
  "01a06d02-7200-7000-8000-000000000005",
  "primary",
  RUNNER.id,
  [
    buildCheckout(
      "01a06d02-7300-7000-8000-000000000005",
      R_RUNBOOKS.id,
      "clone",
      "main",
      ["main"],
      "main",
    ),
  ],
);

const buildThread = (
  id: string,
  title: string,
  projectId: string | null,
  workspaceId: string | null,
  runnerId: string = RUNNER.id,
): Session => ({
  ...NEW_SESSION,
  id,
  title,
  status: "idle",
  projectId,
  workspaceId,
  runnerId,
  createdAt: AT,
  startedAt: AT,
  lastActivityAt: AT,
});

const SESSIONS: readonly Session[] = [
  buildThread(IDS.flakyThread, "Fix flaky webhook tests", WEBSHOP.id, W_RUN_3F1.id),
  buildThread(IDS.runbookThread, "Write the retry runbook", WEBSHOP.id, W_RUN_3F1.id),
  buildThread(
    "01a06d02-7400-7000-8000-000000000003",
    "Runner drain command",
    WEBSHOP.id,
    W_RUN_8A0.id,
    COVE.id,
  ),
  buildThread(BUMP_THE_BUN_PIN, "Bump the Bun pin", WEBSHOP.id, W_PRIMARY_WEBSHOP.id),
  buildThread(
    "01a06d02-7400-7000-8000-000000000005",
    "Tidy the promotion runbook",
    WEBSHOP.id,
    null,
  ),
  buildThread(
    "01a06d02-7400-7000-8000-000000000006",
    "Rotate the Hetzner backups key",
    OPS.id,
    null,
  ),
];

const GITHUB: Connection = {
  id: GITHUB_ID,
  type: "github/github",
  label: "personal",
  displayName: "rogierpennink",
  status: "connected",
  labels: [],
  config: {},
  credentials: [],
  createdAt: AT,
  updatedAt: AT,
};

/** A Connection of another type, which the GitHub account selects must not offer. */
const SLACK: Connection = {
  ...GITHUB,
  id: "01a06d02-7500-7000-8000-000000000002",
  type: "slack",
  label: "acme",
  displayName: "acme.slack.com",
};

const WORKSPACES: readonly Workspace[] = [
  W_PRIMARY_WEBSHOP,
  W_RUN_3F1,
  W_RUN_8A0,
  W_PRIMARY_INFRA,
  W_PRIMARY_RUNBOOKS,
];

const RESOURCES: readonly Resource[] = [R_WEBSHOP, R_INFRA, R_RUNBOOKS, R_EDGE];

const PROJECTS: readonly Project[] = [WEBSHOP, OPS, EDGE, SANDBOX];

/**
 * Builds the extra routes the project and workspace tests need, on top of the
 * ones every composer test stubs.
 */
const buildWorldRoutes = (
  overrides: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/projects": { body: { items: PROJECTS } },
  "GET /api/v1/resources": { body: { items: RESOURCES } },
  "GET /api/v1/workspaces": { body: { items: WORKSPACES } },
  "GET /api/v1/sessions": { body: { items: SESSIONS } },
  "GET /api/v1/connections": { body: { items: [GITHUB, SLACK] } },
  "GET /api/v1/runners": { body: { items: [RUNNER, COVE] } },
  ...overrides,
});

/** Opens a draft at `path`, with the project and workspace routes stubbed. */
const openDraftAt = async (
  path: string,
  user: Record<string, unknown> = {},
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(buildController([INSTANCE_A], user, buildWorldRoutes(extra)));
  const app = await renderApp({
    path,
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(RUNNER.id),
  });
  return { ...app, api };
};

const buildProjectDraftPath = (id: string) => `/threads/new?project=${id}`;

/** Opens the workspace selector and returns its menu. */
const openWorkspaceMenu = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("button", { name: /^workspace / }));
  return screen.findByRole("dialog");
};

/** Opens the branch selector and returns its menu. */
const openBranchMenu = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog");
};

describe("Picker: a thread starts from a project", () => {
  const openPicker = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
    await user.click(screen.getByText("Create new thread"));
    return screen.findByRole("dialog");
  };

  it("lists one row per project with its repos, threads and workspaces", async () => {
    const user = userEvent.setup();
    await openDraftAt("/threads/new");

    const picker = await openPicker(user);

    expect(readPageText(picker)).toContain("New thread in");
    // One repo, five threads in the project, two ephemeral workspaces.
    expect(readPageText(picker)).toContain("1 repo · webshop · 5 threads · 2 workspaces");
    // The plural form of `<n> repo(s) · <repo names>`, with the names listed.
    expect(readPageText(picker)).toContain("2 repos · ops-infra, ops-runbooks");
    expect(readPageText(picker)).toContain("⌘1");
    expect(readPageText(picker)).toContain("⌘2");
  });

  it("navigates to a draft in the project that was clicked", async () => {
    const user = userEvent.setup();
    const { router } = await openDraftAt("/threads/new");

    const picker = await openPicker(user);
    await user.click(within(picker).getByRole("button", { name: /ops/ }));

    await waitFor(() => {
      expect(router.state.location.href).toBe(buildProjectDraftPath(OPS.id));
    });
  });

  it("moves with the arrows and picks with Enter", async () => {
    const user = userEvent.setup();
    const { router } = await openDraftAt("/threads/new");

    await openPicker(user);
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => {
      expect(router.state.location.href).toBe(buildProjectDraftPath(OPS.id));
    });
  });

  it("picks the first project with its shortcut ⌘1", async () => {
    const user = userEvent.setup();
    const { router } = await openDraftAt("/threads/new");

    await openPicker(user);
    await user.keyboard("{Meta>}1{/Meta}");

    await waitFor(() => {
      expect(router.state.location.href).toBe(buildProjectDraftPath(WEBSHOP.id));
    });
  });

  it("closes on Escape without starting anything", async () => {
    const user = userEvent.setup();
    const { router } = await openDraftAt("/threads/new");

    await openPicker(user);
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(router.state.location.href).toBe("/threads/new");
  });

  it("closes on a click outside the panel, and on Esc after a click inside it", async () => {
    const user = userEvent.setup();
    const { router } = await openDraftAt("/threads/new");

    const picker = await openPicker(user);
    // The scrim is the panel's parent element and covers the page behind the picker.
    await user.click(picker.parentElement!);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // A click inside moves focus away from the panel, so the Esc key event
    // reaches the document instead of the panel. The picker must still close.
    const again = await openPicker(user);
    await user.click(within(again).getByRole("button", { name: /webshop/ }));
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(router.state.location.href).toBe(buildProjectDraftPath(WEBSHOP.id));
  });

  it("offers New project as the last row when there are projects", async () => {
    const user = userEvent.setup();
    await openDraftAt("/threads/new");

    const picker = await openPicker(user);

    const text = readPageText(picker);
    expect(text).toContain("New project");
    expect(text.indexOf("sandbox")).toBeLessThan(text.indexOf("New project"));
  });

  // The picker does not create a project itself. Its New project row opens
  // the New project dialog, which does.
  it("offers New project and nothing else when there is no project yet, and opens the dialog", async () => {
    const user = userEvent.setup();
    const created = buildProject("01a06d02-7000-7000-8000-000000000009", "first");
    const { api, router } = await openDraftAt(
      "/threads/new",
      {},
      {
        "GET /api/v1/projects": { body: { items: [] } },
        "POST /api/v1/projects": { body: created },
      },
    );

    const picker = await openPicker(user);

    expect(readPageText(picker)).toContain("New project");
    expect(within(picker).queryByRole("button", { name: /webshop/ })).toBeNull();

    await user.click(within(picker).getByRole("button", { name: "New project" }));

    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await user.type(within(dialog).getByLabelText("Name"), "first");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(router.state.location.href).toBe(buildProjectDraftPath(created.id));
    });
    expect(
      api.calls.find((call) => call.method === "POST" && call.path === "/api/v1/projects")?.body,
    ).toEqual({ name: "first" });
  });

  it("shows the draft's project in the heading", async () => {
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    expect(
      await screen.findByRole("heading", { name: "What should the agent do in webshop?" }),
    ).toBeDefined();
  });
});

describe("Composer: the workspace selector", () => {
  it("shows a header saying what the menu picks and when the pick locks", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    const menu = await openWorkspaceMenu(user);

    expect(readPageText(menu)).toContain("Workspace");
    expect(readPageText(menu)).toContain("locks when the thread starts");
  });

  // The primary workspace is shown as "Main workspace". None is not offered
  // when the project has a repo.
  it("offers the main workspace, a new worktree and the live workspaces", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    const menu = await openWorkspaceMenu(user);
    const text = readPageText(menu);

    expect(text).toContain("Main workspace");
    expect(text).toContain("on main · you and the agent share the files");
    expect(text).toContain("New workspace");
    expect(text).toContain("a fresh worktree of webshop on a new branch");
    // The project's live ephemeral workspaces, named after their branch, with
    // their machine and the threads already in them.
    expect(text).toContain("hercule/run-3f1");
    expect(text).toContain("moss");
    expect(text).toContain("2 threads · “Fix flaky webhook tests”, “Write the retry runbook”");
    expect(text).toContain("hercule/run-8a0");
    expect(text).not.toContain("None");
  });

  it("shows the repo on each row and lists New workspace first in a multi-repo project", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(OPS.id));

    const menu = await openWorkspaceMenu(user);
    const text = readPageText(menu);

    expect(text).toContain("a worktree of each repo, side by side, each on a new branch");
    expect(text).toContain("Main workspace of ops-infra");
    expect(text).toContain("Main workspace of ops-runbooks");
    expect(text.indexOf("New workspace")).toBeLessThan(text.indexOf("Main workspace of"));
  });

  it("checks the clone on the machine the draft would be placed on, not on the picked one", async () => {
    const user = userEvent.setup();
    // `INSTANCE_FRESH` is on no machine, so no runner row is selectable and
    // the draft picks no runner. The draft would still be placed on moss,
    // which holds webshop's main workspace. The menu must check moss;
    // otherwise it would say the repo is not cloned on a machine the user
    // never saw.
    const api = stubApi(buildController([INSTANCE_FRESH], {}, buildWorldRoutes()));
    await renderApp({
      path: buildProjectDraftPath(WEBSHOP.id),
      api: api.fetch,
      token: "held",
      detectLocalRunner: () => Promise.resolve(RUNNER.id),
    });

    const menu = await openWorkspaceMenu(user);
    expect(readPageText(menu)).toContain("on main · you and the agent share the files");
    expect(readPageText(menu)).not.toContain("not cloned");
  });

  it("shows that a repo is not cloned on the machine instead of hiding the row", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(EDGE.id));

    const menu = await openWorkspaceMenu(user);

    expect(readPageText(menu)).toContain("not cloned on moss · clones on first use");
  });

  // A project with no source works in None, and the tooltip explains how to
  // change that.
  it("shows None as locked text in a project with no repo", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(SANDBOX.id));

    const locked = await screen.findByTitle("Add a repository to the project to work in one");
    expect(readPageText(locked)).toContain("None");
    expect(locked.closest("button")).toBeNull();

    await user.click(locked);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("defaults to the main workspace in a one-repo project and to a worktree in a multi-repo one", async () => {
    const one = await openDraftAt(buildProjectDraftPath(WEBSHOP.id));
    expect(await screen.findByRole("button", { name: /^workspace Main workspace$/ })).toBeDefined();
    one.unmount();

    await openDraftAt(buildProjectDraftPath(OPS.id));
    expect(await screen.findByRole("button", { name: /^workspace New workspace$/ })).toBeDefined();
  });

  it("uses the stored thread.workspace setting", async () => {
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id), { "thread.workspace": "ephemeral" });
    expect(await screen.findByRole("button", { name: /^workspace New workspace$/ })).toBeDefined();
  });

  it("rewrites the lead sentence as the pick changes", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    await waitFor(() => {
      expect(readPageText()).toContain(
        "It works in the main workspace of webshop on moss, on main. You and the agent share the files.",
      );
    });

    await openWorkspaceMenu(user);
    await pickRow(user, /New workspace/);
    await waitFor(() => {
      expect(readPageText()).toContain(
        "It gets its own worktree of webshop, on a new branch from main.",
      );
    });

    await openWorkspaceMenu(user);
    await pickRow(user, /hercule\/run-3f1/);
    // When joining, the sentence names the threads already working there,
    // not the workspace.
    await waitFor(() => {
      expect(readPageText()).toContain(
        "It joins “Fix flaky webhook tests” and “Write the retry runbook” there: the agents see each other's edits, on one branch.",
      );
    });
  });

  // None is offered only when there is no other choice, and then the draft
  // uses it.
  it("explains that a draft in a project with no repo works without a checkout", async () => {
    await openDraftAt(buildProjectDraftPath(SANDBOX.id));

    await waitFor(() => {
      expect(readPageText()).toContain("It works without a checkout.");
    });
  });

  it("spawns with the draft's project and its main workspace", async () => {
    const user = userEvent.setup();
    const { api, router } = await openDraftAt(
      buildProjectDraftPath(WEBSHOP.id),
      {},
      { "POST /api/v1/sessions": { body: NEW_SESSION } },
    );

    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${NEW_SESSION.id}`);
    });
    const spawn = api.calls.find(
      (call) => call.method === "POST" && call.path === "/api/v1/sessions",
    );
    expect(spawn?.body).toEqual({
      prompt: "Fix the login bug",
      instanceId: INSTANCE_A.id,
      model: "claude-sonnet-5",
      accessMode: "approval-required",
      runnerId: RUNNER.id,
      permissionProfileId: PROFILE_UNRESTRICTED.id,
      options: {},
      projectId: WEBSHOP.id,
      workspace: { kind: "primary", resourceId: R_WEBSHOP.id },
    });
  });

  it("spawns with the workspace the user joined instead of the default", async () => {
    const user = userEvent.setup();
    const { api } = await openDraftAt(
      buildProjectDraftPath(WEBSHOP.id),
      {},
      { "POST /api/v1/sessions": { body: NEW_SESSION } },
    );

    await openWorkspaceMenu(user);
    await pickRow(user, /hercule\/run-3f1/);

    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(
        api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
      ).toBe(true);
    });
    const spawn = api.calls.find(
      (call) => call.method === "POST" && call.path === "/api/v1/sessions",
    );
    expect(spawn?.body).toMatchObject({
      projectId: WEBSHOP.id,
      workspace: { kind: "existing", workspaceId: W_RUN_3F1.id },
    });
  });

  it("spawns with one checkout per repo when a multi-repo project uses a new workspace", async () => {
    const user = userEvent.setup();
    const { api } = await openDraftAt(
      buildProjectDraftPath(OPS.id),
      {},
      { "POST /api/v1/sessions": { body: NEW_SESSION } },
    );

    await user.type(await screen.findByRole("textbox"), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(
        api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
      ).toBe(true);
    });
    const spawn = api.calls.find(
      (call) => call.method === "POST" && call.path === "/api/v1/sessions",
    );
    expect(spawn?.body).toMatchObject({
      projectId: OPS.id,
      workspace: {
        kind: "ephemeral",
        checkouts: [{ resourceId: R_INFRA.id }, { resourceId: R_RUNBOOKS.id }],
      },
    });
  });

  it("preselects the workspace named in the URL", async () => {
    await openDraftAt(`/threads/new?project=${WEBSHOP.id}&workspace=${W_RUN_3F1.id}`);

    expect(
      await screen.findByRole("button", { name: /^workspace hercule\/run-3f1$/ }),
    ).toBeDefined();
  });
});

describe("Composer: the branch selector", () => {
  it("lists the main workspace's branches, badges the current one and dims one held by another workspace", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    const menu = await openBranchMenu(user, /main/);
    const text = readPageText(menu);

    expect(text).toContain("Branch");
    expect(text).toContain("the checkout switches to it");
    expect(text).toContain("release/2.4");
    expect(text).toContain("current");
    // `hercule/run-3f1` is a branch of the primary workspace, but a ready
    // ephemeral workspace on the same machine has it checked out. The row is
    // dimmed and shows which workspace holds it.
    expect(text).toContain("in workspace hercule/run-3f1");
    expect(within(menu).queryByRole("button", { name: /hercule\/run-3f1/ })).toBeNull();
  });

  // The branch name is what the user picks, so it is never truncated. The
  // note about which workspace holds it is secondary, so the note is
  // truncated when the row runs out of room.
  it("never truncates a held branch, truncates its note instead, and keeps the note right-aligned", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    const menu = await openBranchMenu(user, /main/);

    // The note is the truncated cell, and its title holds the full text so
    // the cut-off part can still be read.
    const note = within(menu).getByTitle("in workspace hercule/run-3f1");
    expect(note.className).toContain("truncate");

    // The branch cell takes the width it needs and is never truncated.
    const branch = within(menu).getByText("hercule/run-3f1", { selector: "span.font-mono" });
    expect(branch.parentElement?.className).not.toContain("truncate");

    // The note stays at the row's right edge: its column is the wide one and
    // its content is aligned to the end, like every other row's badge.
    const cell = note.parentElement;
    expect(cell?.className).toContain("justify-end");
    expect(cell?.parentElement?.className).toContain("grid-cols-[auto_auto_minmax(0,1fr)]");
  });

  it("updates the branch selector and the lead sentence to the picked branch", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    await openBranchMenu(user, /main/);
    await pickRow(user, /release\/2\.4/);

    await waitFor(() => {
      expect(readPageText()).toContain(
        "It works in the main workspace of webshop on moss, on release/2.4. You and the agent share the files.",
      );
    });
    expect(await screen.findByRole("button", { name: /release\/2\.4/ })).toBeDefined();
  });

  it("asks for a base branch on a new workspace, badges the default and explains where the branch starts", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    await openWorkspaceMenu(user);
    await pickRow(user, /New workspace/);

    const lip = await screen.findByRole("button", { name: /^from main$/ });
    expect(lip).toBeDefined();

    await user.click(lip);
    const menu = await screen.findByRole("dialog");
    const text = readPageText(menu);

    expect(text).toContain("Base branch");
    expect(text).toContain("the new branch starts from it");
    expect(text).toContain("default");
    expect(text).toContain(
      "The new branch is hercule/run-…, named after the thread, and starts from origin/main when the remote has it.",
    );
  });

  it("shows the base branches side by side, with nothing to pick, in a multi-repo project", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(OPS.id));

    const lip = await screen.findByText("from master · main");
    expect(lip.closest("button")).toBeNull();

    // Clicking it opens nothing, because v1 has no per-repo base branch pick.
    await user.click(lip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows default, with nothing to pick, for a repo no machine has cloned", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(EDGE.id));

    const lip = await screen.findByText("default");
    expect(lip.closest("button")).toBeNull();

    await user.click(lip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is absent on a joined workspace, and on a draft with no workspace at all", async () => {
    const user = userEvent.setup();
    const joined = await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    await openWorkspaceMenu(user);
    await pickRow(user, /hercule\/run-3f1/);
    await waitFor(() => {
      expect(screen.queryByText("Branch")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: /^from / })).toBeNull();
    joined.unmount();

    // In a project with no repo, None is the only choice and has no branch.
    await openDraftAt(buildProjectDraftPath(SANDBOX.id));
    await waitFor(() => {
      expect(screen.queryByText("Branch")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: /^from / })).toBeNull();
  });
});

describe("Composer: the machine selector follows the workspace", () => {
  it("is read-only and names the workspace once the thread joins one", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    await openWorkspaceMenu(user);
    await pickRow(user, /hercule\/run-8a0/);

    const locked = await screen.findByText("set by the workspace hercule/run-8a0");
    expect(locked.closest("button")).toBeNull();
    await user.click(locked);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a machine without the repo pickable, and explains that the repo is cloned on first use", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(EDGE.id));

    await user.click(await screen.findByRole("button", { name: /^machine moss/ }));
    const menu = await screen.findByRole("dialog");

    expect(readPageText(menu)).toContain("edge-api is not cloned there · clones on first use");
    // "not cloned" only means a wait, not a blocker, so the row stays a
    // button. The test checks moss, not cove: in this fixture cove is dimmed
    // for another reason (no provider instance was ever probed there), and a
    // dimmed row is never clickable (#160).
    expect(within(menu).getByRole("button", { name: /moss/ })).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * Repo setup is no longer part of the composer. The add-repo and adopt
 * forms at the bottom of the workspace menu are gone. A project and its
 * sources are created in the New project dialog, which opens from the
 * sidebar or from the picker's New project row.
 * ------------------------------------------------------------------ */

describe("The New project dialog", () => {
  const NEW_PROJECT = buildProject("01a06d02-7000-7000-8000-000000000009", "checkout");

  const NEW_REPO = buildRepoResource("01a06d02-7100-7000-8000-000000000009", "acme", "checkout", [
    NEW_PROJECT.id,
  ]);

  /** Opens the dialog from the sidebar's icon next to Create new thread, and returns it. */
  const openDialog = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
    await user.click(await screen.findByRole("button", { name: "New project" }));
    return screen.findByRole("dialog", { name: "New project" });
  };

  it("creates the project, then one resource per source, and opens a draft in the project", async () => {
    const user = userEvent.setup();
    const { api, router } = await openDraftAt(
      "/threads/new",
      {},
      {
        "POST /api/v1/projects": { body: NEW_PROJECT },
        "POST /api/v1/resources": { body: NEW_REPO },
      },
    );

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Name"), "checkout");
    await user.click(within(dialog).getByRole("button", { name: "+ Git repository" }));

    await user.type(
      await within(dialog).findByLabelText("Remote URL"),
      "git@github.com:acme/checkout.git",
    );
    await user.selectOptions(within(dialog).getByLabelText("GitHub account"), GITHUB.id);
    await user.type(within(dialog).getByLabelText("Setup command"), "pnpm install");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(router.state.location.href).toBe(buildProjectDraftPath(NEW_PROJECT.id));
    });
    expect(
      api.calls.find((call) => call.method === "POST" && call.path === "/api/v1/projects")?.body,
    ).toEqual({ name: "checkout" });
    expect(
      api.calls.find((call) => call.method === "POST" && call.path === "/api/v1/resources")?.body,
    ).toEqual({
      kind: "repo",
      remote: "git@github.com:acme/checkout.git",
      connectionId: GITHUB.id,
      setupCommand: "pnpm install",
      projectIds: [NEW_PROJECT.id],
    });
  });

  it("offers only GitHub connections, and explains what an account is for", async () => {
    const user = userEvent.setup();
    await openDraftAt("/threads/new");

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "+ Git repository" }));

    const select = await within(dialog).findByLabelText<HTMLSelectElement>("GitHub account");
    const offered = [...select.options].map((option) => option.textContent);
    expect(offered).toContain(GITHUB.label);
    expect(offered).not.toContain(SLACK.label);
    expect(readPageText(dialog)).toContain("A private repo needs one.");
  });

  it("rejects a remote that git would not accept, before anything is sent", async () => {
    const user = userEvent.setup();
    const { api } = await openDraftAt(
      "/threads/new",
      {},
      { "POST /api/v1/projects": { body: NEW_PROJECT } },
    );

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Name"), "checkout");
    await user.click(within(dialog).getByRole("button", { name: "+ Git repository" }));
    await user.type(await within(dialog).findByLabelText("Remote URL"), "/Users/rogier/code/x");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Write an https:// URL or git@host:owner/repo",
    );
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          (call.path === "/api/v1/projects" || call.path === "/api/v1/resources"),
      ),
    ).toBe(false);
  });

  it("shows the API's error next to the source it is about", async () => {
    const user = userEvent.setup();
    const { router } = await openDraftAt(
      "/threads/new",
      {},
      {
        "POST /api/v1/projects": { body: NEW_PROJECT },
        "POST /api/v1/resources": {
          status: 409,
          body: buildErrorBody("conflict", "that repo is already a resource"),
        },
      },
    );

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Name"), "checkout");
    await user.click(within(dialog).getByRole("button", { name: "+ Git repository" }));
    await user.type(
      await within(dialog).findByLabelText("Remote URL"),
      "git@github.com:acme/webshop.git",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "that repo is already a resource",
    );
    // The dialog stays open, and the app does not navigate away.
    expect(router.state.location.href).toBe("/threads/new");
  });

  // The project is created before its sources. If a source then fails, the
  // project already exists, so closing the dialog opens a draft in it. The
  // failed source is simply not created.
  it("opens a draft in the created project when the dialog is closed after a source fails", async () => {
    const user = userEvent.setup();
    const { router } = await openDraftAt(
      "/threads/new",
      {},
      {
        "POST /api/v1/projects": { body: NEW_PROJECT },
        "POST /api/v1/resources": {
          status: 409,
          body: buildErrorBody("conflict", "that repo is already a resource"),
        },
      },
    );

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Name"), "checkout");
    await user.click(within(dialog).getByRole("button", { name: "+ Git repository" }));
    await user.type(
      await within(dialog).findByLabelText("Remote URL"),
      "git@github.com:acme/webshop.git",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await within(dialog).findByRole("alert");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(router.state.location.href).toBe(buildProjectDraftPath(NEW_PROJECT.id));
    });
    expect(screen.queryByRole("dialog", { name: "New project" })).toBeNull();
  });

  it("requires a project name before anything is sent", async () => {
    const user = userEvent.setup();
    const { api } = await openDraftAt("/threads/new");

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("Name the project");
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          (call.path === "/api/v1/projects" || call.path === "/api/v1/resources"),
      ),
    ).toBe(false);
  });

  // Like the picker, the dialog is a labelled modal that takes focus.
  it("is a modal dialog with an accessible name, with the focus inside it", async () => {
    const user = userEvent.setup();
    await openDraftAt("/threads/new");

    const dialog = await openDialog(user);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Cancel and on Esc", async () => {
    const user = userEvent.setup();
    await openDraftAt("/threads/new");

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New project" })).toBeNull();
    });

    await openDialog(user);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New project" })).toBeNull();
    });
  });

  it("leaves no add-repo or adopt form in the workspace menu", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    const menu = await openWorkspaceMenu(user);
    const text = readPageText(menu);
    expect(text).not.toContain("Add a repo");
    expect(text).not.toContain("Adopt a folder");
  });
});
