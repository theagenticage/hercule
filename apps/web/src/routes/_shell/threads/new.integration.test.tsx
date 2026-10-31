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
 *   `label` as the descriptor writes it ("Medium").
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Connection,
  ModelOption,
  ModelProfile,
  Profile,
  Project,
  ProviderAccount,
  Resource,
  Runner,
  Session,
  Workspace,
} from "@hercule/contract";
import { HARNESSES } from "@hercule/client-core/testing";
import { buildRunner, buildThreadsWorld } from "@hercule/client-core/threads/testing";
import {
  buildCatalogFields,
  buildErrorBody,
  buildMainProfile,
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
  // Claude Code and Codex installed, so the accounts of the tests are ready here.
  facts: buildRunner("", "").facts,
  watermark: null,
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 10 * 1024 * 1024 * 1024,
  lastSeenAt: "2026-09-05T09:14:00.000Z",
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

/** Builds a signed-in snapshot in Claude Code; `buildProviderAccount` restamps it with the account's own harness. */
const buildSnapshot = (
  runnerId: string,
  identity: string,
  planLabel: string,
  models: ProviderAccount["snapshots"][number]["models"],
): ProviderAccount["snapshots"][number] => ({
  runnerId,
  harnessId: "claude-code/claude-code",
  probedAt: "2026-09-05T09:10:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "ok", identity, planLabel },
  models,
});

/** What makes an account belong to a provider: its provider, kind and default harness. */
interface ProviderAccountBase {
  readonly providerId: string;
  readonly kind: string;
  readonly harnessId: string;
}

const ANTHROPIC: ProviderAccountBase = {
  providerId: "anthropic/anthropic",
  kind: "subscription-per-machine",
  harnessId: "claude-code/claude-code",
};

const OPENAI: ProviderAccountBase = {
  providerId: "openai/openai",
  kind: "subscription-per-machine",
  harnessId: "codex/codex",
};

const ZAI: ProviderAccountBase = { providerId: "zai/zai", kind: "api-key", harnessId: "pi/pi" };

const buildProviderAccount = (
  id: string,
  label: string | null,
  provider: ProviderAccountBase,
  snapshots: ProviderAccount["snapshots"],
): ProviderAccount => {
  const stamped = snapshots.map((snapshot) => ({ ...snapshot, harnessId: provider.harnessId }));
  const fields = buildCatalogFields(stamped);
  return {
    id,
    providerId: provider.providerId,
    kind: provider.kind,
    label,
    identity: null,
    planLabel: null,
    defaultHarnessId: provider.harnessId,
    expiresAt: null,
    usage: [],
    failure: null,
    snapshots: stamped,
    ...fields,
    // An account that was never probed on the runner is signed out there.
    readiness: fields.readiness.some((row) => row.runnerId === RUNNER.id)
      ? fields.readiness
      : [
          ...fields.readiness,
          { harnessId: provider.harnessId, runnerId: RUNNER.id, state: "not-signed-in" },
        ],
    createdAt: "2026-09-05T09:00:00.000Z",
    updatedAt: "2026-09-05T09:00:00.000Z",
  };
};

/** Signed in on the one runner, two models, the default one carrying options. */
const ACCOUNT_A = buildProviderAccount(
  "01a06d02-1000-7000-8000-000000000001",
  "personal",
  ANTHROPIC,
  [
    buildSnapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        imageInput: { maxBytes: null },
        isDefault: true,
        options: [EFFORT, THINKING],
      },
      { slug: "claude-opus-5", name: "Claude Opus 5", imageInput: { maxBytes: null }, options: [] },
    ]),
  ],
);

/** A second account of the same provider, one model, no options. */
const ACCOUNT_B = buildProviderAccount("01a06d02-1000-7000-8000-000000000002", "work", ANTHROPIC, [
  buildSnapshot(RUNNER.id, "work@example.com", "Claude Pro", [
    {
      slug: "claude-haiku-5",
      name: "Claude Haiku 5",
      imageInput: { maxBytes: null },
      isDefault: true,
      options: [],
    },
  ]),
]);

/**
 * The real first-run state: the account exists, because the controller
 * creates one Provider Account per shipped provider on first run. Nothing is
 * signed in on the one runner yet, so there is no snapshot at all -
 * `buildRunnerMenu`'s only row dims "not signed in" and its `defaultRunnerId`
 * is null.
 */
const ACCOUNT_FRESH = buildProviderAccount(
  "01a06d02-1000-7000-8000-000000000003",
  null,
  ANTHROPIC,
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
  kind: "thread",
  role: null,
  status: "starting",
  resumable: false,
  resumeHeld: false,
  toolCalls: 0,
  permissionProfileId: PROFILE_UNRESTRICTED.id,
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  providerAccountId: ACCOUNT_A.id,
  harnessId: "claude-code/claude-code",
  runnerId: RUNNER.id,
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [],
  openPermissionRequests: [],
  createdAt: "2026-09-08T10:00:00.000Z",
  startedAt: null,
  exitedAt: null,
  lastActivityAt: "2026-09-08T10:00:00.000Z",
  unenforced: [],
};

const buildController = (
  accounts: readonly ProviderAccount[],
  user: Record<string, unknown> = {},
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone", "assistant"], timezone: ZONE, ...user },
    },
  },
  "GET /api/v1/provider-accounts": { body: accounts },
  "GET /api/v1/model-profiles": { body: [buildMainProfile(accounts)] },
  "GET /api/v1/runners": { body: { items: [RUNNER] } },
  "GET /api/v1/profiles": { body: { items: [PROFILE_UNRESTRICTED, PROFILE_WORKER] } },
  // After a send, the app navigates to the new thread. These stubs
  // serve the session that the spawn returns, so the thread route's loader
  // does not fail with a 404 and break the navigation under test.
  [`GET /api/v1/sessions/${NEW_SESSION.id}`]: { body: NEW_SESSION },
  [`GET /api/v1/sessions/${NEW_SESSION.id}/transcript`]: { body: { items: [] } },
  [`GET /api/v1/sessions/${NEW_SESSION.id}/subagents`]: { body: { items: [] } },
  ...extra,
});

const openApp = async (
  accounts: readonly ProviderAccount[] = [ACCOUNT_A, ACCOUNT_B],
  user: Record<string, unknown> = {},
  extra: Readonly<Record<string, Handler>> = {},
  storage: Readonly<Record<string, string>> = {},
) => {
  const api = stubApi(buildController(accounts, user, extra));
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
    await openApp([ACCOUNT_A]);

    expect(screen.getByRole("heading", { name: "What should the agent do?" })).toBeDefined();

    expect(screen.getByRole("textbox")).toBeDefined();

    const attach = screen.getByRole<HTMLButtonElement>("button", { name: "Attach images" });
    expect(attach.disabled).toBe(false);

    const voice = screen.getByTitle<HTMLButtonElement>("Dictation is not built yet");
    expect(voice.disabled).toBe(true);

    // The model pill shows the default model. Its options are in the selector
    // next to it, labelled with the effort choice "Medium".
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Claude Sonnet 5" })).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Medium" })).toBeDefined();

    expect(screen.getByRole("button", { name: /approval required/i })).toBeDefined();

    expect(screen.getByText("No workspace")).toBeDefined();
    expect(screen.getByText(RUNNER.name)).toBeDefined();

    const send = screen.getByRole<HTMLButtonElement>("button", { name: /send/i });
    expect(send.disabled).toBe(true);
  });

  it("prefills from the thread.* settings when they are stored", async () => {
    await openApp([ACCOUNT_A, ACCOUNT_B], {
      "thread.providerAccountId": ACCOUNT_B.id,
      "thread.model": "claude-haiku-5",
      "thread.accessMode": "auto",
      "thread.profileId": PROFILE_WORKER.id,
    });

    // There are two accounts of one provider, so the pill includes the
    // account name. claude-haiku-5 has no options, so no options selector
    // appears next to the pill.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Anthropic · work Claude Haiku 5" })).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Auto" })).toBeDefined();
  });
});

