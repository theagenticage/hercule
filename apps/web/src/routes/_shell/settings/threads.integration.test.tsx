/**
 * Settings > Threads defaults: the four `thread.*` fields that prefill the
 * composer, above the existing Sidebar rows control.
 */
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection, Profile, ProviderInstance, Runner } from "@hydra/contract";
import { envelope, renderApp, stubApi, type Call, type Handler } from "../../../app/testing";

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

const DECLARED = {
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
} as const;

const snapshot = (
  runnerId: string,
  models: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
) => ({
  runnerId,
  probedAt: "2026-09-05T09:14:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok" as const,
  auth: { status: "ok" as const, identity: "rogier@example.com", planLabel: "Claude Max" },
  models: models.map((model) => ({ ...model, options: [] })),
});

const instance = (
  id: string,
  displayName: string,
  snapshots: ProviderInstance["snapshots"],
): ProviderInstance => ({
  id,
  providerId: "claude-code",
  name: displayName,
  config: {},
  displayName,
  binaryName: "claude",
  declared: DECLARED,
  snapshots,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

/** Logged in on the local runner, offering two models. */
const INSTANCE_LOCAL = instance("01a06d02-1000-7000-8000-000000000001", "Claude Code", [
  snapshot(RUNNER_LOCAL.id, [
    { slug: "claude-sonnet-5", name: "Sonnet 5" },
    { slug: "claude-opus-5", name: "Opus 5" },
  ]),
]);

/** Never probed on the local runner, but has one snapshot from another one. */
const INSTANCE_ELSEWHERE = instance("01a06d02-1000-7000-8000-000000000002", "Claude Code (work)", [
  snapshot(RUNNER_OTHER.id, [{ slug: "claude-haiku-5", name: "Haiku 5" }]),
]);

/** Never probed anywhere. */
const INSTANCE_UNPROBED = instance("01a06d02-1000-7000-8000-000000000003", "Claude Code (new)", []);

const INSTANCES: readonly ProviderInstance[] = [
  INSTANCE_LOCAL,
  INSTANCE_ELSEWHERE,
  INSTANCE_UNPROBED,
];

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
  "onboarding.completedSteps": ["timezone"],
  timezone: "Europe/Amsterdam",
  "thread.instanceId": INSTANCE_LOCAL.id,
  "thread.model": "claude-sonnet-5",
  "thread.accessMode": "approval-required",
  "thread.profileId": PROFILE_UNRESTRICTED.id,
};

/** A controller that answers `settings.update` with the store the patch makes. */
const controller = (
  user: Record<string, unknown>,
  update?: Handler,
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
    "PATCH /api/v1/settings": update ?? applyPatch,
    "GET /api/v1/providers": { body: INSTANCES },
    "GET /api/v1/runners": { body: { items: [RUNNER_LOCAL, RUNNER_OTHER] } },
    "GET /api/v1/profiles": { body: { items: PROFILES } },
  };
};

const open = async (user: Record<string, unknown> = {}, update?: Handler) => {
  const api = stubApi(controller(user, update));
  const app = await renderApp({
    path: "/settings/threads",
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(RUNNER_LOCAL.id),
  });
  return { ...app, api };
};

const writes = (api: { readonly calls: readonly Call[] }) =>
  api.calls.filter((call) => call.method === "PATCH");

