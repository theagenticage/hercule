/**
 * Tests for Settings > Threads: the `thread.*` defaults that prefill the
 * composer, the workspace default, and their position above the Sidebar rows
 * control. The model default is one entry of the Model Profile. The GitHub
 * account select moved to Settings > Profile.
 */
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection, ModelProfile, Profile, ProviderAccount, Runner } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  ZAI_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
} from "@hercule/client-core/testing";
import {
  buildCatalogFields,
  buildErrorBody,
  renderApp,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";

const RUNNER_LOCAL: Runner = {
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

const RUNNER_OTHER: Runner = {
  ...RUNNER_LOCAL,
  id: "01a06d02-beff-7037-9f5b-042822015953",
  name: "cove",
};

const buildSnapshot = (
  runnerId: string,
  harnessId: string,
  models: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
) => ({
  runnerId,
  harnessId,
  probedAt: "2026-09-05T09:14:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok" as const,
  auth: { status: "ok" as const, identity: "rogier@example.com", planLabel: "Claude Max" },
  models: models.map((model) => ({ ...model, imageInput: { maxBytes: null }, options: [] })),
});

const buildAccount = (
  identity: typeof ANTHROPIC_IDENTITY,
  label: string | null,
  snapshots: ProviderAccount["snapshots"],
): ProviderAccount => ({
  id: identity.id,
  providerId: identity.providerId,
  kind: identity.kind,
  label,
  identity: null,
  planLabel: null,
  defaultHarnessId: identity.harnessId,
  expiresAt: null,
  usage: [],
  failure: null,
  snapshots,
  ...buildCatalogFields(snapshots),
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

const IDENTITY_LOCAL = { ...ANTHROPIC_IDENTITY, id: "01a06d02-1000-7000-8000-000000000001" };
const IDENTITY_WORK = { ...ANTHROPIC_IDENTITY, id: "01a06d02-1000-7000-8000-000000000002" };
const IDENTITY_NEW = { ...ANTHROPIC_IDENTITY, id: "01a06d02-1000-7000-8000-000000000003" };
const IDENTITY_ZAI = { ...ZAI_IDENTITY, id: "01a06d02-1000-7000-8000-000000000004" };

/** An account signed in on the local runner, with two models. */
const ACCOUNT_LOCAL = buildAccount(IDENTITY_LOCAL, null, [
  buildSnapshot(RUNNER_LOCAL.id, "claude-code/claude-code", [
    { slug: "claude-sonnet-5", name: "Sonnet 5" },
    { slug: "claude-opus-5", name: "Opus 5" },
  ]),
]);

/** An account signed in on another runner only. */
const ACCOUNT_WORK: ProviderAccount = {
  ...buildAccount(IDENTITY_WORK, "work", [
    buildSnapshot(RUNNER_OTHER.id, "claude-code/claude-code", [
      { slug: "claude-haiku-5", name: "Haiku 5" },
    ]),
  ]),
  readiness: [
    { harnessId: "claude-code/claude-code", runnerId: RUNNER_OTHER.id, state: "not-signed-in" },
  ],
};

/** An account added a moment ago, whose models are still being read. */
const ACCOUNT_NEW = buildAccount(IDENTITY_NEW, "new", []);

/** An API key account that runs in pi. */
const ACCOUNT_ZAI = buildAccount(IDENTITY_ZAI, null, [
  buildSnapshot(RUNNER_LOCAL.id, "pi/pi", [{ slug: "glm-5", name: "GLM-5" }]),
]);

const ACCOUNTS: readonly ProviderAccount[] = [
  ACCOUNT_LOCAL,
  ACCOUNT_WORK,
  ACCOUNT_NEW,
  ACCOUNT_ZAI,
];

const SONNET = buildProfileEntry(IDENTITY_LOCAL, "claude-sonnet-5", { name: "Sonnet 5" });
const OPUS = buildProfileEntry(IDENTITY_LOCAL, "claude-opus-5", { name: "Opus 5" });
/** Cannot run now: the account is signed out on the runner it would use. */
const HAIKU = buildProfileEntry(IDENTITY_WORK, "claude-haiku-5", {
  name: "Haiku 5",
  problem: { reason: "not-signed-in", message: "not signed in on cove" },
});
const GLM = buildProfileEntry(IDENTITY_ZAI, "glm-5", { name: "GLM-5" });

/** The one Model Profile: Sonnet 5 is its default entry. */
const MAIN: ModelProfile = buildModelProfile(
  [
    buildProfileSection(IDENTITY_LOCAL, [SONNET, OPUS]),
    buildProfileSection(IDENTITY_WORK, [HAIKU]),
    buildProfileSection(IDENTITY_NEW, "pending"),
    buildProfileSection(IDENTITY_ZAI, [GLM]),
  ],
  {
    id: "01a06d02-4000-7000-8000-000000000001",
    defaultEntry: {
      providerAccountId: IDENTITY_LOCAL.id,
      model: "claude-sonnet-5",
      harnessId: null,
    },
  },
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
  id: "01a06d02-3000-7000-8000-000000000002",
  name: "worker",
  grants: [],
  shipped: true,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
};

const PROFILES: readonly Profile[] = [PROFILE_UNRESTRICTED, PROFILE_WORKER];

const STORED_BASE = {
  "onboarding.completedSteps": ["timezone", "assistant"],
  timezone: "Europe/Amsterdam",
  "thread.providerAccountId": ACCOUNT_LOCAL.id,
  "thread.harnessId": "claude-code/claude-code",
  "thread.model": "claude-sonnet-5",
  "thread.accessMode": "approval-required",
  "thread.profileId": PROFILE_UNRESTRICTED.id,
};

/** Builds a stub controller that responds to `settings.update` with the settings after the patch. */
const buildController = (
  user: Record<string, unknown>,
  options: { readonly update?: Handler; readonly modelProfiles?: readonly ModelProfile[] } = {},
): Readonly<Record<string, Handler>> => {
  const stored = { controller: {}, user: { ...STORED_BASE, ...user } };
  const applyPatch = (call: Call) => ({
    body: {
      controller: {},
      user: { ...stored.user, ...(call.body as { user: Record<string, unknown> }).user },
    },
  });
  return {
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": { body: stored },
    "PATCH /api/v1/settings": options.update ?? applyPatch,
    "GET /api/v1/provider-accounts": { body: ACCOUNTS },
    "GET /api/v1/model-profiles": { body: options.modelProfiles ?? [MAIN] },
    "GET /api/v1/runners": { body: { items: [RUNNER_LOCAL, RUNNER_OTHER] } },
    "GET /api/v1/profiles": { body: { items: PROFILES } },
  };
};

const openApp = async (
  user: Record<string, unknown> = {},
  options: Parameters<typeof buildController>[1] = {},
) => {
  const api = stubApi(buildController(user, options));
  const app = await renderApp({
    path: "/settings/threads",
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(RUNNER_LOCAL.id),
  });
  return { ...app, api };
};

const listWrites = (api: { readonly calls: readonly Call[] }) =>
  api.calls.filter((call) => call.method === "PATCH");

const findModelField = () => screen.findByLabelText<HTMLSelectElement>("Model");

const listOffered = (field: HTMLSelectElement) =>
  [...field.options].map((option) => option.textContent);

describe("Settings > Threads defaults", () => {
  it("offers one choice for each entry of the model profile, an account and a model, with the stored entry selected", async () => {
    await openApp();

    const field = await findModelField();

    // The account whose models are still being read has no entry yet.
    expect(listOffered(field)).toEqual([
      "Anthropic · Sonnet 5",
      "Anthropic · Opus 5",
      "Anthropic · work · Haiku 5 (not signed in on cove)",
      "Z.ai · GLM-5",
    ]);
    expect(field.selectedOptions[0]?.textContent).toBe("Anthropic · Sonnet 5");
  });

  it("offers no separate account choice, and says a project's own profile starts there", async () => {
    await openApp();

    await findModelField();

    expect(screen.queryByLabelText("Account")).toBeNull();
    expect(screen.getByText("A project with its own model profile starts there.")).toBeDefined();
  });

  it("writes thread.providerAccountId, thread.harnessId and thread.model together on pick", async () => {
    const user = userEvent.setup();
    const { api } = await openApp();

    await user.selectOptions(await findModelField(), "Anthropic · Opus 5");

    expect(await screen.findByRole("status")).toBeDefined();
    // One patch, so the account, the harness and the model are never saved apart.
    expect(listWrites(api)).toHaveLength(1);
    expect(listWrites(api)[0]?.body).toEqual({
      user: {
        "thread.providerAccountId": ACCOUNT_LOCAL.id,
        "thread.harnessId": "claude-code/claude-code",
        "thread.model": "claude-opus-5",
      },
    });
  });

  it("writes the entry's harness when it runs in another harness than its account's", async () => {
    const user = userEvent.setup();
    const claudeInPi = buildProfileEntry(IDENTITY_LOCAL, "claude-opus-5", {
      name: "Opus 5",
      harnessId: "pi/pi",
      resolvedHarnessId: "pi/pi",
    });
    const { api } = await openApp(
      {},
      {
        modelProfiles: [
          buildModelProfile([buildProfileSection(IDENTITY_LOCAL, [SONNET, claudeInPi])], {
            id: MAIN.id,
          }),
        ],
      },
    );

    await user.selectOptions(await findModelField(), "Anthropic · Opus 5 · in pi");

    expect(await screen.findByRole("status")).toBeDefined();
    expect(listWrites(api)[0]?.body).toEqual({
      user: {
        "thread.providerAccountId": ACCOUNT_LOCAL.id,
        "thread.harnessId": "pi/pi",
        "thread.model": "claude-opus-5",
      },
    });
  });

  it("shows the profile's default entry when no default was ever saved", async () => {
    await openApp({
      "thread.providerAccountId": undefined,
      "thread.harnessId": undefined,
      "thread.model": undefined,
    });

    const field = await findModelField();

    expect(field.selectedOptions[0]?.textContent).toBe("Anthropic · Sonnet 5");
  });

  it("shows the profile's default entry when the saved account was deleted", async () => {
    await openApp({ "thread.providerAccountId": "01a06d02-1000-7000-8000-00000000dead" });

    const field = await findModelField();

    expect(field.selectedOptions[0]?.textContent).toBe("Anthropic · Sonnet 5");
  });

  it("lets the user choose an entry that cannot run now, since a default outlives an offline machine", async () => {
    await openApp();

    const field = await findModelField();

    const haiku = [...field.options].find((option) => option.textContent?.includes("Haiku 5"));
    expect(haiku?.disabled).toBe(false);
    expect(haiku?.textContent).toBe("Anthropic · work · Haiku 5 (not signed in on cove)");
  });

  it("shows a stored entry the profile no longer holds, marked as not offered", async () => {
    await openApp({ "thread.model": "some-retired-slug" });

    const field = await findModelField();

    expect(listOffered(field)).toContain("Anthropic · some-retired-slug (not offered)");
    expect(field.selectedOptions[0]?.textContent).toBe(
      "Anthropic · some-retired-slug (not offered)",
    );
  });

  it("dims the model field when the profile holds no model yet", async () => {
    await openApp(
      {
        "thread.providerAccountId": undefined,
        "thread.harnessId": undefined,
        "thread.model": undefined,
      },
      {
        modelProfiles: [
          buildModelProfile([buildProfileSection(IDENTITY_NEW, "pending")], { id: MAIN.id }),
        ],
      },
    );

    expect(await screen.findByText("no models in your profile yet")).toBeDefined();
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("writes thread.accessMode when a different mode is picked on the segmented control", async () => {
    const user = userEvent.setup();
    const { api } = await openApp({ "thread.accessMode": "approval-required" });

    const group = await screen.findByRole("radiogroup", { name: /access mode/i });
    expect(within(group).getAllByRole("radio")).toHaveLength(4);

    await user.click(within(group).getByRole("radio", { name: "Auto" }));

    expect(await screen.findByRole("status")).toBeDefined();
    expect(listWrites(api)).toHaveLength(1);
    expect(listWrites(api)[0]?.body).toEqual({ user: { "thread.accessMode": "auto" } });
  });

  it("offers the profiles by name, and writes thread.profileId on pick", async () => {
    const user = userEvent.setup();
    const { api } = await openApp();

    const field = await screen.findByLabelText<HTMLSelectElement>("Profile");
    const offered = [...field.options].map((option) => option.textContent);
    for (const each of PROFILES) expect(offered).toContain(each.name);

    await user.selectOptions(field, PROFILE_WORKER.name);

    expect(await screen.findByRole("status")).toBeDefined();
    expect(listWrites(api)).toHaveLength(1);
    expect(listWrites(api)[0]?.body).toEqual({ user: { "thread.profileId": PROFILE_WORKER.id } });
  });

  it("shows a failed write's error message as the API sent it", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(
      {},
      {
        update: { status: 500, body: buildErrorBody("internal", "the settings table is locked") },
      },
    );

    const field = await screen.findByLabelText<HTMLSelectElement>("Profile");
    await user.selectOptions(field, PROFILE_WORKER.name);

    expect((await screen.findByRole("alert")).textContent).toBe("the settings table is locked");
    expect(listWrites(api)).toHaveLength(1);
  });

  it("places the model, access mode and profile fields above the existing Sidebar rows control", async () => {
    await openApp();

    const modelField = await findModelField();
    const accessGroup = screen.getByRole("radiogroup", { name: /access mode/i });
    const profileField = screen.getByLabelText("Profile");
    const sidebarRows = screen.getByRole("radiogroup", { name: "Sidebar rows" });

    const isBefore = (a: Element, b: Element): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    for (const field of [modelField, accessGroup, profileField]) {
      expect(isBefore(field, sidebarRows)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The workspace a new thread opens in (#72).
 *
 * The spec gives the copy for this control but not its stored values, so
 * these tests pin the choice made here: the Workspace control's two
 * options store these `thread.workspace` values: Main workspace ->
 * `primary`, New workspace -> `ephemeral`. There is no None option: a
 * project without a source always runs without a workspace, so nobody
 * picks it as a default.
 * ------------------------------------------------------------------ */

describe("Settings > Threads: the workspace a thread opens in", () => {
  it("offers the two options and writes thread.workspace on pick", async () => {
    const user = userEvent.setup();
    const { api } = await openApp({ "thread.workspace": "primary" });

    const group = await screen.findByRole("radiogroup", { name: "Workspace" });
    for (const face of ["Main workspace", "New workspace"]) {
      expect(within(group).getByRole("radio", { name: face })).toBeDefined();
    }
    // A project without a source always runs without a workspace, so None
    // is not a default anyone picks.
    expect(within(group).queryByRole("radio", { name: "None" })).toBeNull();

    await user.click(within(group).getByRole("radio", { name: "New workspace" }));

    expect(await screen.findByRole("status")).toBeDefined();
    expect(listWrites(api)).toHaveLength(1);
    expect(listWrites(api)[0]?.body).toEqual({ user: { "thread.workspace": "ephemeral" } });
  });

  // There is no None option, so the fine print is the only place that says a
  // project without a source runs without a workspace.
  it("says in its fine print that a project with no source runs without a workspace", async () => {
    await openApp();

    const fine = await screen.findByText(/When unset, coding threads/);
    expect(fine.textContent).toContain("A project with no source runs without a workspace.");
  });

  it("says in its fine print that a project with several repos opens in a New workspace", async () => {
    await openApp();

    const fine = await screen.findByText(/When unset, coding threads/);
    expect(fine.textContent).toContain("New workspace");
  });
});

const GITHUB: Connection = {
  id: "01a06d02-7500-7000-8000-000000000001",
  type: "github/github",
  label: "personal",
  displayName: "rogierpennink",
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: "2026-09-10T09:00:00.000Z",
  updatedAt: "2026-09-10T09:00:00.000Z",
};

describe("Settings > Threads: the GitHub account", () => {
  // The select moved to Settings > Profile, because it applies to an
  // assistant's sessions as well as to threads. A GitHub connection exists
  // here, so a select left behind would have an account to offer.
  it("no longer offers a GitHub account", async () => {
    const api = stubApi({
      ...buildController({}),
      "GET /api/v1/connections": { body: { items: [GITHUB] } },
    });
    await renderApp({
      path: "/settings/threads",
      api: api.fetch,
      token: "held",
      detectLocalRunner: () => Promise.resolve(RUNNER_LOCAL.id),
    });

    await screen.findByLabelText("Model");
    expect(screen.queryByRole("combobox", { name: /github/i })).toBeNull();
    expect(screen.queryByText(GITHUB.label)).toBeNull();
  });
});
