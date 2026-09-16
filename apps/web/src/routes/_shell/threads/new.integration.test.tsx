/**
 * The composer on a draft thread over a stubbed controller, plus the routing
 * check that `/threads/new` is a static route rather than `$sessionId` reading
 * "new" as a session id.
 *
 * Driven only through `renderApp` and the stubbed `fetch` - never by reaching
 * into the screen's own modules.
 *
 * Decisions made where the SPEC does not pin an exact rendering detail:
 * - The `+` and voice buttons expose their disabled reason via a `title`
 *   attribute (`screen.getByTitle(...)`), there being no established
 *   lone-icon-button convention in this codebase to follow (`ListRow`'s
 *   "dimmed, second line" rule is for menu rows).
 * - The send control's accessible name contains "send".
 * - The model pill's effort segment is the chosen choice's `label` (e.g.
 *   "Medium"), not its `value` ("medium") - spec 14's own example
 *   ("claude-sonnet-5 · medium") is illustrative prose, not one of this
 *   SPEC's locked ACs, and "effort label" in AC-15's own wording points at
 *   the descriptor's `label` field.
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
} from "@hydra/contract";
import { threadsWorld } from "@hydra/client-core/threads/testing";
import { envelope, pickRow, reading, renderApp, stubApi, type Handler } from "../../../app/testing";

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

const snapshot = (
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

const instance = (
  id: string,
  name: string,
  displayName: string,
  snapshots: ProviderInstance["snapshots"],
): ProviderInstance => ({
  id,
  providerId: "claude-code",
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
const INSTANCE_A = instance("01a06d02-1000-7000-8000-000000000001", "personal", "Claude Code", [
  snapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      isDefault: true,
      options: [EFFORT, THINKING],
    },
    { slug: "claude-opus-5", name: "Claude Opus 5", options: [] },
  ]),
]);

/** A second account of the same provider, one model, no options. */
const INSTANCE_B = instance("01a06d02-1000-7000-8000-000000000002", "work", "Claude Code", [
  snapshot(RUNNER.id, "work@example.com", "Claude Pro", [
    { slug: "claude-haiku-5", name: "Claude Haiku 5", isDefault: true, options: [] },
  ]),
]);

/**
 * The real first-run state: the instance exists (spec 06 §2, one per shipped
 * provider) but nothing has logged in on the one runner yet, so there is no
 * snapshot at all - `runnerMenu`'s only row dims "not logged in" and its
 * `defaultRunnerId` is null.
 */
const INSTANCE_FRESH = instance(
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
};

const controller = (
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
  // Where AC-18's navigation lands: a stub for whichever id a test's spawn
  // answers with, so the destination route's own loader does not 404 the
  // navigation this test is really about.
  [`GET /api/v1/sessions/${NEW_SESSION.id}`]: { body: NEW_SESSION },
  [`GET /api/v1/sessions/${NEW_SESSION.id}/transcript`]: { body: { items: [] } },
  ...extra,
});

const open = async (
  instances: readonly ProviderInstance[] = [INSTANCE_A, INSTANCE_B],
  user: Record<string, unknown> = {},
  extra: Readonly<Record<string, Handler>> = {},
  storage: Readonly<Record<string, string>> = {},
) => {
  const api = stubApi(controller(instances, user, extra));
  const app = await renderApp({
    path: "/threads/new",
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(RUNNER.id),
    storage,
  });
  return { ...app, api };
};

describe("Composer: draft defaults (AC-15)", () => {
  it("prefills from the spawn defaults when no thread.* setting is stored", async () => {
    await open([INSTANCE_A]);

    expect(screen.getByRole("heading", { name: "What should the agent do?" })).toBeDefined();

    expect(screen.getByRole("textbox")).toBeDefined();

    const attach = screen.getByTitle<HTMLButtonElement>("attachments are not built");
    expect(attach.disabled).toBe(true);

    const voice = screen.getByTitle<HTMLButtonElement>("dictation is not built");
    expect(voice.disabled).toBe(true);

    // The model pill names the default model; its options sit in the selector
    // beside it, labelled with the effort choice "Medium" lower-cased.
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
    await open([INSTANCE_A, INSTANCE_B], {
      "thread.instanceId": INSTANCE_B.id,
      "thread.model": "claude-haiku-5",
      "thread.accessMode": "auto",
      "thread.profileId": PROFILE_WORKER.id,
    });

    // Two accounts of one provider, so the pill names which; claude-haiku-5
    // carries no options, so no options selector renders beside it.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "work Claude Haiku 5" })).toBeDefined();
    });
    expect(screen.getByRole("button", { name: /^auto$/i })).toBeDefined();
  });
});

describe("Composer: a fresh install, nothing logged in on the one runner yet", () => {
  it("shows the pill with only the parts it has, never a dangling separator, when there is no model to offer", async () => {
    await open([INSTANCE_FRESH]);

    // No model to name, and no dangling separator left over from one.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "No model" })).toBeDefined();
    });
  });

  it("names the runner in its own trigger, dimmed with its reason, instead of the bare word Runner", async () => {
    await open([INSTANCE_FRESH]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: `machine ${RUNNER.name} · not logged in` }),
      ).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: "Runner" })).toBeNull();
  });

  it("says why the draft cannot start, with no Log in to offer on a machine the instance was never found on", async () => {
    await open([INSTANCE_FRESH]);

    // Nothing has ever probed this instance on the one runner, so there is no
    // login to offer there - only the reason.
    await waitFor(() => {
      expect(reading()).toContain(`Can't start yet. Claude Code is not on ${RUNNER.name}.`);
    });
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  it("keeps send disabled with the reason, rather than spawning a payload of empty ids", async () => {
    // Nothing is logged in, so `runnerMenu` offers no selectable row and the
    // draft runner, model and profile stay null. Sending would post ids the
    // contract's own `Id` refuses, naming fields the user never touched.
    const user = userEvent.setup();
    const { api } = await open([INSTANCE_FRESH]);

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    const send = await screen.findByRole<HTMLButtonElement>("button", { name: /send/i });
    await waitFor(() => {
      expect(send.disabled).toBe(true);
    });
    expect(reading()).toContain(`Claude Code is not on ${RUNNER.name}`);
    expect(
      api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
    ).toBe(false);
  });

  it("keeps send disabled with the reason when no provider instance exists at all", async () => {
    const user = userEvent.setup();
    await open([]);

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    const send = screen.getByRole<HTMLButtonElement>("button", { name: /send/i });
    await waitFor(() => {
      expect(send.disabled).toBe(true);
    });
    expect(reading()).toContain("no provider instance is set up");
  });
});