describe("Composer: a fresh install, nothing signed in on the one runner yet", () => {
  it("shows only the pill parts it has, with no dangling separator, when there is no model to offer", async () => {
    await openApp([ACCOUNT_FRESH]);

    // There is no model to show, and no separator is left over.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "No model" })).toBeDefined();
    });
  });

  it("shows the runner's name and why it is dimmed on the runner button, not just the word Runner", async () => {
    await openApp([ACCOUNT_FRESH]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: `machine ${RUNNER.name} · not signed in` }),
      ).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: "Runner" })).toBeNull();
  });

  it("explains why the draft cannot start, and offers to sign in on the machine where the account is signed out", async () => {
    await openApp([ACCOUNT_FRESH]);

    await waitFor(() => {
      expect(readPageText()).toContain(
        `Can't start yet. Anthropic is not signed in on ${RUNNER.name}.`,
      );
    });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
  });

  it("explains why the draft cannot start, and offers no Sign in on a machine where the harness is missing", async () => {
    // The controller sends no readiness row for a machine the account cannot
    // run on, so there is nothing to sign in to there.
    await openApp([{ ...ACCOUNT_FRESH, readiness: [] }]);

    await waitFor(() => {
      expect(readPageText()).toContain(`Can't start yet. Anthropic is not on ${RUNNER.name}.`);
    });
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("keeps send disabled and shows the reason, instead of spawning with empty ids", async () => {
    // Nothing is signed in, so `buildRunnerMenu` offers no selectable row, and
    // the draft's runner, model and profile stay null. Sending would post ids
    // that the contract's `Id` schema rejects, and the error would be about
    // fields the user never touched.
    const user = userEvent.setup();
    const { api } = await openApp([ACCOUNT_FRESH]);

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    const send = await screen.findByRole<HTMLButtonElement>("button", { name: /send/i });
    await waitFor(() => {
      expect(send.disabled).toBe(true);
    });
    expect(readPageText()).toContain(`Anthropic is not signed in on ${RUNNER.name}`);
    expect(
      api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
    ).toBe(false);
  });

  it("keeps send disabled with the reason when no account exists at all", async () => {
    const user = userEvent.setup();
    await openApp([]);

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    const send = screen.getByRole<HTMLButtonElement>("button", { name: /send/i });
    await waitFor(() => {
      expect(send.disabled).toBe(true);
    });
    expect(readPageText()).toContain("No account is set up");
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
    // used, with a description below. The model menu shows who is signed in,
    // not this menu.
    expect(dialog).toContain("moss online 0/4");
    expect(dialog).toContain("this machine · default");
    expect(dialog).toContain("The thread runs where you say; nothing moves it later.");
  });
});

describe("Composer: model menu", () => {
  it("draws one lane per account of the profile with its models, marks the current one, and offers no free-text entry", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    const menu = await screen.findByRole("dialog");

    // Both accounts belong to one provider, so each lane is named in full.
    expect(within(menu).getByText("Anthropic · personal")).toBeDefined();
    expect(within(menu).getByText("Anthropic · work")).toBeDefined();
    for (const name of [/claude sonnet 5/i, /claude opus 5/i, /claude haiku 5/i]) {
      expect(within(menu).getByRole("button", { name })).toBeDefined();
    }
    // The pill shows the current model, and its row in the menu has the check.
    expect(within(menu).getByRole("button", { name: /claude sonnet 5/i }).textContent).toContain(
      "✓",
    );
    expect(within(menu).getByRole("button", { name: /claude opus 5/i }).textContent).not.toContain(
      "✓",
    );

    expect(screen.queryByText(/custom model/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/model/i)).toBeNull();
  });

  it("renders a select option as a segmented row and a boolean option as an off · on row", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole("button", { name: "Medium" }));

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

  it("switches the pill's account when a model of another account is chosen", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    // Each row belongs to its account, so picking Haiku 5 in the work lane
    // switches the account and the model together.
    await user.click(screen.getByRole("button", { name: /claude haiku 5/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Anthropic · work Claude Haiku 5" })).toBeDefined();
    });
  });

  it("changes the options selector's label when an option is chosen", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(screen.getByRole("button", { name: "Medium" }));
    // As in the "renders a select option..." test above, `SegmentedControl`
    // gives each choice `role="radio"`, not `role="button"`.
    await user.click(screen.getByRole("radio", { name: "High" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "High" })).toBeDefined();
    });
  });
});

describe("Composer: sending", () => {
  it("spawns with exactly the selectors' values, navigates to the new thread, and never patches settings", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp(
      [ACCOUNT_A],
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
      providerAccountId: ACCOUNT_A.id,
      harnessId: "claude-code/claude-code",
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
      [ACCOUNT_A],
      {},
      {
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    );

    await user.type(screen.getByRole("textbox"), "Fix the login bug");

    // The picks are made in the model options popover: the `effort` row, and
    // the `thinking` row, which is on by default and is turned off here.
    await user.click(screen.getByRole("button", { name: "Medium" }));
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
      providerAccountId: ACCOUNT_A.id,
      harnessId: "claude-code/claude-code",
      model: "claude-sonnet-5",
      accessMode: "approval-required",
      runnerId: RUNNER.id,
      permissionProfileId: PROFILE_UNRESTRICTED.id,
      options: { effort: "high", thinking: false },
    });
  });

  it("keeps the picked machine when another model of the same account is picked after it", async () => {
    const user = userEvent.setup();
    const cove: Runner = { ...RUNNER, id: "01a06d02-beff-7037-9f5b-042822015953", name: "cove" };
    // The second account, with two models, signed in on both machines.
    const work = buildProviderAccount(
      ACCOUNT_B.id,
      "work",
      ANTHROPIC,
      [RUNNER.id, cove.id].map((runnerId) =>
        buildSnapshot(runnerId, "work@example.com", "Claude Pro", [
          {
            slug: "claude-haiku-5",
            name: "Claude Haiku 5",
            imageInput: { maxBytes: null },
            isDefault: true,
            options: [],
          },
          {
            slug: "claude-haiku-mini",
            name: "Claude Haiku Mini",
            imageInput: { maxBytes: null },
            options: [],
          },
        ]),
      ),
    );
    const { api } = await openApp(
      [ACCOUNT_A, work],
      {},
      {
        "GET /api/v1/runners": { body: { items: [RUNNER, cove] } },
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    );

    // Switch to the second account, pick the other machine, then another
    // model of the same account.
    await user.click(await screen.findByRole("button", { name: /claude sonnet 5/i }));
    await pickRow(user, /claude haiku 5/i);
    await user.click(screen.getByRole("button", { name: /^machine moss/ }));
    await pickRow(user, /^cove/);
    await user.click(screen.getByRole("button", { name: /claude haiku 5/i }));
    await pickRow(user, /claude haiku mini/i);
    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      const spawn = api.calls.find(
        (call) => call.method === "POST" && call.path === "/api/v1/sessions",
      );
      expect(spawn?.body).toMatchObject({
        providerAccountId: work.id,
        model: "claude-haiku-mini",
        runnerId: cove.id,
      });
    });
  });

  it("sends on Enter, inserts a newline on Shift+Enter, and never sends on an IME's Enter", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp(
      [ACCOUNT_A],
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
    await openApp([ACCOUNT_A]);

    const send = screen.getByRole<HTMLButtonElement>("button", { name: /send/i });
    expect(send.disabled).toBe(true);
  });

  it("shows the API's error message under the card and keeps the typed text", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(
      [ACCOUNT_A],
      {},
      {
        "POST /api/v1/sessions": {
          status: 409,
          body: buildErrorBody("invalid_state", "moss is not signed in to Anthropic"),
        },
      },
    );

    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "moss is not signed in to Anthropic",
    );
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Fix the login bug");
    expect(
      api.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
    ).toHaveLength(1);
  });
});