describe("Settings > Threads defaults", () => {
  it("offers the provider instances by display name, and writes thread.instanceId and thread.model together on pick", async () => {
    const user = userEvent.setup();
    const { api } = await open();

    const field = await screen.findByLabelText<HTMLSelectElement>("Provider instance");
    const offered = [...field.options].map((option) => option.textContent);
    for (const each of INSTANCES) expect(offered).toContain(each.displayName);

    await user.selectOptions(field, INSTANCE_ELSEWHERE.displayName);

    expect(await screen.findByRole("status")).toBeDefined();
    expect(writes(api)).toHaveLength(1);
    // One patch, not two: a stale model is only ever what the runner list
    // stops offering, never an artefact of switching instances. Its one
    // snapshot's one model, "Haiku 5", carries no `isDefault`, so it is the
    // fallback default.
    expect(writes(api)[0]?.body).toEqual({
      user: { "thread.instanceId": INSTANCE_ELSEWHERE.id, "thread.model": "claude-haiku-5" },
    });
  });

  it("writes only thread.instanceId when the newly picked instance has no snapshot to default from", async () => {
    const user = userEvent.setup();
    const { api } = await open();

    const field = await screen.findByLabelText<HTMLSelectElement>("Provider instance");
    await user.selectOptions(field, INSTANCE_UNPROBED.displayName);

    expect(await screen.findByRole("status")).toBeDefined();
    expect(writes(api)).toHaveLength(1);
    expect(writes(api)[0]?.body).toEqual({ user: { "thread.instanceId": INSTANCE_UNPROBED.id } });
  });

  it("offers the picked instance's models from the local runner's snapshot, and writes thread.model on pick", async () => {
    const user = userEvent.setup();
    const { api } = await open();

    const field = await screen.findByLabelText<HTMLSelectElement>("Model");
    const offered = [...field.options].map((option) => option.textContent);
    expect(offered).toContain("Sonnet 5");
    expect(offered).toContain("Opus 5");

    await user.selectOptions(field, "Opus 5");

    expect(await screen.findByRole("status")).toBeDefined();
    expect(writes(api)).toHaveLength(1);
    expect(writes(api)[0]?.body).toEqual({ user: { "thread.model": "claude-opus-5" } });
  });

  it("falls back to the instance's first snapshot when none is the local runner's", async () => {
    await open({
      "thread.instanceId": INSTANCE_ELSEWHERE.id,
      "thread.model": "claude-haiku-5",
    });

    // INSTANCE_ELSEWHERE has no snapshot for RUNNER_LOCAL (the detected local
    // runner); its one snapshot, from RUNNER_OTHER, is offered anyway.
    const field = await screen.findByLabelText<HTMLSelectElement>("Model");
    const offered = [...field.options].map((option) => option.textContent);
    expect(offered).toContain("Haiku 5");
  });

  it("dims the model field when the picked instance has no snapshot at all", async () => {
    await open({ "thread.instanceId": INSTANCE_UNPROBED.id, "thread.model": "claude-sonnet-5" });

    expect(await screen.findByText("log in on a runner first")).toBeDefined();
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("shows a stored slug the snapshot no longer offers, marked as not offered", async () => {
    await open({
      "thread.instanceId": INSTANCE_LOCAL.id,
      "thread.model": "some-retired-slug",
    });

    const field = await screen.findByLabelText<HTMLSelectElement>("Model");
    const retired = [...field.options].find((option) => option.value === "some-retired-slug");
    expect(retired).toBeDefined();
    expect(retired?.textContent).toBe("some-retired-slug (not offered)");
  });

  it("writes thread.accessMode when a different mode is picked on the segmented control", async () => {
    const user = userEvent.setup();
    const { api } = await open({ "thread.accessMode": "approval-required" });

    const group = await screen.findByRole("radiogroup", { name: /access mode/i });
    expect(within(group).getAllByRole("radio")).toHaveLength(4);

    await user.click(within(group).getByRole("radio", { name: "auto" }));

    expect(await screen.findByRole("status")).toBeDefined();
    expect(writes(api)).toHaveLength(1);
    expect(writes(api)[0]?.body).toEqual({ user: { "thread.accessMode": "auto" } });
  });

  it("offers the profiles by name, and writes thread.profileId on pick", async () => {
    const user = userEvent.setup();
    const { api } = await open();

    const field = await screen.findByLabelText<HTMLSelectElement>("Profile");
    const offered = [...field.options].map((option) => option.textContent);
    for (const each of PROFILES) expect(offered).toContain(each.name);

    await user.selectOptions(field, PROFILE_WORKER.name);

    expect(await screen.findByRole("status")).toBeDefined();
    expect(writes(api)).toHaveLength(1);
    expect(writes(api)[0]?.body).toEqual({ user: { "thread.profileId": PROFILE_WORKER.id } });
  });

  it("shows a refused write as the API worded it", async () => {
    const user = userEvent.setup();
    const { api } = await open(
      {},
      { status: 500, body: envelope("internal", "the settings table is locked") },
    );

    const field = await screen.findByLabelText<HTMLSelectElement>("Profile");
    await user.selectOptions(field, PROFILE_WORKER.name);

    expect((await screen.findByRole("alert")).textContent).toBe("the settings table is locked");
    expect(writes(api)).toHaveLength(1);
  });

  it("places the four thread fields above the existing Sidebar rows control", async () => {
    await open();

    const instanceField = await screen.findByLabelText("Provider instance");
    const modelField = screen.getByLabelText("Model");
    const accessGroup = screen.getByRole("radiogroup", { name: /access mode/i });
    const profileField = screen.getByLabelText("Profile");
    const sidebarRows = screen.getByRole("radiogroup", { name: "Sidebar rows" });

    const isBefore = (a: Element, b: Element): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    for (const field of [instanceField, modelField, accessGroup, profileField]) {
      expect(isBefore(field, sidebarRows)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Slice 3 of #72 (AC-22): what a thread opens in, and which GitHub
 * account a thread with no checkout acts through.
 *
 * Readings picked here, where the SPEC names copy but not a handle:
 * - the two faces of the Workspace control write the `thread.workspace`
 *   values they stand for: Main workspace -> `primary`, New workspace ->
 *   `ephemeral` (D-20d dropped None);
 * - the select's label is the row's own wording, "GitHub account for threads
 *   without a checkout".
 * ------------------------------------------------------------------ */

const CONNECTION_AT = "2026-09-10T09:00:00.000Z";

const GITHUB: Connection = {
  id: "01a06d02-7500-7000-8000-000000000001",
  type: "github/github",
  label: "personal",
  displayName: "rogierpennink",
  status: "connected",
  labels: [],
  config: {},
  credentials: [],
  createdAt: CONNECTION_AT,
  updatedAt: CONNECTION_AT,
};

const GITHUB_WORK: Connection = {
  ...GITHUB,
  id: "01a06d02-7500-7000-8000-000000000002",
  label: "work",
  displayName: "acme-bot",
};

/** A Connection of another type, which this select must not offer. */
const SLACK: Connection = {
  ...GITHUB,
  id: "01a06d02-7500-7000-8000-000000000003",
  type: "slack",
  label: "acme",
  displayName: "acme.slack.com",
};

const openWithConnections = async (
  user: Record<string, unknown> = {},
  connections: readonly Connection[] = [GITHUB, GITHUB_WORK, SLACK],
) => {
  const api = stubApi({
    ...controller(user),
    "GET /api/v1/connections": { body: { items: connections } },
  });
  const app = await renderApp({
    path: "/settings/threads",
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(RUNNER_LOCAL.id),
  });
  return { ...app, api };
};

describe("Settings > Threads: the workspace a thread opens in (AC-22)", () => {
  it("offers the two faces and writes thread.workspace on pick", async () => {
    const user = userEvent.setup();
    const { api } = await openWithConnections({ "thread.workspace": "primary" });

    const group = await screen.findByRole("radiogroup", { name: "Workspace" });
    for (const face of ["Main workspace", "New workspace"]) {
      expect(within(group).getByRole("radio", { name: face })).toBeDefined();
    }
    // D-20d: a project without a source always runs without a workspace, so
    // None is not a default anyone picks.
    expect(within(group).queryByRole("radio", { name: "None" })).toBeNull();

    await user.click(within(group).getByRole("radio", { name: "New workspace" }));

    expect(await screen.findByRole("status")).toBeDefined();
    expect(writes(api)).toHaveLength(1);
    expect(writes(api)[0]?.body).toEqual({ user: { "thread.workspace": "ephemeral" } });
  });

  // D-20d: the fine print is what says a project without a source runs
  // without a workspace, since there is no face for it any more.
  it("says in its fine print that a project with no source runs without a workspace", async () => {
    await openWithConnections();

    const fine = await screen.findByText(/repos/);
    expect(fine.textContent).toContain("A project with no source always runs without a workspace.");
  });

  it("says in its fine print that a project with several repos takes a new workspace anyway", async () => {
    await openWithConnections();

    const fine = await screen.findByText(/repos/);
    expect(fine.textContent).toContain("New workspace");
  });
});

describe("Settings > Threads: the GitHub account a checkout-less thread uses (AC-22)", () => {
  it("offers only the github connections and writes thread.githubConnectionId on pick", async () => {
    const user = userEvent.setup();
    const { api } = await openWithConnections();

    const field = await screen.findByLabelText<HTMLSelectElement>(
      "GitHub account for threads without a checkout",
    );
    const offered = [...field.options].map((option) => option.textContent);
    expect(offered).toContain(GITHUB.label);
    expect(offered).toContain(GITHUB_WORK.label);
    expect(offered).not.toContain(SLACK.label);

    await user.selectOptions(field, GITHUB_WORK.id);

    expect(await screen.findByRole("status")).toBeDefined();
    expect(writes(api)).toHaveLength(1);
    expect(writes(api)[0]?.body).toEqual({
      user: { "thread.githubConnectionId": GITHUB_WORK.id },
    });
  });

  it("clears the setting rather than storing an empty id when no account is picked", async () => {
    const user = userEvent.setup();
    const { api } = await openWithConnections({ "thread.githubConnectionId": GITHUB.id });

    const field = await screen.findByLabelText<HTMLSelectElement>(
      "GitHub account for threads without a checkout",
    );
    await user.selectOptions(field, "");

    expect(await screen.findByRole("status")).toBeDefined();
    expect(writes(api)[0]?.body).toEqual({ user: { "thread.githubConnectionId": null } });
  });
});