describe("Composer: selector popovers (AC-16)", () => {
  it("opens one popover at a time, closes on Esc and on an outside click, and keeps typed text", async () => {
    const user = userEvent.setup();
    await open();

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    await user.click(screen.getByRole("button", { name: /no workspace/i }));
    expect(await screen.findByText("Adopt a folder on this machine…")).toBeDefined();

    // A second selector opened closes the first. The new one's own content
    // mounts through Radix's `Presence`, one microtask behind the click, so
    // this is awaited rather than asserted synchronously.
    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    await waitFor(() => {
      expect(screen.queryByText("Adopt a folder on this machine…")).toBeNull();
    });
    expect(await screen.findByRole("button", { name: /claude opus 5/i })).toBeDefined();

    // Esc closes the open one.
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /claude opus 5/i })).toBeNull();
    });

    // An outside click closes it too.
    await user.click(screen.getByRole("button", { name: /no workspace/i }));
    expect(await screen.findByText("Adopt a folder on this machine…")).toBeDefined();
    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByText("Adopt a folder on this machine…")).toBeNull();
    });

    // Text typed before any of this survives.
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Fix the login bug");
  });

  it("holds No workspace selected and the other two entries dimmed with their reason", async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole("button", { name: /no workspace/i }));

    const rows = screen.getAllByRole("button", { name: /no workspace/i });
    // The trigger, plus the row inside the now-open menu.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.at(-1)?.getAttribute("aria-current")).toBe("true");

    expect(await screen.findByText("Adopt a folder on this machine…")).toBeDefined();
    expect(screen.getByText("Add a repo →")).toBeDefined();
    // Amended by #72 (D-17): both entries are built now, and both need a
    // project to act on, so a draft standing in none says what would unlock
    // them rather than the pre-#72 "not built yet".
    expect(reading().match(/pick a project first/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("opens the runner menu with the state and the capacity beside the machine, and what it is under it", async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole("button", { name: "machine moss" }));

    // The state word sits in its own colored span, so the row's own text
    // spans several elements - read the dialog's whole text rather than
    // asking for one element whose own text is the exact string.
    const dialog = reading(await screen.findByRole("dialog"));
    // The machine, then its state and how much of it is taken; what this
    // machine is stands under it. Who is logged in is the model menu's to say.
    expect(dialog).toContain("moss online 0/4");
    expect(dialog).toContain("this machine · default");
    expect(dialog).toContain("The thread runs where you say; nothing moves it later.");
  });
});

describe("Composer: model menu (AC-17)", () => {
  it("groups models per AC-8's rules and offers no free-text entry", async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    const menu = await screen.findByRole("dialog");

    // The other account's own row: who it is and what plan, off its snapshot.
    expect(reading()).toContain("work@example.com");
    expect(reading()).toContain("Claude Pro");

    // The current instance (A) expanded: both its models listed.
    expect(within(menu).getByRole("button", { name: /claude sonnet 5/i })).toBeDefined();
    expect(within(menu).getByRole("button", { name: /claude opus 5/i })).toBeDefined();

    // The other instance (B) collapsed to one row: "<n> models".
    expect(reading()).toContain("1 models");

    expect(screen.queryByText(/custom model/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/model/i)).toBeNull();
  });

  it("renders a select option as a segmented row and a boolean option as an off · on row", async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole("button", { name: "medium" }));

    // `SegmentedControl` is built on Radix's `ToggleGroup` with `type="single"`,
    // which renders each item `role="radio"` (see
    // `packages/ui/src/primitives/primitives.test.tsx`'s own SegmentedControl
    // suite) - a single-choice group is genuinely more accessible than a set of
    // plain buttons faking one, and the composer reuses the exact primitive
    // Settings > Threads already uses for its own access-mode segmented row
    // (AD-2: no new UI dependency, reuse what is already there).
    for (const choice of ["Low", "Medium", "High"]) {
      expect(screen.getByRole("radio", { name: choice })).toBeDefined();
    }
    // A boolean descriptor is the same segmented row with two faces.
    expect(screen.getByRole("radio", { name: "on" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "off" })).toBeDefined();
  });

  it("switches the pill's instance when a model of another instance is chosen", async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    // Instance B is collapsed to its one-row summary; clicking it is what
    // spec 14 §The composer calls "click to switch".
    await user.click(screen.getByRole("button", { name: /work.*1 models/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "work Claude Haiku 5" })).toBeDefined();
    });
  });

  it("changes the options selector's own label when an option is chosen", async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole("button", { name: "medium" }));
    // See the AC-17 "renders a select option..." test above: `SegmentedControl`
    // renders each choice `role="radio"`, not `role="button"`.
    await user.click(screen.getByRole("radio", { name: "High" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "high" })).toBeDefined();
    });
  });
});

describe("Composer: sending (AC-18)", () => {
  it("spawns with exactly the selectors' values, navigates to the new thread, and never patches settings", async () => {
    const user = userEvent.setup();
    const { api, router } = await open(
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
      // A spawn carries the option picks unconditionally, so a thread started
      // with none reads as an empty record rather than an absent field.
      options: {},
    });

    expect(
      api.calls.some((call) => call.method === "PATCH" && call.path === "/api/v1/settings"),
    ).toBe(false);
  });

  it("spawns with the model options picked in the pill (AC-5)", async () => {
    const user = userEvent.setup();
    const { api, router } = await open(
      [INSTANCE_A],
      {},
      {
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    );

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    // The picks are made in the model options popover: the `effort` row and
    // the `thinking` row, which defaults on and is turned off here.
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

  it("sends on Enter, inserts a newline on Shift+Enter, and never sends an IME's own Enter", async () => {
    const user = userEvent.setup();
    const { api, router } = await open(
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

    // The Enter that commits an IME composition is not a send either: it
    // would cut a Japanese or Chinese sentence off mid-word. Typing one more
    // character afterwards is what flushes the request this would have sent,
    // so the assertion below is not just running ahead of it.
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
    await open([INSTANCE_A]);

    const send = screen.getByRole<HTMLButtonElement>("button", { name: /send/i });
    expect(send.disabled).toBe(true);
  });

  it("shows the API's refusal message under the card and keeps the typed text", async () => {
    const user = userEvent.setup();
    const { api } = await open(
      [INSTANCE_A],
      {},
      {
        "POST /api/v1/sessions": {
          status: 409,
          body: envelope("invalid_state", "moss is not logged in to Claude Code"),
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

describe("Routing: /threads/new is the static route (AD-6)", () => {
  it("renders the composer rather than reading 'new' as a session id", async () => {
    const { api } = await open([INSTANCE_A]);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "What should the agent do?" })).toBeDefined();
    });
    expect(api.calls.some((call) => call.path === "/api/v1/sessions/new")).toBe(false);
  });
});

/**
 * The rebuilt composer on a draft thread, driven through `renderApp` at
 * `/threads/new` with `stubApi`, like everything above.
 *
 * How the surface is read here:
 * - the model pill is the button whose accessible name holds the model's
 *   *display* name ("Claude Sonnet 5");
 * - the model options selector is the button whose accessible name is its
 *   label text ("medium", "high", "high ⚡");
 * - a boolean descriptor is a segmented `off · on` row, like every other
 *   descriptor;
 * - the older-models fold and every menu row are buttons carrying their text;
 * - a menu is the Radix popover, read as `role="dialog"`, so a query for a row
 *   is scoped to it rather than to a page that also holds the trigger.
 */

/** A snapshot of an instance that is on the machine with nobody logged in. */
const unauthenticated = (runnerId: string): ProviderInstance["snapshots"][number] => ({
  runnerId,
  probedAt: "2026-09-05T09:10:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "unauthenticated" },
  models: [],
});

const LOGGED_OUT = instance("01a06d02-1000-7000-8000-000000000004", "Claude Code", "Claude Code", [
  unauthenticated(RUNNER.id),
]);

/** The same instance once the login this test drives has landed. */
const LOGGED_IN: ProviderInstance = {
  ...LOGGED_OUT,
  snapshots: [
    snapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
      { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isDefault: true, options: [] },
    ]),
  ],
};

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize?code=1";

describe("Composer: after login the draft re-resolves", () => {
  it("blocks the draft with the login sentence, then picks up the fresh catalog and spawns on it", async () => {
    const user = userEvent.setup();
    let held: readonly ProviderInstance[] = [LOGGED_OUT];
    const { api } = await open(
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

    // Nothing is logged in: no model to name, and the blocker says who is
    // where and what is missing.
    await waitFor(() => {
      expect(reading()).toContain("Can't start yet. Claude Code is on moss but not logged in.");
    });
    expect(screen.queryByRole("button", { name: /claude sonnet 5/i })).toBeNull();
    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /send/i }).disabled).toBe(true);

    // The login is offered where the blocker is, and runs on the draft's runner.
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => {
      expect(reading()).toContain(AUTHORIZE_URL);
    });
    expect(api.calls.find((call) => call.path.endsWith("/login"))?.body).toEqual({
      runnerId: RUNNER.id,
    });

    await user.type(screen.getByLabelText("Code", { exact: true }), "the-whole-code");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    // The draft never snapshotted its defaults, so the fresh catalog fills
    // what the user did not pick: the model appears and the blocker goes.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /claude sonnet 5/i })).toBeDefined();
    });
    expect(reading()).not.toContain("Can't start yet.");
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

/** Nine models across two accounts: one over the filter threshold. */
const model = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name,
  options: [],
  ...extra,
});