describe("Routing: /threads/new is the static route", () => {
  it("renders the composer rather than reading 'new' as a session id", async () => {
    const { api } = await openApp([ACCOUNT_A]);

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
 *   label text ("Medium", "High", "High ⚡").
 * - A boolean descriptor is a segmented `off · on` row, like every other
 *   descriptor.
 * - The older-models fold and every menu row are buttons with their text.
 * - A menu is the Radix popover, found as `role="dialog"`. Queries for a row
 *   are scoped to it, because the page outside also holds the trigger.
 */

/** Builds a snapshot of an account on a runner where the harness is installed with nobody signed in. */
const buildUnauthenticatedSnapshot = (runnerId: string): ProviderAccount["snapshots"][number] => ({
  runnerId,
  harnessId: "claude-code/claude-code",
  probedAt: "2026-09-05T09:10:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "unauthenticated" },
  models: [],
});

const SIGNED_OUT = buildProviderAccount("01a06d02-1000-7000-8000-000000000004", null, ANTHROPIC, [
  buildUnauthenticatedSnapshot(RUNNER.id),
]);

/** The same account after the sign-in in the test below has finished. */
const SIGNED_IN = buildProviderAccount(SIGNED_OUT.id, null, ANTHROPIC, [
  buildSnapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      imageInput: { maxBytes: null },
      isDefault: true,
      options: [],
    },
  ]),
]);

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize?code=1";

describe("Composer: a sign-in updates the open draft", () => {
  it("blocks the draft with the sign-in message, then uses the new model list and spawns with it", async () => {
    const user = userEvent.setup();
    let held: readonly ProviderAccount[] = [SIGNED_OUT];
    const { api, live } = await openApp(
      [SIGNED_OUT],
      {},
      {
        "GET /api/v1/provider-accounts": () => ({ body: held }),
        "GET /api/v1/model-profiles": () => ({ body: [buildMainProfile(held)] }),
        [`POST /api/v1/provider-accounts/${SIGNED_OUT.id}/sign-in`]: {
          body: { url: AUTHORIZE_URL },
        },
        [`POST /api/v1/provider-accounts/${SIGNED_OUT.id}/sign-in-code`]: () => {
          held = [SIGNED_IN];
          return { body: SIGNED_IN };
        },
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    );

    // Nothing is signed in, so there is no model to show. The blocking
    // message names the account and the machine, and what is missing.
    await waitFor(() => {
      expect(readPageText()).toContain("Can't start yet. Anthropic is not signed in on moss.");
    });
    expect(screen.queryByRole("button", { name: /claude sonnet 5/i })).toBeNull();
    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /send/i }).disabled).toBe(true);

    // The Sign in button is next to the blocking message, and the sign-in runs
    // on the draft's runner.
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(readPageText()).toContain(AUTHORIZE_URL);
    });
    expect(api.calls.find((call) => call.path.endsWith("/sign-in"))?.body).toEqual({
      runnerId: RUNNER.id,
    });

    await user.type(screen.getByLabelText("Code", { exact: true }), "the-whole-code");
    await user.click(screen.getByRole("button", { name: /submit/i }));
    // The sign-in made the controller read the account's models into the
    // profile, and it announces the change.
    act(() => {
      live.push("provider", { _tag: "invalidate", ids: [], kind: "updated" });
    });

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
      providerAccountId: SIGNED_OUT.id,
      model: "claude-sonnet-5",
      runnerId: RUNNER.id,
    });
  });
});

/** Builds a model with no options. `extra` adds or overrides fields. */
const buildModel = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name,
  imageInput: { maxBytes: null },
  options: [],
  ...extra,
});

/** With `MANY_B`: nine models across two accounts, one over the filter threshold. */
const MANY_A = buildProviderAccount("01a06d02-1000-7000-8000-000000000011", "personal", ANTHROPIC, [
  buildSnapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
    buildModel("claude-sonnet-5", "Claude Sonnet 5", { isDefault: true }),
    buildModel("claude-opus-5", "Claude Opus 5"),
    buildModel("claude-haiku-5", "Claude Haiku 5"),
    buildModel("claude-sonnet-4", "Claude Sonnet 4"),
    buildModel("claude-haiku-4", "Claude Haiku 4"),
  ]),
]);

const MANY_B = buildProviderAccount("01a06d02-1000-7000-8000-000000000012", "work", ANTHROPIC, [
  buildSnapshot(RUNNER.id, "work@example.com", "Claude Pro", [
    buildModel("claude-opus-4", "Claude Opus 4", { isDefault: true }),
    buildModel("claude-sonnet-3", "Claude Sonnet 3"),
    buildModel("claude-haiku-3", "Claude Haiku 3"),
    buildModel("claude-sonnet-2", "Claude Sonnet 2"),
  ]),
]);

/** With `MANY_A`: eight models in total, which is not over the filter threshold. */
const EIGHT_B: ProviderAccount = {
  ...MANY_B,
  snapshots: [
    buildSnapshot(RUNNER.id, "work@example.com", "Claude Pro", [
      buildModel("claude-opus-4", "Claude Opus 4", { isDefault: true }),
      buildModel("claude-sonnet-3", "Claude Sonnet 3"),
      buildModel("claude-haiku-3", "Claude Haiku 3"),
    ]),
  ],
};

/** An account with one legacy model, which the menu hides under "older models". */
const WITH_LEGACY = buildProviderAccount(
  "01a06d02-1000-7000-8000-000000000013",
  "personal",
  ANTHROPIC,
  [
    buildSnapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
      buildModel("claude-sonnet-5", "Claude Sonnet 5", { isDefault: true }),
      buildModel("claude-opus-5", "Claude Opus 5"),
      buildModel("claude-sonnet-4", "Claude Sonnet 4", { isLegacy: true }),
    ]),
  ],
);

/** A second provider with one account, so its rows never show an account name. */
const CODEX = buildProviderAccount("01a06d02-1000-7000-8000-000000000014", null, OPENAI, [
  buildSnapshot(RUNNER.id, "rogier@openai.test", "Plus", [
    buildModel("gpt-5-codex", "GPT-5 Codex", { isDefault: true }),
  ]),
]);

/**
 * Another provider's account, which nobody has signed in to on this machine.
 * Its models were read when it was signed in elsewhere, so its profile section
 * holds them, and none of them can run here.
 */
const OTHER_SIGNED_OUT: ProviderAccount = {
  ...buildProviderAccount("01a06d02-1000-7000-8000-000000000015", null, OPENAI, [
    buildSnapshot("01a06d02-beff-7037-9f5b-042822015999", "rogier@openai.test", "Plus", [
      buildModel("gpt-5-codex", "GPT-5 Codex", { isDefault: true }),
    ]),
  ]),
  readiness: [{ harnessId: "codex/codex", runnerId: RUNNER.id, state: "not-signed-in" }],
};

/** An account added a moment ago: nothing has been read from it, so its models are still to come. */
const OTHER_UNREAD = buildProviderAccount("01a06d02-1000-7000-8000-000000000017", null, OPENAI, [
  buildUnauthenticatedSnapshot(RUNNER.id),
]);

const RECENT_KEY = "hercule.recentModels";

