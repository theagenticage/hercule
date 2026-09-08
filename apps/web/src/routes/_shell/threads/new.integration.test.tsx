/**
 * The composer in new-thread mode over a stubbed controller: AC-15 to AC-18 of
 * `docs/plans/P009-thread-surface-and-composer/SPEC.md`, plus the AD-6 routing
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
 * - The checkout and branch selectors' own trigger, with no workspace picked,
 *   shows their field name ("Checkout", "Branch"); AC-16 pins their menu
 *   content ("no workspace") but not their trigger's own idle label.
 * - The model pill's effort segment is the chosen choice's `label` (e.g.
 *   "Medium"), not its `value` ("medium") - spec 14's own example
 *   ("claude-sonnet-5 · medium") is illustrative prose, not one of this
 *   SPEC's locked ACs, and "effort label" in AC-15's own wording points at
 *   the descriptor's `label` field.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelOption, Profile, ProviderInstance, Runner, Session } from "@hydra/contract";
import { envelope, renderApp, stubApi, type Handler } from "../../../app/testing";

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
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
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
) => {
  const api = stubApi(controller(instances, user, extra));
  const app = await renderApp({
    path: "/threads/new",
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(RUNNER.id),
  });
  return { ...app, api };
};

/** The page's text with its whitespace collapsed, the way a reader sees it. */
const reading = (element: HTMLElement | null = document.body): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("Composer: new-thread defaults (AC-15)", () => {
  it("prefills from the spawn defaults when no thread.* setting is stored", async () => {
    await open([INSTANCE_A]);

    expect(screen.getByRole("heading", { name: "What should the agent do?" })).toBeDefined();

    expect(screen.getByRole("textbox")).toBeDefined();

    const attach = screen.getByTitle<HTMLButtonElement>("attachments are not built");
    expect(attach.disabled).toBe(true);

    const voice = screen.getByTitle<HTMLButtonElement>("dictation is not built");
    expect(voice.disabled).toBe(true);

    // The model pill: displayName · instance name · slug · effort label.
    // claude-sonnet-5 is the default model and carries the effort option,
    // whose default choice "medium" labels "Medium".
    await waitFor(() => {
      expect(reading()).toContain("Claude Code · personal · claude-sonnet-5 · Medium");
    });

    expect(screen.getByRole("button", { name: /approval-required/i })).toBeDefined();

    expect(screen.getByText("No workspace")).toBeDefined();
    expect(screen.getByRole("button", { name: /checkout/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /branch/i })).toBeDefined();
    expect(screen.getByText(RUNNER.name)).toBeDefined();
    expect(screen.getByText(PROFILE_UNRESTRICTED.name)).toBeDefined();

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

    // claude-haiku-5 carries no options, so the pill has no effort segment.
    await waitFor(() => {
      expect(reading()).toContain("Claude Code · work · claude-haiku-5");
    });
    expect(screen.getByRole("button", { name: /^auto$/i })).toBeDefined();
    expect(screen.getByText(PROFILE_WORKER.name)).toBeDefined();
  });
});

describe("Composer: a fresh install, nothing logged in on the one runner yet", () => {
  it("shows the pill with only the parts it has, never a dangling separator, when there is no model to offer", async () => {
    await open([INSTANCE_FRESH]);

    // No model, so no third segment and no dangling " ·" left over from one.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Claude Code · Claude Code" })).toBeDefined();
    });
  });

  it("names the runner in its own trigger, dimmed with its reason, instead of the bare word Runner", async () => {
    await open([INSTANCE_FRESH]);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: `${RUNNER.name} · not logged in` })).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: "Runner" })).toBeNull();
  });

  it("shows the current instance's own dimmed reason in the model menu, with Log in beside it", async () => {
    const user = userEvent.setup();
    await open([INSTANCE_FRESH]);

    await user.click(await screen.findByRole("button", { name: "Claude Code · Claude Code" }));

    expect(await screen.findByText("found, not logged in")).toBeDefined();
    expect(screen.getByRole("button", { name: "Log in" })).toBeDefined();
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
    await user.click(screen.getByRole("button", { name: /claude-sonnet-5/i }));
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
    // "not built yet" is the dimmed reason on both placeholder entries.
    expect(reading().match(/not built yet/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("dims checkout and branch's one row with no workspace", async () => {
    const user = userEvent.setup();
    await open();

    // Scoped to the open menu itself: the workspace selector's own trigger
    // ("No workspace", case-insensitively the same text) is on the page the
    // whole time, so a page-wide query would find that too.
    await user.click(screen.getByRole("button", { name: /checkout/i }));
    expect(within(await screen.findByRole("dialog")).getByText(/no workspace/i)).toBeDefined();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: /branch/i }));
    expect(within(await screen.findByRole("dialog")).getByText(/no workspace/i)).toBeDefined();
  });
});

describe("Composer: model menu (AC-17)", () => {
  it("groups models per AC-8's rules and offers no free-text entry", async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole("button", { name: /claude-sonnet-5/i }));

    // Group headers: identity and plan for the picked runner's snapshot.
    expect(reading()).toContain("rogier@example.com");
    expect(reading()).toContain("Claude Max");

    // The current instance (A) expanded: both its models listed.
    expect(screen.getByRole("button", { name: /claude sonnet 5/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();

    // The other instance (B) collapsed to one row: "<n> models".
    expect(reading()).toContain("1 models");

    expect(screen.queryByText(/custom model/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/model/i)).toBeNull();
  });

  it("renders a select option as a segmented row and a boolean option as a checkbox", async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole("button", { name: /claude-sonnet-5/i }));

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
    expect(screen.getByRole("checkbox", { name: "Extended thinking" })).toBeDefined();
  });

  it("switches the pill's instance when a model of another instance is chosen", async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole("button", { name: /claude-sonnet-5/i }));
    // Instance B is collapsed to its one-row summary; clicking it is what
    // spec 14 §The composer calls "click to switch".
    await user.click(screen.getByRole("button", { name: /work.*1 models/i }));

    await waitFor(() => {
      expect(reading()).toContain("Claude Code · work · claude-haiku-5");
    });
  });

  it("changes the pill's effort label when an option is chosen", async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole("button", { name: /claude-sonnet-5/i }));
    // See the AC-17 "renders a select option..." test above: `SegmentedControl`
    // renders each choice `role="radio"`, not `role="button"`.
    await user.click(screen.getByRole("radio", { name: "High" }));

    await waitFor(() => {
      expect(reading()).toContain("Claude Code · personal · claude-sonnet-5 · High");
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
      profileId: PROFILE_UNRESTRICTED.id,
      workspaceId: null,
    });

    expect(
      api.calls.some((call) => call.method === "PATCH" && call.path === "/api/v1/settings"),
    ).toBe(false);
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