const MANY_A = instance("01a06d02-1000-7000-8000-000000000011", "personal", "Claude Code", [
  snapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
    model("claude-sonnet-5", "Claude Sonnet 5", { isDefault: true }),
    model("claude-opus-5", "Claude Opus 5"),
    model("claude-haiku-5", "Claude Haiku 5"),
    model("claude-sonnet-4", "Claude Sonnet 4"),
    model("claude-haiku-4", "Claude Haiku 4"),
  ]),
]);

const MANY_B = instance("01a06d02-1000-7000-8000-000000000012", "work", "Claude Code", [
  snapshot(RUNNER.id, "work@example.com", "Claude Pro", [
    model("claude-opus-4", "Claude Opus 4", { isDefault: true }),
    model("claude-sonnet-3", "Claude Sonnet 3"),
    model("claude-haiku-3", "Claude Haiku 3"),
    model("claude-sonnet-2", "Claude Sonnet 2"),
  ]),
]);

/** The same pair one model short of the threshold. */
const EIGHT_B: ProviderInstance = {
  ...MANY_B,
  snapshots: [
    snapshot(RUNNER.id, "work@example.com", "Claude Pro", [
      model("claude-opus-4", "Claude Opus 4", { isDefault: true }),
      model("claude-sonnet-3", "Claude Sonnet 3"),
      model("claude-haiku-3", "Claude Haiku 3"),
    ]),
  ],
};

/** One legacy model, which the lane folds away. */
const WITH_LEGACY = instance("01a06d02-1000-7000-8000-000000000013", "personal", "Claude Code", [
  snapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
    model("claude-sonnet-5", "Claude Sonnet 5", { isDefault: true }),
    model("claude-opus-5", "Claude Opus 5"),
    model("claude-sonnet-4", "Claude Sonnet 4", { isLegacy: true }),
  ]),
]);

/** A second provider with one account, so its rows never name an account. */
const CODEX: ProviderInstance = {
  ...instance("01a06d02-1000-7000-8000-000000000014", "openai", "Codex", [
    snapshot(RUNNER.id, "rogier@openai.test", "Plus", [
      model("gpt-5-codex", "GPT-5 Codex", { isDefault: true }),
    ]),
  ]),
  providerId: "codex",
  binaryName: "codex",
};

/** Another provider's account, which nobody has logged in to on this machine. */
const OTHER_LOGGED_OUT: ProviderInstance = {
  ...instance("01a06d02-1000-7000-8000-000000000015", "openai", "Codex", [
    unauthenticated(RUNNER.id),
  ]),
  providerId: "codex",
  binaryName: "codex",
};

const RECENT_KEY = "hydra.recentModels";

/** What `localStorage` holds for a draft whose Recent lane is already written. */
const recent = (
  pairs: ReadonlyArray<{ instanceId: string; model: string }>,
): Record<string, string> => ({ [RECENT_KEY]: JSON.stringify(pairs) });

/** Opens the model menu by its pill and hands back the popover. */
const openModelMenu = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog");
};