/** Builds the `localStorage` contents for a draft whose Recent lane already holds `pairs`. */
const buildRecentStorage = (
  pairs: ReadonlyArray<{ providerAccountId: string; harnessId: string; model: string }>,
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
      [ACCOUNT_A, ACCOUNT_B, CODEX],
      {},
      {},
      buildRecentStorage([
        { providerAccountId: CODEX.id, harnessId: "codex/codex", model: "gpt-5-codex" },
        {
          providerAccountId: ACCOUNT_A.id,
          harnessId: "claude-code/claude-code",
          model: "claude-opus-5",
        },
      ]),
    );

    const menu = await openModelMenu(user, /claude sonnet 5/i);
    const lane = readPageText(menu);

    expect(lane).toContain("Recent");
    // Newest first, and both above the current account's lane.
    expect(lane.indexOf("Recent")).toBeLessThan(lane.indexOf("GPT-5 Codex"));
    expect(lane.indexOf("GPT-5 Codex")).toBeLessThan(lane.indexOf("Claude Opus 5"));

    // Anthropic has two accounts here, so its recent row shows the account.
    // The row of the provider with one account shows none.
    const recentOpus = within(menu).getAllByRole("button", { name: /claude opus 5/i })[0];
    expect(readPageText(recentOpus ?? null)).toContain("Anthropic · personal");
    expect(
      readPageText(within(menu).getAllByRole("button", { name: /gpt-5 codex/i })[0] ?? null),
    ).not.toContain("openai");
  });

  it("marks each account's lane with the mark of the plugin that registered its provider", async () => {
    const user = userEvent.setup();
    // Only Anthropic's plugin is listed and declares a mark: OpenAI's lane
    // falls back to the plugin's initial.
    const MARK_PATH = "M2 2h12v12H2z";
    await openApp(
      [ACCOUNT_A, CODEX],
      {},
      {
        "GET /api/v1/plugins": {
          body: [
            {
              id: "anthropic",
              displayName: "Anthropic",
              mark: { paths: [MARK_PATH] },
              hostApi: 1,
              capabilities: ["providers"],
              enabled: true,
              status: { _tag: "active" },
              config: {},
              contributions: [],
              intake: { eventKinds: [], signalKinds: [] },
            },
          ],
        },
      },
    );

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    const anthropicLane = within(menu).getByText("Anthropic · personal").parentElement!;
    expect(anthropicLane.querySelector(`svg path[d="${MARK_PATH}"]`)).not.toBeNull();
    const openAiLane = within(menu).getByText("OpenAI").parentElement!;
    expect(openAiLane.querySelector("svg text")?.textContent).toBe("O");
  });

  it("(c) offers no legacy model and no older models fold, because a profile holds only what the user put in it", async () => {
    const user = userEvent.setup();
    await openApp([WITH_LEGACY]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(within(menu).getByRole("button", { name: /claude opus 5/i })).toBeDefined();
    expect(within(menu).queryByRole("button", { name: /claude sonnet 4/i })).toBeNull();
    expect(readPageText(menu)).not.toContain("older models");
  });

  it("(d) dims the entries of an account that is signed out here, with the reason and its own Sign in on each row", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(
      [ACCOUNT_A, OTHER_SIGNED_OUT],
      {},
      {
        [`POST /api/v1/provider-accounts/${OTHER_SIGNED_OUT.id}/sign-in`]: {
          body: { url: AUTHORIZE_URL },
        },
      },
    );

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    // The entry stays in its account's lane, dimmed, with its reason at the
    // right. A dimmed row is not a button, so it cannot be picked.
    expect(within(menu).getByText("OpenAI")).toBeDefined();
    expect(readPageText(menu)).toContain("GPT-5 Codex");
    expect(readPageText(menu)).toContain("not signed in on moss");
    expect(within(menu).queryByRole("button", { name: /gpt-5 codex/i })).toBeNull();

    await user.click(within(menu).getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(readPageText()).toContain(AUTHORIZE_URL);
    });
    // The row signs in to its own account, not the currently selected one, on
    // the machine where the credential will be stored.
    expect(screen.getByText("Sign in to OpenAI on moss")).toBeDefined();
    expect(api.calls.find((call) => call.path.endsWith("/sign-in"))?.body).toEqual({
      runnerId: RUNNER.id,
    });
  });

  it("(d) says a lane is waiting while its account has not had its first read of models", async () => {
    const user = userEvent.setup();
    await openApp([ACCOUNT_A, OTHER_UNREAD]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(readPageText(menu)).toContain("OpenAI");
    expect(readPageText(menu)).toContain("Reading models…");
  });

  it("(d) judges every entry on the machine the user picked", async () => {
    const user = userEvent.setup();
    const cove: Runner = { ...RUNNER, id: "01a06d02-beff-7037-9f5b-042822015953", name: "cove" };
    // The personal account is signed in on both machines. The work account is
    // signed in on moss only.
    const personal = buildProviderAccount(
      ACCOUNT_A.id,
      "personal",
      ANTHROPIC,
      [RUNNER.id, cove.id].map((runnerId) =>
        buildSnapshot(runnerId, "rogier@example.com", "Claude Max", [
          {
            slug: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            imageInput: { maxBytes: null },
            isDefault: true,
            options: [],
          },
        ]),
      ),
    );
    await openApp(
      [personal, ACCOUNT_B],
      {},
      { "GET /api/v1/runners": { body: { items: [RUNNER, cove] } } },
    );

    await user.click(await screen.findByRole("button", { name: /^machine moss/ }));
    await pickRow(user, /^cove/);
    const menu = await openModelMenu(user, /claude sonnet 5/i);

    // On cove the work account has no sign-in, so its entry is dimmed and
    // cannot be picked.
    expect(readPageText(menu)).toContain("Claude Code is not on cove");
    expect(within(menu).queryByRole("button", { name: /claude haiku 5/i })).toBeNull();
  });

  it("(f) marks the profile's default entry, and an entry that runs in another harness with `in pi`, and picking that entry sends its harness", async () => {
    const user = userEvent.setup();
    // The account can also run in pi on moss.
    const account: ProviderAccount = {
      ...ACCOUNT_A,
      readiness: [
        ...ACCOUNT_A.readiness,
        { harnessId: "pi/pi", runnerId: RUNNER.id, state: "ready" },
      ],
    };
    const main = buildMainProfile([account]);
    const section = main.accounts[0]!;
    const opus = section.entries.find((entry) => entry.model === "claude-opus-5")!;
    const profile: ModelProfile = {
      ...main,
      accounts: [
        {
          ...section,
          entries: [
            ...section.entries,
            { ...opus, harnessId: "pi/pi", resolvedHarnessId: "pi/pi" },
          ],
        },
      ],
    };
    const { api } = await openApp(
      [account],
      { "thread.providerAccountId": ACCOUNT_A.id, "thread.model": "claude-opus-5" },
      {
        "GET /api/v1/model-profiles": { body: [profile] },
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    );

    const menu = await openModelMenu(user, /claude opus 5/i);

    // Sonnet 5 is the profile's default entry; Opus 5 is the current one.
    expect(readPageText(within(menu).getByRole("button", { name: /claude sonnet 5/i }))).toContain(
      "default",
    );
    const inPi = within(menu).getByRole("button", { name: /claude opus 5.*in pi/i });
    expect(readPageText(inPi)).not.toContain("✓");

    await user.click(inPi);
    await user.type(screen.getByRole("textbox"), "Fix the login bug");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(
        api.calls.find((call) => call.method === "POST" && call.path === "/api/v1/sessions")?.body,
      ).toMatchObject({
        providerAccountId: ACCOUNT_A.id,
        harnessId: "pi/pi",
        model: "claude-opus-5",
      });
    });
  });

  it("(e) labels the current lane with the full account name when the provider has two", async () => {
    const user = userEvent.setup();
    await openApp([ACCOUNT_A, ACCOUNT_B]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(readPageText(menu)).toContain("Anthropic · personal");
  });

  it("(e) labels the current lane with the provider's name when the account has no label", async () => {
    const user = userEvent.setup();
    await openApp([{ ...ACCOUNT_A, label: null }]);

    const menu = await openModelMenu(user, /claude sonnet 5/i);

    expect(readPageText(menu)).toContain("Anthropic");
    expect(readPageText(menu)).not.toContain("personal");
  });
});

const NEW_MODEL_SLUG = "claude-opus-5-6";
const NEW_MODEL_PATH = `/api/v1/model-profiles/${buildMainProfile([ACCOUNT_A]).id}`;