describe("Composer: model menu shapes", () => {
  it("(a) offers a focused filter past eight models and narrows every account to what matches", async () => {
    const user = userEvent.setup();
    await open([MANY_A, MANY_B]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    const filter = within(menu).getByPlaceholderText("Filter models…");
    expect(document.activeElement).toBe(filter);

    await user.type(filter, "opus");

    // The current account keeps only its match, and the other account is
    // expanded to its own.
    await waitFor(() => {
      expect(within(menu).queryByRole("button", { name: /claude sonnet 5/i })).toBeNull();
    });
    expect(within(menu).getByRole("button", { name: /claude opus 5/i })).toBeDefined();
    expect(within(menu).getByRole("button", { name: /claude opus 4/i })).toBeDefined();
    expect(within(menu).queryByRole("button", { name: /claude haiku/i })).toBeNull();
  });

  it("(a) offers no filter at eight models", async () => {
    const user = userEvent.setup();
    await open([MANY_A, EIGHT_B]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(within(menu).queryByPlaceholderText("Filter models…")).toBeNull();
  });

  it("(b) lists the recent pairs newest first, naming the account only where there are two", async () => {
    const user = userEvent.setup();
    await open(
      [INSTANCE_A, INSTANCE_B, CODEX],
      {},
      {},
      recent([
        { instanceId: CODEX.id, model: "gpt-5-codex" },
        { instanceId: INSTANCE_A.id, model: "claude-opus-5" },
      ]),
    );

    const menu = await openModelMenu(user, /claude sonnet 5/i);
    const lane = reading(menu);

    expect(lane).toContain("Recent");
    // Newest first, both above the current account's own lane.
    expect(lane.indexOf("Recent")).toBeLessThan(lane.indexOf("GPT-5 Codex"));
    expect(lane.indexOf("GPT-5 Codex")).toBeLessThan(lane.indexOf("Claude Opus 5"));

    // Claude Code holds two accounts here, so its recent row names one; the
    // single-account provider's row names none.
    const recentOpus = within(menu).getAllByRole("button", { name: /claude opus 5/i })[0];
    expect(reading(recentOpus ?? null)).toContain("personal");
    expect(reading(within(menu).getByRole("button", { name: /gpt-5 codex/i }))).not.toContain(
      "openai",
    );
  });

  it("(c) folds a legacy model away behind older models (1) until it is opened", async () => {
    const user = userEvent.setup();
    await open([WITH_LEGACY]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(within(menu).queryByRole("button", { name: /claude sonnet 4/i })).toBeNull();
    expect(reading(menu)).toContain("older models (1)");

    await user.click(within(menu).getByRole("button", { name: /older models \(1\)/i }));

    expect(await within(menu).findByRole("button", { name: /claude sonnet 4/i })).toBeDefined();
  });

  it("(d) dims an unauthenticated account to one row that logs in from where it stands", async () => {
    const user = userEvent.setup();
    const { api } = await open(
      [INSTANCE_A, OTHER_LOGGED_OUT],
      {},
      {
        [`POST /api/v1/providers/${OTHER_LOGGED_OUT.id}/login`]: { body: { url: AUTHORIZE_URL } },
      },
    );

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(reading(menu)).toContain("not logged in");
    // The account is one row, not a lane of models: it offers nothing of its
    // own to pick.
    expect(within(menu).queryByRole("button", { name: /claude haiku 5/i })).toBeNull();

    await user.click(within(menu).getByRole("button", { name: "Log in" }));

    await waitFor(() => {
      expect(reading()).toContain(AUTHORIZE_URL);
    });
    // The row logs in to the account it stands for, not to the one in force,
    // and on the machine the credential will land on.
    expect(screen.getByText("Log in to Codex on moss")).toBeDefined();
    expect(api.calls.find((call) => call.path.endsWith("/login"))?.body).toEqual({
      runnerId: RUNNER.id,
    });
  });

  it("(e) labels the current lane with the account name when the provider holds two", async () => {
    const user = userEvent.setup();
    await open([INSTANCE_A, INSTANCE_B]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(reading(menu)).toContain("personal");
  });

  it("(e) labels the current lane with the provider's name when it holds one", async () => {
    const user = userEvent.setup();
    await open([INSTANCE_A]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(reading(menu)).toContain("Claude Code");
    expect(reading(menu)).not.toContain("personal");
  });
});

describe("Composer: Recent follows the submission home", () => {
  const pickOpusAndSend = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    await user.click(await screen.findByRole("button", { name: /claude sonnet 5/i }));
    await pickRow(user, /claude opus 5/i);
    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: /send/i }));
  };

  it("writes the pair the user picked once the spawn has landed", async () => {
    const user = userEvent.setup();
    await open([INSTANCE_A], {}, { "POST /api/v1/sessions": { body: NEW_SESSION } }, recent([]));

    await pickOpusAndSend(user);

    await waitFor(() => {
      expect(localStorage.getItem(RECENT_KEY)).toBe(
        JSON.stringify([{ instanceId: INSTANCE_A.id, model: "claude-opus-5" }]),
      );
    });
  });

  it("writes nothing when the spawn is refused, since nothing was reached", async () => {
    const user = userEvent.setup();
    const { api } = await open(
      [INSTANCE_A],
      {},
      {
        "POST /api/v1/sessions": {
          status: 409,
          body: envelope("invalid_state", "moss is not logged in to Claude Code"),
        },
      },
      recent([]),
    );

    await pickOpusAndSend(user);

    await waitFor(() => {
      expect(
        api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
      ).toBe(true);
    });
    // Untouched: still the empty list it was seeded with.
    expect(localStorage.getItem(RECENT_KEY)).toBe("[]");
  });
});

const FAST_MODE: ModelOption = {
  id: "fastMode",
  label: "Fast mode",
  kind: "boolean",
  default: false,
};

/** One model, carrying a select descriptor and a boolean one. */
const WITH_OPTIONS = instance("01a06d02-1000-7000-8000-000000000016", "personal", "Claude Code", [
  snapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      isDefault: true,
      options: [EFFORT, FAST_MODE],
    },
  ]),
]);