/** Adds `newModels` to the first account's section of a profile. */
const withNewModels = (profile: ModelProfile): ModelProfile => ({
  ...profile,
  accounts: profile.accounts.map((section, index) =>
    index === 0
      ? {
          ...section,
          newModels: [
            {
              model: NEW_MODEL_SLUG,
              name: "Claude Opus 5.6",
              // The current year, so the row reads "arrived 26 Oct" whenever the test runs.
              firstSeenAt: `${String(new Date().getFullYear())}-10-26T10:00:00.000Z`,
            },
          ],
        }
      : section,
  ),
});

/** Returns the profile as the controller answers an Add: the model is an entry and no longer new. */
const withNewModelAdded = (profile: ModelProfile): ModelProfile => {
  const section = profile.accounts[0]!;
  const opus = section.entries.find((entry) => entry.model === "claude-opus-5")!;
  return {
    ...profile,
    revision: profile.revision + 1,
    accounts: [
      {
        ...section,
        newModels: [],
        entries: [...section.entries, { ...opus, model: NEW_MODEL_SLUG, name: "Claude Opus 5.6" }],
      },
      ...profile.accounts.slice(1),
    ],
  };
};

describe("Composer: New rows in the model menu", () => {
  const profile = withNewModels(buildMainProfile([ACCOUNT_A]));

  const openWithNewModel = async (extra: Readonly<Record<string, Handler>>) => {
    const user = userEvent.setup();
    const { api } = await openApp(
      [ACCOUNT_A],
      {},
      { "GET /api/v1/model-profiles": { body: [profile] }, ...extra },
    );
    const menu = await openModelMenu(user, /claude sonnet 5/i);
    return { user, api, menu };
  };

  const readUpdates = (api: {
    readonly calls: readonly { method: string; path: string; body: unknown }[];
  }) => api.calls.filter((call) => call.method === "PATCH" && call.path === NEW_MODEL_PATH);

  it("draws the row at the top of the account's lane with its arrival date, and does not make it a pick", async () => {
    const { user, menu } = await openWithNewModel({});

    const row = within(menu).getByText("Claude Opus 5.6").closest("div")!;
    expect(readPageText(row)).toContain("New");
    expect(readPageText(row)).toContain("arrived 26 Oct");
    // Above the lane's first model.
    const first = within(menu).getByRole("button", { name: /claude sonnet 5/i });
    expect(row.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The body of the row is not a button, so clicking it picks nothing.
    await user.click(within(menu).getByText("Claude Opus 5.6"));
    expect(screen.getByRole("dialog")).toBeDefined();
    // Still the current model: the pill and the menu's check mark did not move.
    expect(screen.getAllByRole("button", { name: /claude sonnet 5/i }).length).toBe(2);
    expect(screen.queryByRole("button", { name: /^claude opus 5\.6/i })).toBeNull();
  });

  it("adds the model to the profile with one update, keeps the menu open, and redraws without the row", async () => {
    const { user, api, menu } = await openWithNewModel({
      [`PATCH ${NEW_MODEL_PATH}`]: { body: withNewModelAdded(profile) },
    });

    await user.click(within(menu).getByRole("button", { name: "Add Claude Opus 5.6" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Add Claude Opus 5.6" })).toBeNull();
    });
    const updates = readUpdates(api);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body).toMatchObject({
      expectedRevision: profile.revision,
      accounts: [
        {
          providerAccountId: ACCOUNT_A.id,
          entries: [
            { model: "claude-sonnet-5" },
            { model: "claude-opus-5" },
            { model: NEW_MODEL_SLUG, harnessId: null },
          ],
        },
      ],
    });
    // The menu is open, the model is now a pickable entry, and nothing was picked.
    const open = screen.getByRole("dialog");
    expect(within(open).getByRole("button", { name: /claude opus 5\.6/i })).toBeDefined();
    expect(screen.getAllByRole("button", { name: /claude sonnet 5/i }).length).toBeGreaterThan(0);
  });

  it("hides the model with one update when Not now is pressed, and keeps the menu open", async () => {
    const { user, api, menu } = await openWithNewModel({
      [`PATCH ${NEW_MODEL_PATH}`]: {
        body: {
          ...profile,
          revision: profile.revision + 1,
          accounts: profile.accounts.map((section) => ({ ...section, newModels: [] })),
          dismissedNewModels: [{ providerAccountId: ACCOUNT_A.id, model: NEW_MODEL_SLUG }],
        },
      },
    });

    const dismiss = within(menu).getByRole("button", { name: /not now/i });
    expect(dismiss.getAttribute("title")).toBe("Not now");
    await user.click(dismiss);

    await waitFor(() => {
      expect(screen.queryByText("Claude Opus 5.6")).toBeNull();
    });
    const updates = readUpdates(api);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body).toMatchObject({
      dismissedNewModels: [{ providerAccountId: ACCOUNT_A.id, model: NEW_MODEL_SLUG }],
    });
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("disables the buttons of the New rows while a save runs", async () => {
    let finish: () => void = () => undefined;
    const { user, menu } = await openWithNewModel({
      [`PATCH ${NEW_MODEL_PATH}`]: () =>
        new Promise((resolve) => {
          finish = () => {
            resolve({ body: withNewModelAdded(profile) });
          };
        }),
    });

    await user.click(within(menu).getByRole("button", { name: "Add Claude Opus 5.6" }));

    await waitFor(() => {
      const buttons = [
        within(menu).getByRole("button", { name: "Add Claude Opus 5.6" }),
        within(menu).getByRole("button", { name: /not now/i }),
      ];
      expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    });
    finish();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Add Claude Opus 5.6" })).toBeNull();
    });
  });

  it("shows the controller's refusal under the lane, keeps the row, and lets the user try again", async () => {
    const { user, menu } = await openWithNewModel({
      [`PATCH ${NEW_MODEL_PATH}`]: {
        status: 400,
        body: buildErrorBody("validation", "The profile cannot hold more models."),
      },
    });

    await user.click(within(menu).getByRole("button", { name: "Add Claude Opus 5.6" }));

    const alert = await within(menu).findByRole("alert");
    expect(alert.textContent).toBe("The profile cannot hold more models.");
    const add = within(menu).getByRole("button", { name: "Add Claude Opus 5.6" });
    expect((add as HTMLButtonElement).disabled).toBe(false);
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
      [ACCOUNT_A],
      {},
      { "POST /api/v1/sessions": { body: NEW_SESSION } },
      buildRecentStorage([]),
    );

    await pickOpusAndSend(user);

    await waitFor(() => {
      expect(localStorage.getItem(RECENT_KEY)).toBe(
        JSON.stringify([
          {
            providerAccountId: ACCOUNT_A.id,
            harnessId: "claude-code/claude-code",
            model: "claude-opus-5",
          },
        ]),
      );
    });
  });

  it("writes nothing when the spawn fails, because no thread was started", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(
      [ACCOUNT_A],
      {},
      {
        "POST /api/v1/sessions": {
          status: 409,
          body: buildErrorBody("invalid_state", "moss is not signed in to Anthropic"),
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

/** An account with one model, which has a select descriptor and a boolean one. */
const WITH_OPTIONS = buildProviderAccount(
  "01a06d02-1000-7000-8000-000000000016",
  "personal",
  ANTHROPIC,
  [
    buildSnapshot(RUNNER.id, "rogier@example.com", "Claude Max", [
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        imageInput: { maxBytes: null },
        isDefault: true,
        options: [EFFORT, FAST_MODE],
      },
    ]),
  ],
);

describe("Composer: the model options selector's label", () => {
  it("shows the effort choice's label, updates on a pick, and adds a bolt when fast mode is on", async () => {
    const user = userEvent.setup();
    await openApp([WITH_OPTIONS]);

    // "Medium" is the label of the descriptor's default, `medium`.
    const selector = await screen.findByRole("button", { name: "Medium" });

    await user.click(selector);
    const menu = await screen.findByRole("dialog");
    // The header shows what is being changed, and for which model.
    expect(readPageText(menu)).toContain("Model options");
    expect(readPageText(menu)).toContain("Claude Sonnet 5");

    await user.click(within(menu).getByRole("radio", { name: "High" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "High" })).toBeDefined();
    });

    await user.click(within(menu).getByRole("radio", { name: "on" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "High ⚡" })).toBeDefined();
    });
  });
});

/**
 * An account whose harness does not support `auto`, so `auto` runs as the
 * nearest supported mode below it. The account is labelled "Work", so its name
 * is "Anthropic · Work", yet the fallback note must name the harness "Claude
 * Code": it reads the harness definition, not the account.
 */
const NO_AUTO: ProviderAccount = { ...ACCOUNT_A, label: "Work" };

/** The harness list with Claude Code declaring no native `auto`. */
const HARNESSES_WITHOUT_AUTO: Readonly<Record<string, Handler>> = {
  "GET /api/v1/harnesses": {
    body: HARNESSES.map((harness) =>
      harness.id === "claude-code/claude-code"
        ? {
            ...harness,
            declared: {
              ...harness.declared,
              accessModes: { ...harness.declared.accessModes, auto: "unsupported" },
            },
          }
        : harness,
    ),
  },
};

describe("Composer: the access mode menu", () => {
  it("lists four modes with no header, and shows the fallback of a mode that is not native", async () => {
    const user = userEvent.setup();
    await openApp([NO_AUTO], {}, HARNESSES_WITHOUT_AUTO);

    await user.click(screen.getByRole("button", { name: /approval required/i }));
    const menu = await screen.findByRole("dialog");

    // The rows are found by their text, not by their accessible name. The
    // name joins the mode and its meaning, so "Auto" would also match
    // "Auto-accept edits".
    for (const mode of ["Approval required", "Auto-accept edits", "Auto", "Full access"]) {
      expect(within(menu).getByText(mode, { exact: true })).toBeDefined();
    }
    // The four modes need no introduction, so this menu has no header.
    expect(readPageText(menu)).not.toContain("Access mode");

    // The unsupported mode keeps its row and can still be picked. The row
    // shows which mode it will actually run as.
    expect(readPageText(menu)).toContain("runs as Auto-accept edits on Claude Code");
    await user.click(within(menu).getByText("Auto", { exact: true }));
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Auto" })).toBeDefined();
  });

  /**
   * The fallback annotation names the harness that caused the
   * fallback, as in "runs as Auto-accept edits on pi". It is shown in the
   * attention color below the mode's meaning, which every row keeps.
   */
  it("shows each mode's meaning and names the harness in the fallback annotation, in the attention color", async () => {
    const user = userEvent.setup();
    await openApp([NO_AUTO], {}, HARNESSES_WITHOUT_AUTO);

    await user.click(screen.getByRole("button", { name: /approval required/i }));
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

    const annotation = within(menu).getByText("runs as Auto-accept edits on Claude Code");
    expect(annotation.className).toContain("text-attn");
    // The annotation names the harness, not a vague "this provider".
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
    await openApp([ACCOUNT_A]);

    const slash = await waitFor(() => screen.getByText("/"));
    expect(readPageText(slash.parentElement)).toBe("Threads / New thread");

    expect(screen.queryByRole("button", { name: "…" })).toBeNull();
    // The prompt "What should the agent do?" is an h2, and the shell's top bar
    // is hidden, so this route has no h1.
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Tests for the project picker and the workspace, branch and machine
 * selectors. They drive the app through `renderApp` and the stubbed
 * `fetch`, like the tests above.
 *
 * The spec sets the text of these controls but not how a test finds them.
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
  thread3f1: "01a06d02-7200-7000-8000-000000000002",
  thread3f1Checkout: "01a06d02-7300-7000-8000-000000000002",
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
) => ({
  checkoutId: id,
  resourceId,
  form,
  subdirectory: null,
  branch,
  branches,
  defaultBranch,
  remoteBranches: [],
  headCommit: null,
  baseCommit: null,
  startingRevision: null,
  baseBranch: null,
});

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
  ownership: "managed",
  retentionPolicy: "manual",
  path: null,
  observedAt: null,
  warnings: [],
  checkouts,
  designatedConnectionId: "01a06d02-7500-7000-8000-000000000001",
  message: null,
  sessionIds,
  keptUntil: null,
  createdAt: AT,
  provisionedAt: AT,
  lastUsedAt: AT,
  disposedAt: null,
});

/** webshop's main workspace on moss; `hercule/thread-3f1` is one of its branches. */
const W_PRIMARY_WEBSHOP: Workspace = {
  ...WORLD.PRIMARY,
  designatedConnectionId: GITHUB_ID,
  sessionIds: [BUMP_THE_BUN_PIN],
};

const W_THREAD_3F1: Workspace = { ...WORLD.THREAD_3F1, designatedConnectionId: GITHUB_ID };

const W_THREAD_8A0 = buildWorkspace(
  "01a06d02-7200-7000-8000-000000000003",
  "ephemeral",
  COVE.id,
  [
    buildCheckout(
      "01a06d02-7300-7000-8000-000000000003",
      R_WEBSHOP.id,
      "worktree",
      "hercule/thread-8a0",
      ["hercule/thread-8a0"],
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
  buildThread(IDS.flakyThread, "Fix flaky webhook tests", WEBSHOP.id, W_THREAD_3F1.id),
  buildThread(IDS.runbookThread, "Write the retry runbook", WEBSHOP.id, W_THREAD_3F1.id),
  buildThread(
    "01a06d02-7400-7000-8000-000000000003",
    "Runner drain command",
    WEBSHOP.id,
    W_THREAD_8A0.id,
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
  feedIntervals: {},
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
  W_THREAD_3F1,
  W_THREAD_8A0,
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
  ...Object.fromEntries(
    PROJECTS.map((project) => [`GET /api/v1/projects/${project.id}`, { body: project }]),
  ),
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
  user: Record<string, unknown> = { "thread.workspace": "primary" },
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(buildController([ACCOUNT_A], user, buildWorldRoutes(extra)));
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

  // The primary workspace is shown as "Use main workspace". None is not offered
  // when the project has a repo.
  it("offers the main workspace, a new worktree and the live workspaces", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    const menu = await openWorkspaceMenu(user);
    const text = readPageText(menu);

    expect(text).toContain("Use main workspace");
    expect(text).toContain("on main · you and the agent share the files");
    expect(text).toContain("New workspace");
    expect(text).toContain("a fresh worktree of webshop on a new branch");
    // The project's live ephemeral workspaces, named after their branch, with
    // their machine and the threads already in them.
    expect(text).toContain("hercule/thread-3f1");
    expect(text).toContain("moss");
    expect(text).toContain("2 threads · “Fix flaky webhook tests”, “Write the retry runbook”");
    expect(text).toContain("hercule/thread-8a0");
    expect(text).not.toContain("No workspace");
  });

  it("shows the repo on each row and lists New workspace first in a multi-repo project", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(OPS.id));

    const menu = await openWorkspaceMenu(user);
    const text = readPageText(menu);

    expect(text).toContain("a worktree of each repo, side by side, each on a new branch");
    expect(text).toContain("Use main workspace of ops-infra");
    expect(text).toContain("Use main workspace of ops-runbooks");
    expect(text.indexOf("New workspace")).toBeLessThan(text.indexOf("Use main workspace of"));
  });

  it("checks the clone on the machine the draft would be placed on, not on the picked one", async () => {
    const user = userEvent.setup();
    // `ACCOUNT_FRESH` is on no machine, so no runner row is selectable and
    // the draft picks no runner. The draft would still be placed on moss,
    // which holds webshop's main workspace. The menu must check moss;
    // otherwise it would say the repo is not cloned on a machine the user
    // never saw.
    const api = stubApi(buildController([ACCOUNT_FRESH], {}, buildWorldRoutes()));
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

    expect(readPageText(menu)).toContain(
      "shares the main working files on moss · prepares on first use",
    );
  });

  // A project with no source works in no workspace, and the tooltip explains
  // how to change that.
  it("shows No workspace as locked text in a project with no repo", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(SANDBOX.id));

    const locked = await screen.findByTitle("Add a repository to the project to work in one");
    expect(readPageText(locked)).toContain("No workspace");
    expect(locked.closest("button")).toBeNull();

    await user.click(locked);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("defaults coding projects to new workspaces regardless of repository count", async () => {
    const one = await openDraftAt(buildProjectDraftPath(WEBSHOP.id), {});
    expect(await screen.findByRole("button", { name: /^workspace New workspace$/ })).toBeDefined();
    one.unmount();

    await openDraftAt(buildProjectDraftPath(OPS.id), {});
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
        "It gets its own worktree of webshop, on a new branch from remote default.",
      );
    });

    await openWorkspaceMenu(user);
    await pickRow(user, /hercule\/thread-3f1/);
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
      { "thread.workspace": "primary" },
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
      providerAccountId: ACCOUNT_A.id,
      harnessId: "claude-code/claude-code",
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
    await pickRow(user, /hercule\/thread-3f1/);

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
      workspace: { kind: "existing", workspaceId: W_THREAD_3F1.id },
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
    await openDraftAt(`/threads/new?project=${WEBSHOP.id}&workspace=${W_THREAD_3F1.id}`);

    expect(
      await screen.findByRole("button", { name: /^workspace hercule\/thread-3f1$/ }),
    ).toBeDefined();
  });
});