describe("Composer: the model options selector's label", () => {
  it("reads the effort choice lower-cased, follows a pick, and appends the bolt with fast mode on", async () => {
    const user = userEvent.setup();
    await open([WITH_OPTIONS]);

    // `medium` is the descriptor's own default, lower-cased off its label.
    const selector = await screen.findByRole("button", { name: "medium" });

    await user.click(selector);
    const menu = await screen.findByRole("dialog");
    // The header names what is being changed, and what it is being changed on.
    expect(reading(menu)).toContain("Model options");
    expect(reading(menu)).toContain("Claude Sonnet 5");

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
 * `auto` is not native here, so it runs as the nearest native mode below it.
 * Its display name is its own rather than `INSTANCE_A`'s, so a row naming the
 * provider can only be reading this instance's `displayName` (ticket #70).
 */
const NO_AUTO: ProviderInstance = {
  ...INSTANCE_A,
  displayName: "Claude Code Work",
  declared: { ...DECLARED, accessModes: { ...DECLARED.accessModes, auto: "unsupported" } },
};

describe("Composer: the access mode menu", () => {
  it("lists four modes with no header and names the fallback of one that is not native", async () => {
    const user = userEvent.setup();
    await open([NO_AUTO]);

    await user.click(screen.getByRole("button", { name: /approval-required/i }));
    const menu = await screen.findByRole("dialog");

    // Read by the text on the row rather than by the row's accessible name:
    // a name concatenates the mode with its meaning, and "auto" would then
    // also match "auto-accept-edits".
    for (const mode of ["approval-required", "auto-accept-edits", "auto", "full-access"]) {
      expect(within(menu).getByText(mode, { exact: true })).toBeDefined();
    }
    // The four modes stand on their own: this menu is the one with no header.
    expect(reading(menu)).not.toContain("Access mode");

    // The unsupported mode keeps its row and stays pickable, saying what it
    // will really run as.
    expect(reading(menu)).toContain("runs as auto-accept-edits on Claude Code Work");
    await user.click(within(menu).getByText("auto", { exact: true }));
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("button", { name: /^auto$/i })).toBeDefined();
  });

  /**
   * The fallback annotation names the provider that decided it (spec 14 §The
   * composer, `runs as auto-accept-edits on pi`) and stands in the attention
   * hue under the mode's own meaning, which every row keeps (ticket #70).
   */
  it("shows each mode's meaning and names the provider in the fallback annotation, in the attention hue", async () => {
    const user = userEvent.setup();
    await open([NO_AUTO]);

    await user.click(screen.getByRole("button", { name: /approval-required/i }));
    const menu = await screen.findByRole("dialog");

    const MEANINGS = [
      "asks for every side-effecting action",
      "allows file edits, asks for the rest",
      "lets a harness-side reviewer judge routine actions",
      "allows everything",
    ];
    // Four rows, each carrying its own meaning; the one that falls back says
    // so under its meaning rather than in place of it.
    for (const meaning of MEANINGS) {
      expect(reading(menu)).toContain(meaning);
    }

    const annotation = within(menu).getByText("runs as auto-accept-edits on Claude Code Work");
    expect(annotation.className).toContain("text-attn");
    // The provider is named, not alluded to.
    expect(reading(menu)).not.toContain("on this provider");
  });
});

/**
 * The chrome is the screen's own first row on a draft too, with no actions on
 * it. The same readings hold as in `thread.integration.test.tsx`: the crumb
 * and the title are siblings in one row.
 */
describe("Draft: the chrome is the screen's first row", () => {
  it("reads Threads / New thread, with no … button and no shell h1", async () => {
    await open([INSTANCE_A]);

    const crumb = await waitFor(() => screen.getByText("Threads /"));
    expect(reading(crumb.parentElement)).toBe("Threads / New thread");

    expect(screen.queryByRole("button", { name: "…" })).toBeNull();
    // The hero "What should the agent do?" is an h2, so level 1 belongs to
    // nobody on this route once the shell's top bar steps aside.
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Slice 3 of #72: the project picker, the workspace, branch and
 * machine selectors, and the workspace menu's foot (AC-16 to AC-19,
 * AC-23). Driven through `renderApp` and the stubbed `fetch`, like
 * everything above.
 *
 * Readings picked here, where the SPEC names copy but not a handle:
 * - the picker is the Radix overlay, read as `role="dialog"`, opened by the
 *   sidebar's "Create new thread";
 * - a menu row is a button carrying its text, as in the menus above;
 * - the add-repo and adopt forms label their fields "Remote URL", "GitHub
 *   Connection", "Setup command", "Repo" and "Path", and submit through
 *   buttons named "Add repo" and "Adopt".
 * ------------------------------------------------------------------ */

const AT = "2026-09-10T09:00:00.000Z";

const COVE: Runner = { ...RUNNER, id: "01a06d02-beff-7037-9f5b-042822015953", name: "cove" };

const GITHUB_ID = "01a06d02-7500-7000-8000-000000000001";

const BUMP_THE_BUN_PIN = "01a06d02-7400-7000-8000-000000000004";

/** The webshop/ops world every workspace suite shares, with ids the contract
 * takes. What stands beside it below - the edge and sandbox projects, the
 * worktree on cove, the shared checkouts of the two ops repos - is this
 * suite's own. */
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

const WORLD = threadsWorld(IDS);

const project = (id: string, name: string): Project => ({
  id,
  name,
  createdAt: AT,
  updatedAt: AT,
});

const WEBSHOP = WORLD.WEBSHOP_PROJECT;
const OPS = WORLD.OPS_PROJECT;
/** A project whose one repo has never been cloned on any machine. */
const EDGE = project("01a06d02-7000-7000-8000-000000000003", "edge");
/** A project with no repo at all. */
const SANDBOX = project("01a06d02-7000-7000-8000-000000000004", "sandbox");

const repo = (
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
const R_EDGE = repo("01a06d02-7100-7000-8000-000000000004", "acme", "edge-api", [EDGE.id]);

const checkout = (
  id: string,
  resourceId: string,
  form: "clone" | "worktree",
  branch: string,
  branches: readonly string[],
  defaultBranch: string,
) => ({ checkoutId: id, resourceId, form, subdirectory: null, branch, branches, defaultBranch });

const workspace = (
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

/** webshop's shared checkout on moss; `hydra/run-3f1` is one of its branches. */
const W_PRIMARY_WEBSHOP: Workspace = {
  ...WORLD.PRIMARY,
  designatedConnectionId: GITHUB_ID,
  sessionIds: [BUMP_THE_BUN_PIN],
};

const W_RUN_3F1: Workspace = { ...WORLD.RUN_3F1, designatedConnectionId: GITHUB_ID };

const W_RUN_8A0 = workspace(
  "01a06d02-7200-7000-8000-000000000003",
  "ephemeral",
  COVE.id,
  [
    checkout(
      "01a06d02-7300-7000-8000-000000000003",
      R_WEBSHOP.id,
      "worktree",
      "hydra/run-8a0",
      ["hydra/run-8a0"],
      "main",
    ),
  ],
  ["01a06d02-7400-7000-8000-000000000003"],
);

const W_PRIMARY_INFRA = workspace("01a06d02-7200-7000-8000-000000000004", "primary", RUNNER.id, [
  checkout(
    "01a06d02-7300-7000-8000-000000000004",
    R_INFRA.id,
    "clone",
    "master",
    ["master", "hetzner-migration"],
    "master",
  ),
]);

const W_PRIMARY_RUNBOOKS = workspace("01a06d02-7200-7000-8000-000000000005", "primary", RUNNER.id, [
  checkout(
    "01a06d02-7300-7000-8000-000000000005",
    R_RUNBOOKS.id,
    "clone",
    "main",
    ["main"],
    "main",
  ),
]);

const thread = (
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
  thread(IDS.flakyThread, "Fix flaky webhook tests", WEBSHOP.id, W_RUN_3F1.id),
  thread(IDS.runbookThread, "Write the retry runbook", WEBSHOP.id, W_RUN_3F1.id),
  thread(
    "01a06d02-7400-7000-8000-000000000003",
    "Runner drain command",
    WEBSHOP.id,
    W_RUN_8A0.id,
    COVE.id,
  ),
  thread(BUMP_THE_BUN_PIN, "Bump the Bun pin", WEBSHOP.id, W_PRIMARY_WEBSHOP.id),
  thread("01a06d02-7400-7000-8000-000000000005", "Tidy the promotion runbook", WEBSHOP.id, null),
  thread("01a06d02-7400-7000-8000-000000000006", "Rotate the Hetzner backups key", OPS.id, null),
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

/** The one Connection of another type, which the GitHub selects must not offer. */
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

/** The catalogs slice 3 adds, over the ones every composer test already stubs. */
const world = (
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

/** A draft at `path`, with the slice-3 catalogs behind it. */
const openAt = async (
  path: string,
  user: Record<string, unknown> = {},
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(controller([INSTANCE_A], user, world(extra)));
  const app = await renderApp({
    path,
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(RUNNER.id),
  });
  return { ...app, api };
};

const inProject = (id: string) => `/threads/new?project=${id}`;

/** Opens the workspace selector and hands back its menu. */
const openWorkspaceMenu = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("button", { name: /^workspace / }));
  return screen.findByRole("dialog");
};

/** Opens the branch selector and hands back its menu. */
const openBranchMenu = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog");
};

describe("Picker: a thread starts from a project (AC-16)", () => {
  const openPicker = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
    await user.click(screen.getByText("Create new thread"));
    return screen.findByRole("dialog");
  };

  it("lists one row per project with its repos, threads and workspaces", async () => {
    const user = userEvent.setup();
    await openAt("/threads/new");

    const picker = await openPicker(user);

    expect(reading(picker)).toContain("New thread in");
    // One repo, five threads in the project, two ephemeral workspaces.
    expect(reading(picker)).toContain("1 repo · webshop · 5 threads · 2 workspaces");
    // The plural half of `<n> repo(s) · <repo names>`, with the names listed.
    expect(reading(picker)).toContain("2 repos · ops-infra, ops-runbooks");
    expect(reading(picker)).toContain("⌘1");
    expect(reading(picker)).toContain("⌘2");
  });

  it("navigates to a draft in the project that was clicked", async () => {
    const user = userEvent.setup();
    const { router } = await openAt("/threads/new");

    const picker = await openPicker(user);
    await user.click(within(picker).getByRole("button", { name: /ops/ }));

    await waitFor(() => {
      expect(router.state.location.href).toBe(inProject(OPS.id));
    });
  });

  it("moves with the arrows and picks with Enter", async () => {
    const user = userEvent.setup();
    const { router } = await openAt("/threads/new");

    await openPicker(user);
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => {
      expect(router.state.location.href).toBe(inProject(OPS.id));
    });
  });

  it("picks the first project with its own ⌘1", async () => {
    const user = userEvent.setup();
    const { router } = await openAt("/threads/new");

    await openPicker(user);
    await user.keyboard("{Meta>}1{/Meta}");

    await waitFor(() => {
      expect(router.state.location.href).toBe(inProject(WEBSHOP.id));
    });
  });

  it("closes on Escape without starting anything", async () => {
    const user = userEvent.setup();
    const { router } = await openAt("/threads/new");

    await openPicker(user);
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(router.state.location.href).toBe("/threads/new");
  });

  it("closes on a click past the panel, and on Esc after a click inside it", async () => {
    const user = userEvent.setup();
    const { router } = await openAt("/threads/new");

    const picker = await openPicker(user);
    // The scrim is the panel's parent: the page behind the picker.
    await user.click(picker.parentElement!);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // A click inside takes the focus the panel was listening with, so Esc is
    // heard on the document rather than on the panel.
    const again = await openPicker(user);
    await user.click(within(again).getByRole("button", { name: /webshop/ }));
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(router.state.location.href).toBe(inProject(WEBSHOP.id));
  });

  it("offers New project as the last row when there are projects", async () => {
    const user = userEvent.setup();
    await openAt("/threads/new");

    const picker = await openPicker(user);

    const text = reading(picker);
    expect(text).toContain("New project");
    expect(text.indexOf("sandbox")).toBeLessThan(text.indexOf("New project"));
  });

  it("offers New project and nothing else when there is no project yet", async () => {
    const user = userEvent.setup();
    const created = project("01a06d02-7000-7000-8000-000000000009", "first");
    const { api, router } = await openAt(
      "/threads/new",
      {},
      {
        "GET /api/v1/projects": { body: { items: [] } },
        "POST /api/v1/projects": { body: created },
      },
    );

    const picker = await openPicker(user);

    expect(reading(picker)).toContain("New project");
    expect(within(picker).queryByRole("button", { name: /webshop/ })).toBeNull();

    await user.type(within(picker).getByRole("textbox"), "first");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(router.state.location.href).toBe(inProject(created.id));
    });
    expect(
      api.calls.find((call) => call.method === "POST" && call.path === "/api/v1/projects")?.body,
    ).toEqual({ name: "first" });
  });

  it("heads the draft with the project it is in", async () => {
    await openAt(inProject(WEBSHOP.id));

    expect(
      await screen.findByRole("heading", { name: "What should the agent do in webshop?" }),
    ).toBeDefined();
  });
});

describe("Composer: the workspace selector (AC-17)", () => {
  it("heads the menu with what it picks and when it stops being pickable", async () => {
    const user = userEvent.setup();
    await openAt(inProject(WEBSHOP.id));

    const menu = await openWorkspaceMenu(user);

    expect(reading(menu)).toContain("Workspace");
    expect(reading(menu)).toContain("locks when the thread starts");
  });

  it("offers the shared checkout, a new worktree, the live workspaces and none", async () => {
    const user = userEvent.setup();
    await openAt(inProject(WEBSHOP.id));

    const menu = await openWorkspaceMenu(user);
    const text = reading(menu);

    expect(text).toContain("Current checkout");
    expect(text).toContain("on main · you and the agent share the files");
    expect(text).toContain("New workspace");
    expect(text).toContain("a fresh worktree of webshop on a new branch");
    // The project's own live ephemeral workspaces, named after their branch,
    // with the machine they stand on and the threads already in them.
    expect(text).toContain("hydra/run-3f1");
    expect(text).toContain("moss");
    expect(text).toContain("2 threads · “Fix flaky webhook tests”, “Write the retry runbook”");
    expect(text).toContain("hydra/run-8a0");
    expect(text).toContain("None");
    expect(text).toContain("the agent works without a checkout");
  });

  it("names the repo per row and lists New workspace first in a multi-repo project", async () => {
    const user = userEvent.setup();
    await openAt(inProject(OPS.id));

    const menu = await openWorkspaceMenu(user);
    const text = reading(menu);

    expect(text).toContain("a worktree of each repo, side by side, each on a new branch");
    expect(text).toContain("Current checkout of ops-infra");
    expect(text).toContain("Current checkout of ops-runbooks");
    expect(text.indexOf("New workspace")).toBeLessThan(text.indexOf("Current checkout of"));
  });

  it("asks about the machine the draft would be placed on, not the one it picked", async () => {
    const user = userEvent.setup();
    // `INSTANCE_FRESH` is on no machine, so no row is selectable and the draft
    // picks none - but it would still be placed on moss, which holds webshop's
    // shared checkout. The menu has to ask about that machine, or it says the
    // repo is not cloned on a machine nothing else ever named.
    const api = stubApi(controller([INSTANCE_FRESH], {}, world()));
    await renderApp({
      path: inProject(WEBSHOP.id),
      api: api.fetch,
      token: "held",
      detectLocalRunner: () => Promise.resolve(RUNNER.id),
    });

    const menu = await openWorkspaceMenu(user);
    expect(reading(menu)).toContain("on main · you and the agent share the files");
    expect(reading(menu)).not.toContain("not cloned");
  });

  it("says a repo is not cloned on the machine rather than hiding the row", async () => {
    const user = userEvent.setup();
    await openAt(inProject(EDGE.id));

    const menu = await openWorkspaceMenu(user);

    expect(reading(menu)).toContain("not cloned on moss · clones on first use");
  });

  it("offers None alone, plus the foot, in a project with no repo", async () => {
    const user = userEvent.setup();
    await openAt(inProject(SANDBOX.id));

    const menu = await openWorkspaceMenu(user);
    const text = reading(menu);

    expect(text).toContain("None");
    expect(text).not.toContain("Current checkout");
    expect(text).not.toContain("New workspace");
    expect(text).toContain("Add a repo to sandbox →");
    expect(text).toContain("Adopt a folder on this machine…");
  });

  it("defaults to the shared checkout in a one-repo project and to a worktree in a multi-repo one", async () => {
    const one = await openAt(inProject(WEBSHOP.id));
    expect(
      await screen.findByRole("button", { name: /^workspace Current checkout$/ }),
    ).toBeDefined();
    one.unmount();

    await openAt(inProject(OPS.id));
    expect(await screen.findByRole("button", { name: /^workspace New workspace$/ })).toBeDefined();
  });

  it("follows the stored thread.workspace over the repo count", async () => {
    await openAt(inProject(WEBSHOP.id), { "thread.workspace": "none" });

    expect(await screen.findByRole("button", { name: /^workspace None$/ })).toBeDefined();
  });

  it("rewrites the lead sentence as the pick changes", async () => {
    const user = userEvent.setup();
    await openAt(inProject(WEBSHOP.id));

    await waitFor(() => {
      expect(reading()).toContain(
        "It works in the checkout of webshop on moss, on main. You and the agent share the files.",
      );
    });

    await openWorkspaceMenu(user);
    await pickRow(user, /New workspace/);
    await waitFor(() => {
      expect(reading()).toContain(
        "It gets its own worktree of webshop, on a new branch from main.",
      );
    });

    await openWorkspaceMenu(user);
    await pickRow(user, /hydra\/run-3f1/);
    await waitFor(() => {
      expect(reading()).toContain(
        "It joins “hydra/run-3f1” there: the agents see each other's edits, on one branch.",
      );
    });

    await openWorkspaceMenu(user);
    await pickRow(user, /^None/);
    await waitFor(() => {
      expect(reading()).toContain("It works without a checkout.");
    });
  });

  it("spawns with the project and the shared checkout the draft stands in", async () => {
    const user = userEvent.setup();
    const { api, router } = await openAt(
      inProject(WEBSHOP.id),
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
    const { api } = await openAt(
      inProject(WEBSHOP.id),
      {},
      { "POST /api/v1/sessions": { body: NEW_SESSION } },
    );

    await openWorkspaceMenu(user);
    await pickRow(user, /hydra\/run-3f1/);

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

  it("spawns with one checkout per repo when a multi-repo project takes a new workspace", async () => {
    const user = userEvent.setup();
    const { api } = await openAt(
      inProject(OPS.id),
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

  it("preselects the workspace named in the address", async () => {
    await openAt(`/threads/new?project=${WEBSHOP.id}&workspace=${W_RUN_3F1.id}`);

    expect(await screen.findByRole("button", { name: /^workspace hydra\/run-3f1$/ })).toBeDefined();
  });
});

describe("Composer: the branch selector (AC-18)", () => {
  it("lists the shared checkout's branches, badges the one it is on and dims one a workspace holds", async () => {
    const user = userEvent.setup();
    await openAt(inProject(WEBSHOP.id));

    const menu = await openBranchMenu(user, /main/);
    const text = reading(menu);

    expect(text).toContain("Branch");
    expect(text).toContain("the checkout switches to it");
    expect(text).toContain("release/2.4");
    expect(text).toContain("current");
    // `hydra/run-3f1` is a branch of the primary, but a ready ephemeral on the
    // same machine is sitting on it, so it is dimmed with what holds it.
    expect(text).toContain("in workspace hydra/run-3f1");
    expect(within(menu).queryByRole("button", { name: /hydra\/run-3f1/ })).toBeNull();
  });

  it("switches the lip and the lead to the branch that was picked", async () => {
    const user = userEvent.setup();
    await openAt(inProject(WEBSHOP.id));

    await openBranchMenu(user, /main/);
    await pickRow(user, /release\/2\.4/);

    await waitFor(() => {
      expect(reading()).toContain(
        "It works in the checkout of webshop on moss, on release/2.4. You and the agent share the files.",
      );
    });
    expect(await screen.findByRole("button", { name: /release\/2\.4/ })).toBeDefined();
  });

  it("asks for a base branch on a new workspace, badging the default and saying where it starts", async () => {
    const user = userEvent.setup();
    await openAt(inProject(WEBSHOP.id));

    await openWorkspaceMenu(user);
    await pickRow(user, /New workspace/);

    const lip = await screen.findByRole("button", { name: /^from main$/ });
    expect(lip).toBeDefined();

    await user.click(lip);
    const menu = await screen.findByRole("dialog");
    const text = reading(menu);

    expect(text).toContain("Base branch");
    expect(text).toContain("the new branch starts from it");
    expect(text).toContain("default");
    expect(text).toContain(
      "The new branch is hydra/run-…, named after the thread, and starts from origin/main when the remote has it.",
    );
  });

  it("reads the bases side by side, and takes no pick, in a multi-repo project", async () => {
    const user = userEvent.setup();
    await openAt(inProject(OPS.id));

    const lip = await screen.findByText("from master · main");
    expect(lip.closest("button")).toBeNull();

    // Nothing opens behind it: there is no base to pick per repo in v1.
    await user.click(lip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reads default, with nothing to pick, on a repo no machine has cloned", async () => {
    const user = userEvent.setup();
    await openAt(inProject(EDGE.id));

    const lip = await screen.findByText("default");
    expect(lip.closest("button")).toBeNull();

    await user.click(lip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is absent on a joined workspace and on none", async () => {
    const user = userEvent.setup();
    await openAt(inProject(WEBSHOP.id));

    await openWorkspaceMenu(user);
    await pickRow(user, /hydra\/run-3f1/);
    await waitFor(() => {
      expect(screen.queryByText("Branch")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: /^from / })).toBeNull();

    await openWorkspaceMenu(user);
    await pickRow(user, /^None/);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^from / })).toBeNull();
    });
  });
});

describe("Composer: the machine selector follows the workspace (AC-19)", () => {
  it("is read-only, naming the workspace, once the thread joins one", async () => {
    const user = userEvent.setup();
    await openAt(inProject(WEBSHOP.id));

    await openWorkspaceMenu(user);
    await pickRow(user, /hydra\/run-8a0/);

    const locked = await screen.findByText("set by the workspace hydra/run-8a0");
    expect(locked.closest("button")).toBeNull();
    await user.click(locked);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a machine without the repo pickable, saying it clones on first use", async () => {
    const user = userEvent.setup();
    await openAt(inProject(EDGE.id));

    await user.click(await screen.findByRole("button", { name: /^machine moss/ }));
    const menu = await screen.findByRole("dialog");

    expect(reading(menu)).toContain("edge-api is not cloned there · clones on first use");
    // "not cloned" is a wait, not a refusal: the row stays a button. Asserted
    // on moss rather than on cove (D-15), which this fixture dims for a reason
    // of its own - no provider instance was ever probed there - and which
    // #160's own rule (a dimmed row is inert) keeps inert whatever this ticket
    // does.
    expect(within(menu).getByRole("button", { name: /moss/ })).toBeDefined();
  });
});

describe("Composer: the workspace menu's foot (AC-23)", () => {
  const NEW_REPO = repo("01a06d02-7100-7000-8000-000000000009", "acme", "checkout", [SANDBOX.id]);

  it("adds a repo to the project and then lists it in the menu", async () => {
    const user = userEvent.setup();
    let resources: readonly Resource[] = RESOURCES;
    const { api } = await openAt(
      inProject(SANDBOX.id),
      {},
      {
        "GET /api/v1/resources": () => ({ body: { items: resources } }),
        "POST /api/v1/resources": () => {
          resources = [...RESOURCES, NEW_REPO];
          return { body: NEW_REPO };
        },
      },
    );

    await openWorkspaceMenu(user);
    await user.click(screen.getByText("Add a repo to sandbox →"));

    await user.type(await screen.findByLabelText("Remote URL"), "git@github.com:acme/checkout.git");
    await user.selectOptions(screen.getByLabelText("GitHub Connection"), GITHUB.id);
    await user.type(screen.getByLabelText("Setup command"), "pnpm install");
    await user.click(screen.getByRole("button", { name: "Add repo" }));

    await waitFor(() => {
      expect(
        api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/resources"),
      ).toBe(true);
    });
    expect(
      api.calls.find((call) => call.method === "POST" && call.path === "/api/v1/resources")?.body,
    ).toEqual({
      kind: "repo",
      remote: "git@github.com:acme/checkout.git",
      connectionId: GITHUB.id,
      setupCommand: "pnpm install",
      projectIds: [SANDBOX.id],
    });

    // The menu is the record of what happened: the repo is on offer now.
    // Read inside the menu (D-15), which is portalled away from the lip: the
    // draft now opens in that repo's checkout, so the trigger reads the same
    // words and a page-wide query would find both.
    expect(
      await within(await screen.findByRole("dialog")).findByText("Current checkout"),
    ).toBeDefined();
  });

  it("offers only the GitHub connections in the add-repo form", async () => {
    const user = userEvent.setup();
    await openAt(inProject(SANDBOX.id));

    await openWorkspaceMenu(user);
    await user.click(screen.getByText("Add a repo to sandbox →"));

    const select = await screen.findByLabelText<HTMLSelectElement>("GitHub Connection");
    const offered = [...select.options].map((option) => option.textContent);
    expect(offered).toContain(GITHUB.label);
    expect(offered).not.toContain(SLACK.label);
  });

  it("shows the API's refusal on the add-repo form", async () => {
    const user = userEvent.setup();
    await openAt(
      inProject(SANDBOX.id),
      {},
      {
        "POST /api/v1/resources": {
          status: 409,
          body: envelope("conflict", "that repo is already a resource"),
        },
      },
    );

    await openWorkspaceMenu(user);
    await user.click(screen.getByText("Add a repo to sandbox →"));

    await user.type(await screen.findByLabelText("Remote URL"), "git@github.com:acme/webshop.git");
    await user.click(screen.getByRole("button", { name: "Add repo" }));

    expect((await screen.findByRole("alert")).textContent).toBe("that repo is already a resource");
  });

  it("adopts a folder for the repo picked in the form and follows the workspace to ready", async () => {
    const user = userEvent.setup();
    const provisioning: Workspace = {
      ...W_PRIMARY_WEBSHOP,
      id: "01a06d02-7200-7000-8000-000000000009",
      status: "provisioning",
      checkouts: [],
      provisionedAt: null,
    };
    const ready: Workspace = { ...provisioning, status: "ready" };
    let answered = false;
    const { api } = await openAt(
      inProject(WEBSHOP.id),
      {},
      {
        "POST /api/v1/workspaces": { body: provisioning },
        [`GET /api/v1/workspaces/${provisioning.id}`]: () => {
          const body = answered ? ready : provisioning;
          answered = true;
          return { body };
        },
      },
    );

    await openWorkspaceMenu(user);
    await user.click(screen.getByText("Adopt a folder on this machine…"));

    await user.selectOptions(await screen.findByLabelText("Repo"), R_WEBSHOP.id);
    await user.type(screen.getByLabelText("Path"), "/Users/rogier/code/webshop");
    await user.click(screen.getByRole("button", { name: "Adopt" }));

    await waitFor(() => {
      expect(
        api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/workspaces"),
      ).toBe(true);
    });
    expect(
      api.calls.find((call) => call.method === "POST" && call.path === "/api/v1/workspaces")?.body,
    ).toEqual({
      resourceId: R_WEBSHOP.id,
      runnerId: RUNNER.id,
      path: "/Users/rogier/code/webshop",
    });

    expect(await screen.findByText("provisioning")).toBeDefined();
    expect(await screen.findByText("ready")).toBeDefined();
  });

  it("shows the message a failed adopt came back with", async () => {
    const user = userEvent.setup();
    const failed: Workspace = {
      ...W_PRIMARY_WEBSHOP,
      id: "01a06d02-7200-7000-8000-00000000000a",
      status: "failed",
      checkouts: [],
      message: "/Users/rogier/code/webshop is not a git repository",
    };
    await openAt(
      inProject(WEBSHOP.id),
      {},
      {
        "POST /api/v1/workspaces": { body: failed },
        [`GET /api/v1/workspaces/${failed.id}`]: { body: failed },
      },
    );

    await openWorkspaceMenu(user);
    await user.click(screen.getByText("Adopt a folder on this machine…"));

    await user.selectOptions(await screen.findByLabelText("Repo"), R_WEBSHOP.id);
    await user.type(screen.getByLabelText("Path"), "/Users/rogier/code/webshop");
    await user.click(screen.getByRole("button", { name: "Adopt" }));

    expect(
      await screen.findByText("/Users/rogier/code/webshop is not a git repository"),
    ).toBeDefined();
  });

  it("says a machine has to be picked before a folder on one can be adopted", async () => {
    const user = userEvent.setup();
    const { api } = await openAt(
      inProject(WEBSHOP.id),
      {},
      {
        // No machine is connected at all, so the draft is placed on none and
        // there is no machine whose folder could be adopted.
        "GET /api/v1/runners": { body: { items: [] } },
      },
    );

    await openWorkspaceMenu(user);
    await user.click(screen.getByText("Adopt a folder on this machine…"));

    await user.selectOptions(await screen.findByLabelText("Repo"), R_WEBSHOP.id);
    await user.type(screen.getByLabelText("Path"), "/Users/rogier/code/webshop");
    await user.click(screen.getByRole("button", { name: "Adopt" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Pick a machine first");
    expect(
      api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/workspaces"),
    ).toBe(false);
  });

  it("shows the API's refusal on the adopt form", async () => {
    const user = userEvent.setup();
    await openAt(
      inProject(WEBSHOP.id),
      {},
      {
        "POST /api/v1/workspaces": {
          status: 409,
          body: envelope("conflict", "moss already holds a checkout of webshop"),
        },
      },
    );

    await openWorkspaceMenu(user);
    await user.click(screen.getByText("Adopt a folder on this machine…"));

    await user.selectOptions(await screen.findByLabelText("Repo"), R_WEBSHOP.id);
    await user.type(screen.getByLabelText("Path"), "/Users/rogier/code/webshop");
    await user.click(screen.getByRole("button", { name: "Adopt" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "moss already holds a checkout of webshop",
    );
  });
});