describe("Composer: the branch selector", () => {
  it("shows the actual main branch without offering to switch shared files", async () => {
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id));
    const branch = await screen.findByText("main", { selector: "span.truncate" });
    expect(branch.closest("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /release\/2\.4/ })).toBeNull();
  });

  it("offers explicit starting sources and updates the lead for a local branch", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(WEBSHOP.id), {});
    const menu = await openBranchMenu(user, /^remote default$/);
    expect(readPageText(menu)).toContain("Starting revision");
    expect(readPageText(menu)).toContain("Current working copy");
    expect(readPageText(menu)).toContain("Remote sources fetch before creating the new branch");
    await pickRow(user, /^Local branch: release\/2\.4/);
    expect(
      await screen.findByRole("button", { name: /^local branch release\/2\.4$/ }),
    ).toBeDefined();
    expect(readPageText()).toContain("on a new branch from local branch release/2.4.");
  });

  it("shows one starting revision per repository without a combined picker", async () => {
    await openDraftAt(buildProjectDraftPath(OPS.id), {});
    const label = await screen.findByText("remote default · remote default");
    expect(label.closest("button")).toBeNull();
  });

  it("allows managed remote creation while local sources are unavailable", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(EDGE.id), {});
    const menu = await openBranchMenu(user, /^remote default$/);
    expect(within(menu).getByRole("button", { name: /^Remote default/ })).toBeDefined();
    expect(within(menu).queryByRole("button", { name: /^Current working copy/ })).toBeNull();
  });

  it("is absent on a joined workspace, and on a draft with no workspace at all", async () => {
    const user = userEvent.setup();
    const joined = await openDraftAt(buildProjectDraftPath(WEBSHOP.id));

    await openWorkspaceMenu(user);
    await pickRow(user, /hercule\/thread-3f1/);
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
    await pickRow(user, /hercule\/thread-8a0/);

    const locked = await screen.findByText("set by the workspace hercule/thread-8a0");
    expect(locked.closest("button")).toBeNull();
    await user.click(locked);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a machine without the repo pickable, and explains that the repo is cloned on first use", async () => {
    const user = userEvent.setup();
    await openDraftAt(buildProjectDraftPath(EDGE.id));

    await user.click(await screen.findByRole("button", { name: /^machine moss/ }));
    const menu = await screen.findByRole("dialog");

    expect(readPageText(menu)).toContain(
      "edge-api has no main workspace there · prepares on first use",
    );
    // "not cloned" only means a wait, not a blocker, so the row stays a
    // button. The test checks moss, not cove: in this fixture cove is dimmed
    // for another reason (no account was ever probed there), and a
    // dimmed row is never clickable.
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
      "git@github.com:acme/new-error.git",
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

/** A model that takes no images, as pi reports a text-only model. */
const ACCOUNT_TEXT_ONLY = buildProviderAccount("01a06d02-1000-7000-8000-000000000004", null, ZAI, [
  buildSnapshot(RUNNER.id, "rogier@example.com", "Pi", [
    { slug: "glm-5.3", name: "GLM 5.3", imageInput: null, isDefault: true, options: [] },
  ]),
]);

const buildImage = (name: string, type = "image/png"): File =>
  new File([`bytes of ${name}`], name, { type });

/** Returns the attachment record the controller answers an upload of `name` with. */
const buildUploaded = (name: string, index: number) => ({
  id: `01a06d02-5000-7000-8000-00000000000${String(index)}`,
  name,
  mimeType: "image/png",
  sizeBytes: 12,
});

const readFilePicker = (): HTMLInputElement => {
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) throw new Error("The composer has no file picker.");
  return picker;
};

const readTileStrip = (name: string): string =>
  screen.getByRole("button", { name: `Preview ${name}` }).parentElement!.textContent;

describe("Composer: images", () => {
  it("uploads picked images at once, holds Send until they finish, and spawns with their ids in shelf order", async () => {
    const user = userEvent.setup();
    let finishSecond: (() => void) | undefined;
    const { api, router } = await openApp(
      [ACCOUNT_A],
      {},
      {
        "POST /api/v1/attachments": (call) =>
          call.search.includes("first.png")
            ? { status: 201, body: buildUploaded("first.png", 1) }
            : new Promise((resolve) => {
                finishSecond = () => {
                  resolve({ status: 201, body: buildUploaded("second.png", 2) });
                };
              }),
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    );

    await user.upload(readFilePicker(), [buildImage("first.png"), buildImage("second.png")]);

    await waitFor(() => {
      expect(readTileStrip("first.png")).toBe("");
    });
    expect(readTileStrip("second.png")).toBe("Uploading…");
    expect(screen.getByRole("status").textContent).toBe("Wait for the image to finish uploading.");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /send/i }).disabled).toBe(true);

    finishSecond?.();
    await waitFor(() => {
      expect(readTileStrip("second.png")).toBe("");
    });
    expect(screen.queryByRole("status")).toBeNull();

    // Images alone are a message: Send works with no text.
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${NEW_SESSION.id}`);
    });
    const spawn = api.calls.find(
      (call) => call.method === "POST" && call.path === "/api/v1/sessions",
    );
    expect(spawn?.body).toMatchObject({
      prompt: "",
      attachments: [buildUploaded("first.png", 1).id, buildUploaded("second.png", 2).id],
    });
  });

  it("marks a failed upload, and a retry uploads it again", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    await openApp(
      [ACCOUNT_A],
      {},
      {
        "POST /api/v1/attachments": () => {
          attempts += 1;
          return attempts === 1
            ? { status: 500, body: buildErrorBody("internal", "The disk is full.") }
            : { status: 201, body: buildUploaded("shot.png", 1) };
        },
      },
    );

    await user.upload(readFilePicker(), [buildImage("shot.png")]);

    await waitFor(() => {
      expect(readTileStrip("shot.png")).toBe("Failed");
    });
    expect(screen.getByRole("status").textContent).toBe(
      "An image failed to upload. Retry it or remove it.",
    );

    await user.click(screen.getByRole("button", { name: "Retry upload for shot.png" }));

    await waitFor(() => {
      expect(readTileStrip("shot.png")).toBe("");
    });
    expect(attempts).toBe(2);
  });

  it("marks the image the controller swept when a send refuses it as expired", async () => {
    const user = userEvent.setup();
    await openApp(
      [ACCOUNT_A],
      {},
      {
        "POST /api/v1/attachments": { status: 201, body: buildUploaded("old.png", 1) },
        "POST /api/v1/sessions": {
          status: 400,
          body: {
            error: {
              code: "validation",
              message: "This image expired; attach it again.",
              details: {
                issues: [
                  { path: ["attachments", "0"], message: "This image expired; attach it again." },
                ],
              },
            },
          },
        },
      },
    );

    await user.upload(readFilePicker(), [buildImage("old.png")]);
    await waitFor(() => {
      expect(readTileStrip("old.png")).toBe("");
    });
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(readTileStrip("old.png")).toBe("Expired");
    });
    expect(screen.getByRole("status").textContent).toBe("This image expired; attach it again.");
  });

  it("refuses images for a model that does not accept them, and says why", async () => {
    const { api } = await openApp([ACCOUNT_TEXT_ONLY]);

    const attach = await screen.findByRole<HTMLButtonElement>("button", { name: "Attach images" });
    await waitFor(() => {
      expect(attach.title).toBe("GLM 5.3 does not accept images");
    });
    expect(attach.disabled).toBe(true);

    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [buildImage("pasted.png")] },
    });

    expect(screen.getByRole("status").textContent).toContain("does not accept images");
    expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
    expect(api.calls.some((call) => call.path === "/api/v1/attachments")).toBe(false);
  });

  it("shows the drop target while files are dragged over the card, and refuses a file that is not an image", async () => {
    await openApp([ACCOUNT_A]);
    const box = screen.getByRole("textbox");
    const dataTransfer = { types: ["Files"], files: [buildImage("notes.txt", "text/plain")] };

    fireEvent.dragEnter(box, { dataTransfer });
    expect(screen.getByText("Drop images to attach")).toBeDefined();

    fireEvent.drop(box, { dataTransfer });

    expect(screen.queryByText("Drop images to attach")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      '"notes.txt" is not an image Hercule can send. Attach a PNG, JPEG, GIF or WebP image.',
    );
  });
});

describe("the draft's search params", () => {
  it("drops a project and a workspace that are not strings", async () => {
    const { router } = await openDraftAt("/threads/new?project=42&workspace=true");

    expect(router.state.matches.at(-1)!.search).toEqual({});
  });
});

describe("Composer: the model menu as an accordion of profiles", () => {
  const MAIN_PROFILE = buildMainProfile([ACCOUNT_A]);
  const WORK_PROFILE: ModelProfile = {
    ...buildMainProfile([ACCOUNT_B]),
    id: "01a06d02-4900-7000-8000-000000000002",
    name: "Work",
  };
  const LAST_OPEN_KEY = "hercule.lastOpenModelProfile";

  const openWithProfiles = async (
    path: string,
    {
      extra = {},
      storage = {},
      user = {},
    }: {
      readonly extra?: Readonly<Record<string, Handler>>;
      readonly storage?: Readonly<Record<string, string>>;
      readonly user?: Record<string, unknown>;
    } = {},
  ) => {
    const api = stubApi(
      buildController(
        [ACCOUNT_A, ACCOUNT_B],
        { "thread.workspace": "primary", ...user },
        buildWorldRoutes({
          "GET /api/v1/model-profiles": { body: [MAIN_PROFILE, WORK_PROFILE] },
          ...extra,
        }),
      ),
    );
    const app = await renderApp({
      path,
      api: api.fetch,
      token: "held",
      detectLocalRunner: () => Promise.resolve(RUNNER.id),
      storage,
    });
    return { ...app, api };
  };

  it("unfolds the profile that holds the current entry, and a click on another head unfolds that one instead without changing the model", async () => {
    const user = userEvent.setup();
    await openWithProfiles("/threads/new");

    const menu = await openModelMenu(user, /claude sonnet 5/i);
    expect(within(menu).getByRole("button", { name: "Main" }).ariaExpanded).toBe("true");
    expect(within(menu).getByRole("button", { name: "Work" }).ariaExpanded).toBe("false");
    expect(within(menu).queryByRole("button", { name: /claude haiku 5/i })).toBeNull();

    await user.click(within(menu).getByRole("button", { name: "Work" }));

    expect(within(menu).getByRole("button", { name: "Work" }).ariaExpanded).toBe("true");
    expect(within(menu).getByRole("button", { name: "Main" }).ariaExpanded).toBe("false");
    expect(within(menu).getByRole("button", { name: /claude haiku 5/i })).toBeDefined();
    expect(within(menu).queryByRole("button", { name: /claude sonnet 5/i })).toBeNull();
    // Opening a head picked nothing, so the pill still shows the model it had.
    expect(
      screen.getByRole("button", { name: /^Anthropic · personal Claude Sonnet 5/ }),
    ).toBeDefined();
    expect(localStorage.getItem(LAST_OPEN_KEY)).toBe(WORK_PROFILE.id);
  });

  it("unfolds the profile open last when no profile holds the current entry", async () => {
    const user = userEvent.setup();
    await openWithProfiles("/threads/new", {
      storage: { [LAST_OPEN_KEY]: WORK_PROFILE.id },
      // A stored model that no profile holds is still the user's choice.
      user: {
        "thread.providerAccountId": ACCOUNT_A.id,
        "thread.harnessId": "claude-code/claude-code",
        "thread.model": "claude-ghost",
      },
    });

    const menu = await openModelMenu(user, /claude-ghost/i);
    expect(within(menu).getByRole("button", { name: "Work" }).ariaExpanded).toBe("true");
    expect(within(menu).getByRole("button", { name: "Main" }).ariaExpanded).toBe("false");
  });

  it("starts a thread in a project on the project's profile, and spawns with that entry", async () => {
    const user = userEvent.setup();
    const webshop: Project = { ...WEBSHOP, modelProfileId: WORK_PROFILE.id };
    const { api } = await openWithProfiles(buildProjectDraftPath(webshop.id), {
      extra: {
        "GET /api/v1/projects": { body: { items: [webshop, OPS, EDGE, SANDBOX] } },
        [`GET /api/v1/projects/${webshop.id}`]: { body: webshop },
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    });

    const menu = await openModelMenu(user, /claude haiku 5/i);
    expect(within(menu).getByRole("button", { name: "Work" }).ariaExpanded).toBe("true");
    expect(within(menu).getByRole("button", { name: /claude haiku 5/i }).textContent).toContain(
      "✓",
    );
    await user.keyboard("{Escape}");

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
      providerAccountId: ACCOUNT_B.id,
      harnessId: "claude-code/claude-code",
      model: "claude-haiku-5",
    });
  });

  // The project list stops at its first page, so a project beyond it is not
  // in it. The draft reads the addressed project itself.
  it("starts a project missing from the project list on that project's profile", async () => {
    const user = userEvent.setup();
    const webshop: Project = { ...WEBSHOP, modelProfileId: WORK_PROFILE.id };
    const { api } = await openWithProfiles(buildProjectDraftPath(webshop.id), {
      extra: {
        "GET /api/v1/projects": { body: { items: [OPS, EDGE, SANDBOX] } },
        [`GET /api/v1/projects/${webshop.id}`]: { body: webshop },
        "POST /api/v1/sessions": { body: NEW_SESSION },
      },
    });

    await openModelMenu(user, /claude haiku 5/i);
    await user.keyboard("{Escape}");
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
    expect(spawn?.body).toMatchObject({ model: "claude-haiku-5" });
  });

  it("shows the read's error and offers no composer when the project cannot be read", async () => {
    const { api } = await openWithProfiles(buildProjectDraftPath(WEBSHOP.id), {
      extra: {
        [`GET /api/v1/projects/${WEBSHOP.id}`]: {
          status: 500,
          body: buildErrorBody("internal", "the project could not be read"),
        },
      },
    });

    expect(await screen.findByText("This screen did not load")).toBeDefined();
    expect(readPageText()).toContain("the project could not be read");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      api.calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions"),
    ).toBe(false);
  });
});
