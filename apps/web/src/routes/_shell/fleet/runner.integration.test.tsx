/**
 * Tests for the runner page, against a stubbed controller.
 *
 * This page is where a runner is changed, so each test checks both what the
 * page shows and what requests the browser sends when the user acts. Retiring
 * cannot be undone, so its tests check the confirmation question and that
 * nothing is sent until the user answers it.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatAge, formatStamp } from "@hercule/client-core";
import type { ProviderSecretField, Session } from "@hercule/contract";
import {
  buildErrorBody,
  expectInDocumentOrder,
  readCurrentNavItems,
  readPageText,
  renderApp,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";
import {
  CONTROLLER_VERSION,
  GIB,
  MOSS as MACHINE,
  buildSessionFixture,
  ZONE,
  type Fixture,
} from "./-fixtures";

/** The runner the page is opened on, offline since it was last seen. */
const MOSS: Fixture = { ...MACHINE, connectivity: "offline", maxConcurrentSessions: 7 };

/** The same runner, online, which the actions that reach the machine need. */
const ONLINE: Fixture = { ...MOSS, connectivity: "online" };

/** A runner the controller cannot reach, so retiring it is forced. */
const LOST: Fixture = { ...MOSS, connectivity: "unreachable" };

const BARE: Fixture = {
  ...ONLINE,
  facts: { ...ONLINE.facts!, providers: [{ name: "claude", present: false }] },
};

/** Provider declarations every instance needs; this page does not test them. */
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

interface Snapshot {
  readonly runnerId: string;
  readonly probedAt: string;
  readonly harnessVersion: string | null;
  readonly versionVerdict: string;
  readonly auth: Readonly<Record<string, string>>;
  readonly models: ReadonlyArray<{ slug: string; name: string; options: readonly never[] }>;
}

const buildProviderInstance = (
  id: string,
  providerId: string,
  displayName: string,
  snapshots: readonly Snapshot[],
) => ({
  id,
  providerId,
  name: displayName,
  config: {},
  displayName,
  binaryName: providerId === "claude-code" ? "claude" : providerId,
  declared: DECLARED,
  secretFields: [] as ReadonlyArray<ProviderSecretField>,
  snapshots,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

const buildModel = (slug: string, name: string) => ({ slug, name, options: [] as const });

const buildSnapshot = (fields: Partial<Snapshot> & Pick<Snapshot, "auth">): Snapshot => ({
  runnerId: MOSS.id,
  probedAt: "2026-09-05T09:14:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  models: [buildModel("default", "Default"), buildModel("claude-opus-4-8", "Opus 4.8")],
  ...fields,
});

const LOGGED_IN = buildSnapshot({
  auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
});

const NOT_LOGGED_IN = buildSnapshot({ auth: { status: "unauthenticated" }, models: [] });

const NO_ADAPTER = buildSnapshot({
  harnessVersion: null,
  versionVerdict: "unknown",
  auth: { status: "error", message: "no adapter for codex in this runner build" },
  models: [],
});

const CLAUDE_ID = "01a06d02-1000-7000-8000-000000000001";
const CODEX_ID = "01a06d02-1000-7000-8000-000000000002";

const buildClaudeCodeInstance = (snapshots: readonly Snapshot[]) =>
  buildProviderInstance(CLAUDE_ID, "claude-code", "Claude Code", snapshots);

const CODEX = buildProviderInstance(CODEX_ID, "codex", "Codex", [NO_ADAPTER]);

const INSTANCES = [buildClaudeCodeInstance([LOGGED_IN]), CODEX];

/** Builds a stub controller that returns its own record, `runner`, and the handlers in `extra`. */
const buildController = (
  runner: Fixture,
  options: {
    readonly defaultRunnerId?: string | null;
    readonly instances?: ReadonlyArray<ReturnType<typeof buildProviderInstance>>;
    readonly extra?: Readonly<Record<string, Handler>>;
  } = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/providers": { body: options.instances ?? INSTANCES },
  "GET /api/v1/setup": { body: { complete: true } },
  // The shell's thread list reads this on every page; the session tests
  // override it with a real list.
  "GET /api/v1/sessions": { body: { items: [] } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: ZONE },
    },
  },
  "GET /api/v1/controller": {
    body: {
      id: "01a06d02-a000-7000-8000-000000000001",
      publicKey: "bm90LWEta2V5",
      version: CONTROLLER_VERSION,
      defaultRunnerId: options.defaultRunnerId ?? null,
    },
  },
  [`GET /api/v1/runners/${runner.id}`]: { body: runner },
  ...options.extra,
});

const openApp = async (
  runner: Fixture,
  options: {
    readonly defaultRunnerId?: string | null;
    readonly instances?: ReadonlyArray<ReturnType<typeof buildProviderInstance>>;
    readonly extra?: Readonly<Record<string, Handler>>;
  } = {},
) => {
  const api = stubApi(buildController(runner, options));
  const app = await renderApp({ path: `/fleet/${runner.id}`, api: api.fetch, token: "held" });
  return { ...app, api };
};

/** Returns the writes this page sent for the runner `id`, in order. */
const listWritesTo = (api: { readonly calls: readonly Call[] }, id: string) =>
  api.calls.filter(
    (call) => call.method !== "GET" && call.path.startsWith(`/api/v1/runners/${id}`),
  );

/** Checks whether `text` shows `bytes` as a whole number of GiB, as all the fixtures are. */
const showsSize = (text: string, bytes: number): boolean =>
  new RegExp(`(^|[^\\d.])${(bytes / 1024 ** 3).toFixed(0)} ?GiB`).test(text);

/** Returns the runner's name field. */
const getNameField = () => screen.getByLabelText<HTMLInputElement>(/name/i);

/** Returns the "personal machine" checkbox. */
const getReservedField = () => screen.getByRole("checkbox", { name: /personal machine|reserved/i });

/** Checks whether a control is ticked, through `aria-checked` or `checked`. */
const isTicked = (control: HTMLElement): boolean =>
  control.getAttribute("aria-checked") === "true" || (control as HTMLInputElement).checked;

/**
 * Returns the smallest element that holds both `message` and `field`. The
 * message is beside its field when that element holds no other field.
 */
const findMessageGroup = (message: HTMLElement, field: HTMLElement): HTMLElement => {
  let group: HTMLElement = message;
  while (group.parentElement !== null && !group.contains(field)) {
    group = group.parentElement;
  }
  return group;
};

const getActionButton = (name: RegExp) => screen.getByRole("button", { name });

describe("Runner", () => {
  // A runner's page is under the Fleet path, so the sidebar highlights Fleet.
  it("highlights Fleet in the sidebar", async () => {
    await openApp(MOSS);
    await waitFor(() => {
      expect(readPageText()).toContain(MOSS.name);
    });

    expect(readCurrentNavItems()).toEqual(["Fleet"]);
  });

  it("shows the runner's status, its probed facts and its editable fields", async () => {
    await openApp(MOSS);

    const shown = await waitFor(() => {
      const text = readPageText();
      expect(text).toContain(MOSS.name);
      return text;
    });

    // Both the lifecycle and the connectivity. The page shows every fact, so
    // even the ordinary lifecycle is shown rather than left to be guessed
    // from the actions on offer.
    expect(shown).toContain(MOSS.lifecycle);
    expect(shown).toContain(MOSS.connectivity);
    // A runner that is not connected shows when it was last seen.
    expect(shown).toMatch(/last seen/i);
    expect(shown).toContain(formatStamp(new Date(MOSS.lastSeenAt!), ZONE)!);

    // The facts it probed about itself.
    expect(shown).toContain(MOSS.facts!.os);
    expect(shown).toContain(MOSS.facts!.arch);
    expect(shown).toContain("2.50.1");
    expect(showsSize(shown, MOSS.facts!.totalMemoryBytes), `memory in: ${shown}`).toBe(true);

    expect(getNameField().value).toBe(MOSS.name);
    expect(isTicked(getReservedField())).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>(/session/i).value).toBe(
      String(MOSS.maxConcurrentSessions),
    );
    expect(screen.getByLabelText<HTMLInputElement>(/disk watermark/i).value).toBe(
      String(MOSS.diskWatermarkBytes / GIB),
    );
  });

  it("ticks the personal machine checkbox for a reserved runner", async () => {
    await openApp({ ...MOSS, reserved: true });

    await waitFor(() => {
      expect(isTicked(getReservedField())).toBe(true);
    });
  });
});

describe("Runner > saving", () => {
  /** Returns a handler that responds to a patch with `runner` updated by that patch. */
  const applyPatch = (runner: Fixture) => (call: Call) => ({
    body: { ...runner, ...(call.body as Record<string, unknown>) },
  });

  it("sends only the changed fields, and shows that the save worked", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(MOSS, {
      extra: { [`PATCH /api/v1/runners/${MOSS.id}`]: applyPatch(MOSS) },
    });

    await waitFor(() => {
      expect(getNameField().value).toBe(MOSS.name);
    });
    // Nothing has changed, so there is no patch to send and Save is disabled.
    expect(getActionButton(/^save$/i).hasAttribute("disabled")).toBe(true);

    await user.clear(getNameField());
    await user.type(getNameField(), "moss-2");
    await user.click(getActionButton(/^save$/i));

    expect((await screen.findByRole("status")).textContent).toMatch(/saved/i);
    expect(listWritesTo(api, MOSS.id)).toHaveLength(1);
    expect(listWritesTo(api, MOSS.id)[0]?.body).toEqual({ name: "moss-2" });

    // The saved name is now the baseline, so the next patch holds only the checkbox.
    await user.click(getReservedField());
    await user.click(getActionButton(/^save$/i));

    await waitFor(() => {
      expect(listWritesTo(api, MOSS.id)).toHaveLength(2);
    });
    expect(listWritesTo(api, MOSS.id)[1]?.body).toEqual({ reserved: true });
  });

  it("shows a rejected name's error beside the name field", async () => {
    const user = userEvent.setup();
    const complaint = "another runner is already called hetzner-01";
    const { api } = await openApp(MOSS, {
      extra: {
        [`PATCH /api/v1/runners/${MOSS.id}`]: {
          status: 409,
          body: buildErrorBody("conflict", complaint),
        },
      },
    });

    await waitFor(() => {
      expect(getNameField().value).toBe(MOSS.name);
    });
    await user.clear(getNameField());
    await user.type(getNameField(), "hetzner-01");
    await user.click(getActionButton(/^save$/i));

    const shown = await screen.findByText(new RegExp(complaint));
    const group = findMessageGroup(shown, getNameField());
    expect(group.contains(getNameField())).toBe(true);
    expect(group.contains(getReservedField())).toBe(false);
    expect(listWritesTo(api, MOSS.id)).toHaveLength(1);
  });

  it("shows a rejected reserved flag's error beside the checkbox", async () => {
    const user = userEvent.setup();
    const complaint = "the default runner cannot be reserved";
    await openApp(MOSS, {
      defaultRunnerId: MOSS.id,
      extra: {
        [`PATCH /api/v1/runners/${MOSS.id}`]: {
          status: 409,
          body: buildErrorBody("conflict", complaint),
        },
      },
    });

    await waitFor(() => {
      expect(isTicked(getReservedField())).toBe(false);
    });
    await user.click(getReservedField());
    await user.click(getActionButton(/^save$/i));

    const shown = await screen.findByText(new RegExp(complaint));
    const group = findMessageGroup(shown, getReservedField());
    expect(group.contains(getReservedField())).toBe(true);
    expect(group.contains(getNameField())).toBe(false);
  });
});

describe("Runner > actions", () => {
  it("drains the runner and shows that it is draining", async () => {
    const user = userEvent.setup();
    const draining: Fixture = { ...ONLINE, lifecycle: "draining" };
    const { api } = await openApp(ONLINE, {
      extra: { [`POST /api/v1/runners/${ONLINE.id}/drain`]: { body: draining } },
    });

    await user.click(await screen.findByRole("button", { name: /^drain$/i }));

    await waitFor(() => {
      expect(readPageText()).toContain("draining");
    });
    expect(listWritesTo(api, ONLINE.id).map((call) => call.path)).toEqual([
      `/api/v1/runners/${ONLINE.id}/drain`,
    ]);
  });

  it("undrains a draining runner", async () => {
    const user = userEvent.setup();
    const draining: Fixture = { ...ONLINE, lifecycle: "draining" };
    const { api } = await openApp(draining, {
      extra: { [`POST /api/v1/runners/${draining.id}/undrain`]: { body: ONLINE } },
    });

    await user.click(await screen.findByRole("button", { name: /^undrain$/i }));

    await waitFor(() => {
      expect(readPageText()).not.toContain("draining");
    });
    expect(listWritesTo(api, draining.id).map((call) => call.path)).toEqual([
      `/api/v1/runners/${draining.id}/undrain`,
    ]);
  });

  it("asks the runner to probe its machine again and shows the new facts", async () => {
    const user = userEvent.setup();
    const probed: Fixture = {
      ...ONLINE,
      facts: { ...ONLINE.facts!, totalMemoryBytes: 32 * GIB, arch: "x64" },
    };
    const { api } = await openApp(ONLINE, {
      extra: { [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: { body: probed } },
    });

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));

    await waitFor(() => {
      expect(readPageText()).toContain("x64");
    });
    expect(showsSize(readPageText(), 32 * GIB), `the new memory in: ${readPageText()}`).toBe(true);
    expect(listWritesTo(api, ONLINE.id).map((call) => call.path)).toEqual([
      `/api/v1/runners/${ONLINE.id}/refresh-facts`,
    ]);
  });

  it("does not send a field the owner never edited after a re-probe changed it", async () => {
    // The derived session cap follows the machine's memory, so a re-probe
    // changes it while the form is open. Saving must never send that number
    // back: the controller would store it as an override, and no control
    // anywhere can undo one.
    const user = userEvent.setup();
    const probed: Fixture = {
      ...ONLINE,
      facts: { ...ONLINE.facts!, totalMemoryBytes: 8 * GIB },
      maxConcurrentSessions: 4,
    };
    const { api } = await openApp(ONLINE, {
      // The response to a patch is the whole updated runner, cap included.
      extra: {
        [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: { body: probed },
        [`PATCH /api/v1/runners/${ONLINE.id}`]: (call: Call) => ({
          body: { ...probed, ...(call.body as Record<string, unknown>) },
        }),
      },
    });

    await waitFor(() => {
      expect(getNameField().value).toBe(ONLINE.name);
    });
    await user.clear(getNameField());
    await user.type(getNameField(), "moss-2");

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));

    // The re-probe changed the cap, but a form with unsaved edits is not
    // overwritten, so the name field still holds the user's edit.
    await waitFor(() => {
      expect(readPageText()).toContain("8 GiB");
    });
    expect(getNameField().value).toBe("moss-2");

    await user.click(getActionButton(/^save$/i));
    await screen.findByRole("status");

    // Only the name. The user did not edit the cap, so it is not sent.
    const first = listWritesTo(api, ONLINE.id).filter((call) => call.method === "PATCH");
    expect(first).toHaveLength(1);
    expect(first[0]?.body).toEqual({ name: "moss-2" });

    // The save responded with the whole runner, so the form now shows the cap
    // derived after the re-probe rather than the one it opened with.
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(/session/i).value).toBe("4");
    });

    // The next patch is measured against the save's response, so nothing is
    // left to send and Save is disabled.
    expect(getActionButton(/^save$/i).hasAttribute("disabled")).toBe(true);
    await user.click(getActionButton(/^save$/i));
    expect(listWritesTo(api, ONLINE.id).filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("shows the error of a failed action", async () => {
    const user = userEvent.setup();
    const complaint = "the runner did not answer within 10s";
    const { api } = await openApp(ONLINE, {
      extra: {
        [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: {
          status: 409,
          body: buildErrorBody("invalid_state", complaint),
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));

    expect((await screen.findByRole("alert")).textContent).toContain(complaint);
    expect(listWritesTo(api, ONLINE.id)).toHaveLength(1);
  });

  it("clears a failed action's error once another action succeeds", async () => {
    const user = userEvent.setup();
    const complaint = "the runner did not answer within 10s";
    await openApp(ONLINE, {
      extra: {
        [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: {
          status: 409,
          body: buildErrorBody("invalid_state", complaint),
        },
        [`POST /api/v1/runners/${ONLINE.id}/drain`]: {
          body: { ...ONLINE, lifecycle: "draining" },
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));
    expect((await screen.findByRole("alert")).textContent).toContain(complaint);

    await user.click(getActionButton(/^drain$/i));

    // The drain worked, so the earlier error no longer applies. Leaving it on
    // screen would make it look as if the drain had failed.
    await waitFor(() => {
      expect(readPageText()).toContain("draining");
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(readPageText()).not.toContain(complaint);
  });
});

describe("Runner > retiring", () => {
  const buildRetiredRunner = (runner: Fixture): Fixture => ({ ...runner, lifecycle: "retired" });

  it("asks for confirmation before it retires, and sends nothing until the user answers", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(ONLINE, {
      extra: { [`POST /api/v1/runners/${ONLINE.id}/retire`]: { body: buildRetiredRunner(ONLINE) } },
    });

    await user.click(await screen.findByRole("button", { name: /^retire$/i }));
    expect(listWritesTo(api, ONLINE.id)).toEqual([]);
    // Cancel comes before Confirm.
    expectInDocumentOrder([getActionButton(/^cancel$/i), getActionButton(/^confirm$/i)]);

    // Cancelling leaves the runner as it was.
    await user.click(getActionButton(/^cancel$/i));
    expect(listWritesTo(api, ONLINE.id)).toEqual([]);
    expect(readPageText()).not.toContain("retired");

    await user.click(await screen.findByRole("button", { name: /^retire$/i }));
    await user.click(getActionButton(/^confirm$/i));

    await waitFor(() => {
      expect(readPageText()).toContain("retired");
    });
    const sent = listWritesTo(api, ONLINE.id);
    expect(sent.map((call) => call.path)).toEqual([`/api/v1/runners/${ONLINE.id}/retire`]);
    // A reachable runner is not force-retired.
    expect((sent[0]?.body as { force?: boolean } | undefined)?.force).not.toBe(true);
  });

  it("warns that retiring an unreachable runner forces it, and sends force", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(LOST, {
      extra: { [`POST /api/v1/runners/${LOST.id}/retire`]: { body: buildRetiredRunner(LOST) } },
    });

    await user.click(await screen.findByRole("button", { name: /^retire$/i }));

    expect(readPageText()).toContain("This runner is unreachable; retiring it now forces it");

    await user.click(getActionButton(/^confirm$/i));

    await waitFor(() => {
      expect(listWritesTo(api, LOST.id)).toHaveLength(1);
    });
    expect(listWritesTo(api, LOST.id)[0]?.body).toEqual({ force: true });
  });

  // buildRetireQuestion's unit test covers the exact wording of the
  // default-runner warning, the case with no warning, and every combination.
  // Only the unreachable case runs through the browser, because it must also
  // check that `force: true` is sent.

  it("shows no actions for a retired runner", async () => {
    await openApp(buildRetiredRunner(MOSS));

    await waitFor(() => {
      expect(readPageText()).toContain("retired");
    });
    const page = within(document.body);
    for (const move of [/^drain$/i, /^undrain$/i, /^retire$/i, /refresh facts/i]) {
      expect(page.queryByRole("button", { name: move }), `${String(move)} is offered`).toBeNull();
    }
  });
});

describe("Runner > providers", () => {
  const AUTHORIZE_URL = "https://claude.ai/oauth/authorize?code=challenge";

  const INVALID = "Invalid code. Please make sure the full code was copied.";

  const findInstanceRow = (name: string): Promise<HTMLElement> =>
    screen.findByRole("group", { name });

  const findClaudeRow = () => findInstanceRow("Claude Code");

  it("shows what each instance last reported on this machine", async () => {
    await openApp(ONLINE);

    const claude = readPageText(await findClaudeRow());
    expect(claude).toContain("2.1.263");
    expect(claude).toContain("rogier@example.com");
    expect(claude).toContain("Claude Max");
    expect(claude).toMatch(/2 models/i);
    // A version inside the tested range gets no remark.
    expect(claude).not.toMatch(/below|above|untested/i);

    expect(readPageText(await findInstanceRow("Codex"))).toContain("no adapter");
  });

  it("marks a harness older than the version this build was tested with", async () => {
    await openApp(ONLINE, {
      instances: [
        buildClaudeCodeInstance([
          buildSnapshot({
            harnessVersion: "2.0.9",
            versionVerdict: "below-floor",
            auth: LOGGED_IN.auth,
          }),
        ]),
        CODEX,
      ],
    });

    const claude = readPageText(await findClaudeRow());
    expect(claude).toContain("2.0.9");
    expect(claude).toMatch(/below/i);
  });

  it("offers Log in again and Probe now for a harness on the machine", async () => {
    await openApp(ONLINE);

    const claude = within(await findClaudeRow());
    expect(claude.getByRole("button", { name: /log in again/i })).toBeDefined();
    expect(claude.getByRole("button", { name: /probe now/i })).toBeDefined();
    // No Install button: the machine reported the binary.
    expect(claude.queryByRole("button", { name: /install/i })).toBeNull();
  });

  it("offers to install a missing harness, and disables Install for a provider with no adapter", async () => {
    await openApp(BARE, { instances: [buildClaudeCodeInstance([]), CODEX] });

    const claude = within(await findClaudeRow());
    expect(claude.getByRole("button", { name: /install/i }).hasAttribute("disabled")).toBe(false);
    // No Log in button until the harness is on the machine.
    expect(claude.queryByRole("button", { name: /log in/i })).toBeNull();

    const codexRow = await findInstanceRow("Codex");
    const codex = within(codexRow);
    expect(codex.getByRole("button", { name: /install/i }).hasAttribute("disabled")).toBe(true);
    // The reason is shown up front, rather than found out when an install fails.
    expect(readPageText(codexRow)).toMatch(/no adapter/i);
  });

  it("logs in through the dialog and shows the account the machine then reports", async () => {
    const user = userEvent.setup();
    let held = [buildClaudeCodeInstance([NOT_LOGGED_IN]), CODEX];
    const { api } = await openApp(ONLINE, {
      instances: held,
      extra: {
        "GET /api/v1/providers": () => ({ body: held }),
        [`POST /api/v1/providers/${CLAUDE_ID}/login`]: { body: { url: AUTHORIZE_URL } },
        [`POST /api/v1/providers/${CLAUDE_ID}/login-code`]: (call: Call) => {
          if ((call.body as { code: string }).code !== "the-whole-code") {
            return { status: 400, body: buildErrorBody("validation", INVALID) };
          }
          held = [buildClaudeCodeInstance([LOGGED_IN]), CODEX];
          return { body: LOGGED_IN };
        },
        // Every finished login is followed by a probe, so the page shows the
        // account the machine now holds.
        [`POST /api/v1/runners/${ONLINE.id}/probe`]: () => ({ body: LOGGED_IN }),
      },
    });

    await user.click(within(await findClaudeRow()).getByRole("button", { name: /log in/i }));

    // The URL is shown on this screen so the user can open it wherever they
    // like: the machine running the harness may have no browser at all.
    await waitFor(() => {
      expect(readPageText()).toContain(AUTHORIZE_URL);
    });
    // The page also names the site the user will sign in at, because that is
    // the one part of a long opaque URL they can check first.
    expect(readPageText()).toContain("You will sign in at claude.ai");
    expect(api.calls.filter((call) => call.path.endsWith("/login"))[0]?.body).toEqual({
      runnerId: ONLINE.id,
    });

    const getCodeField = () => screen.getByLabelText<HTMLInputElement>("Code", { exact: true });
    await user.type(getCodeField(), "half-a-code");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect((await screen.findByText(new RegExp(INVALID))).textContent).toContain("Invalid code");
    await user.clear(getCodeField());
    await user.type(getCodeField(), "the-whole-code");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Code", { exact: true })).toBeNull();
    });
    await waitFor(() => {
      expect(readPageText()).toContain("rogier@example.com");
    });
  });

  it("finishes a device-code login without a pasted code, then probes the machine", async () => {
    const user = userEvent.setup();
    let held = [buildClaudeCodeInstance([NOT_LOGGED_IN]), CODEX];
    const { api } = await openApp(ONLINE, {
      instances: held,
      extra: {
        "GET /api/v1/providers": () => ({ body: held }),
        [`POST /api/v1/providers/${CLAUDE_ID}/login`]: {
          body: { url: AUTHORIZE_URL, userCode: "CH61-0FI2N" },
        },
        [`POST /api/v1/runners/${ONLINE.id}/probe`]: () => {
          held = [buildClaudeCodeInstance([LOGGED_IN]), CODEX];
          return { body: LOGGED_IN };
        },
      },
    });

    await user.click(within(await findClaudeRow()).getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(readPageText()).toContain("CH61-0FI2N");
    });
    // The user finishes this login with the vendor in their browser, then
    // presses Done to tell Hercule.
    await user.click(screen.getByRole("button", { name: "Done" }));

    // The credential is on the machine but the stored snapshot is older, so
    // the account only appears after the machine is probed again.
    await waitFor(() => {
      expect(readPageText()).toContain("rogier@example.com");
    });
    const asked = api.calls.filter((call) => call.path.endsWith("/probe"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toEqual({ instanceId: CLAUDE_ID });
    expect(api.calls.filter((call) => call.path.endsWith("/login-code"))).toEqual([]);
  });

  it("probes one instance on demand and shows the result", async () => {
    const user = userEvent.setup();
    const fresh = buildSnapshot({ harnessVersion: "2.1.300", auth: LOGGED_IN.auth });
    let held = INSTANCES;
    const { api } = await openApp(ONLINE, {
      extra: {
        "GET /api/v1/providers": () => ({ body: held }),
        [`POST /api/v1/runners/${ONLINE.id}/probe`]: () => {
          held = [buildClaudeCodeInstance([fresh]), CODEX];
          return { body: fresh };
        },
      },
    });

    await user.click(within(await findClaudeRow()).getByRole("button", { name: /probe now/i }));

    await waitFor(() => {
      expect(readPageText()).toContain("2.1.300");
    });
    const asked = api.calls.filter((call) => call.path.endsWith("/probe"));
    // Only that instance, not all of the machine's: the button is on its row.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toEqual({ instanceId: CLAUDE_ID });
  });

  it("fetches the card again when a snapshot changes elsewhere", async () => {
    let held = INSTANCES;
    const { live } = await openApp(ONLINE, {
      extra: { "GET /api/v1/providers": () => ({ body: held }) },
    });

    await waitFor(() => {
      expect(live.topics()).toContain("provider");
    });
    held = [
      buildClaudeCodeInstance([buildSnapshot({ harnessVersion: "2.1.300", auth: LOGGED_IN.auth })]),
      CODEX,
    ];
    act(() => {
      live.push("provider", { _tag: "invalidate", ids: [CLAUDE_ID], kind: "updated" });
    });

    await waitFor(() => {
      expect(readPageText()).toContain("2.1.300");
    });
  });
});

describe("Runner > sessions", () => {
  /** A runner with two session slots, so a queue can form. */
  const TWO: Fixture = { ...ONLINE, maxConcurrentSessions: 2 };

  const buildTimestampMinutesAgo = (minutes: number): string =>
    new Date(Date.now() - minutes * 60_000).toISOString();

  const RUNNING = buildSessionFixture({
    id: "01a06d02-2000-7000-8000-00000000000a",
    title: "Fix the login bug",
    status: "busy",
    at: buildTimestampMinutesAgo(200),
  });

  /** Listed out of order in the fixture, so any ordering on screen comes from the page. */
  const WAITED_LESS = buildSessionFixture({
    id: "01a06d02-2000-7000-8000-00000000000c",
    title: "Write the changelog",
    status: "queued",
    at: buildTimestampMinutesAgo(5),
  });

  const WAITED_LONGEST = buildSessionFixture({
    id: "01a06d02-2000-7000-8000-00000000000b",
    title: "Investigate the flaky test",
    status: "queued",
    at: buildTimestampMinutesAgo(130),
  });

  /**
   * Returns a `session.query` handler that filters `sessions` by the request's
   * `runnerId` and `status` parameters. It filters rather than returning a
   * fixed body, so the page may fetch the runner's sessions in one request or
   * one request per status.
   */
  const buildSessionListingHandler = (sessions: () => readonly Session[]) => (call: Call) => {
    const asked = new URLSearchParams(call.search);
    const runnerId = asked.get("runnerId");
    // The status parameter may repeat, because the page asks for several
    // statuses (running and queued) in one request.
    const statuses = asked.getAll("status");
    return {
      body: {
        items: sessions().filter(
          (each) =>
            (runnerId === null || each.runnerId === runnerId) &&
            (statuses.length === 0 || statuses.includes(each.status)),
        ),
      },
    };
  };

  /** Returns the main content's text, without the shell's thread list. */
  const readMainText = () => readPageText(screen.getByRole("main"));

  /** Returns every session list request the browser has made. */
  const listSessionReads = (api: { readonly calls: readonly Call[] }) =>
    api.calls.filter((call) => call.method === "GET" && call.path === "/api/v1/sessions");

  const openAppWithSessions = (runner: Fixture, sessions: () => readonly Session[]) =>
    openApp(runner, { extra: { "GET /api/v1/sessions": buildSessionListingHandler(sessions) } });

  it("shows how full the runner is and lists the sessions waiting for a slot", async () => {
    const held = [RUNNING, WAITED_LESS, WAITED_LONGEST];
    await openAppWithSessions(TWO, () => held);

    await waitFor(() => {
      expect(readMainText()).toContain("1 running of 2 · 2 queued");
    });

    const shown = readMainText();
    // Oldest first: the session that has waited longest starts next, and a
    // newest-first list would suggest the opposite.
    expect(shown.indexOf(WAITED_LONGEST.title)).toBeGreaterThan(-1);
    expect(shown.indexOf(WAITED_LONGEST.title)).toBeLessThan(shown.indexOf(WAITED_LESS.title));

    // Each row shows how long it has waited, formatted like every other age
    // in the app.
    expect(shown).toContain(formatAge(WAITED_LONGEST.createdAt, new Date()));
    expect(shown).toContain(formatAge(WAITED_LESS.createdAt, new Date()));

    // The rows list only queued sessions. The line above already counts the
    // running session, and listing it would make it look like it is waiting.
    expect(shown).not.toContain(RUNNING.title);
  });

  it("shows the queue as soon as the page opens", async () => {
    // The loader fetches the sessions, so nothing below the route suspends:
    // the reader never sees the facts appear while the capacity is blank.
    const held = [RUNNING, WAITED_LESS, WAITED_LONGEST];
    await openAppWithSessions(TWO, () => held);

    expect(readMainText()).toContain("1 running of 2 · 2 queued");
  });

  it("shows only how full the runner is when nothing is queued", async () => {
    const held = [RUNNING];
    await openAppWithSessions(TWO, () => held);

    await waitFor(() => {
      expect(readMainText()).toContain("1 running of 2");
    });
    expect(readMainText()).not.toMatch(/queued/i);
    expect(readMainText()).not.toContain(RUNNING.title);
  });

  it("fetches the list again when a session changes elsewhere", async () => {
    let held: readonly Session[] = [RUNNING, WAITED_LESS, WAITED_LONGEST];
    const { api, live } = await openAppWithSessions(TWO, () => held);

    await waitFor(() => {
      expect(readMainText()).toContain("1 running of 2 · 2 queued");
    });
    await waitFor(() => {
      expect(live.topics()).toContain("session");
    });
    const before = listSessionReads(api).length;

    // The controller starts the session that has waited longest.
    held = [RUNNING, WAITED_LESS, { ...WAITED_LONGEST, status: "starting" }];
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [WAITED_LONGEST.id], kind: "updated" });
    });

    await waitFor(() => {
      expect(readMainText()).toContain("2 running of 2 · 1 queued");
    });
    // The page shows the change because it fetched the list again; the pushed
    // message does not carry the session.
    expect(listSessionReads(api).length).toBeGreaterThan(before);
    expect(readMainText()).not.toContain(WAITED_LONGEST.title);
  });
});

/**
 * Tests for a provider whose config has a secret field. The key is a paid
 * credential, so:
 *
 * - the field is masked;
 * - the key is written through `secret.set`, never through the instance;
 * - the row never reads the value back, only whether one is set.
 */
describe("Runner > a provider that needs a key", () => {
  const PI_ID = "01a06d02-1000-7000-8000-000000000003";
  const KEY_TITLE = "Z.ai API key";
  const KEY_DESCRIPTION = "From your Z.ai Coding Plan subscription.";
  const KEY_VALUE = "a-paid-credential-nobody-else-holds";

  const SECRET_PATH = `PUT /api/v1/secrets/provider-instance/${PI_ID}/zaiApiKey`;

  /** A runner with pi installed, so the pi row offers actions. */
  const WITH_PI: Fixture = {
    ...ONLINE,
    facts: {
      ...ONLINE.facts!,
      providers: [
        { name: "claude", present: true },
        { name: "pi", present: true },
      ],
      adapters: ["claude-code", "pi"],
    },
  };

  const PI_SNAPSHOT = buildSnapshot({
    harnessVersion: "0.85.1",
    auth: { status: "unauthenticated" },
    models: [],
  });

  const buildPiInstance = (set: boolean) => ({
    ...buildProviderInstance(PI_ID, "pi", "pi", [PI_SNAPSHOT]),
    secretFields: [{ name: "zaiApiKey", title: KEY_TITLE, description: KEY_DESCRIPTION, set }],
  });

  const findPiRow = () => screen.findByRole("group", { name: "pi" });

  /** Returns the requests that wrote the key. */
  const listKeyWrites = (api: { readonly calls: readonly Call[] }) =>
    api.calls.filter(
      (call) =>
        call.method === "PUT" &&
        call.path === `/api/v1/secrets/provider-instance/${PI_ID}/zaiApiKey`,
    );

  it("asks for the key in the plugin's own words, masked, and saves it as a secret", async () => {
    const user = userEvent.setup();
    let held: ReadonlyArray<ReturnType<typeof buildProviderInstance>> = [buildPiInstance(false)];
    const { api } = await openApp(WITH_PI, {
      instances: held,
      extra: {
        "GET /api/v1/providers": () => ({ body: held }),
        [SECRET_PATH]: () => {
          held = [buildPiInstance(true)];
          return {
            body: {
              ownerKind: "provider-instance",
              ownerId: PI_ID,
              name: "zaiApiKey",
              createdAt: "2026-09-19T09:00:00.000Z",
            },
          };
        },
        // The key is on the controller but the stored snapshot is older, so
        // the machine is probed again.
        [`POST /api/v1/runners/${WITH_PI.id}/probe`]: () => ({ body: PI_SNAPSHOT }),
      },
    });

    await user.click(
      within(await findPiRow()).getByRole("button", { name: new RegExp(KEY_TITLE, "i") }),
    );

    // The dialog holds just the field: the plugin's title is its heading, and
    // the plugin's description says where to get a key.
    const form = await screen.findByRole("dialog", { name: KEY_TITLE });
    expect(readPageText(form)).toContain(KEY_DESCRIPTION);

    const field = within(form).getByLabelText<HTMLInputElement>(KEY_TITLE, { exact: true });
    // A paid credential is never shown in plain text.
    expect(field.type).toBe("password");

    // The field is empty, so Save sends nothing: the form rejects it in the
    // browser, without a request.
    const save = within(form).getByRole("button", { name: /save/i });
    await user.click(save);
    expect(listKeyWrites(api)).toEqual([]);

    await user.type(field, KEY_VALUE);
    await user.click(within(form).getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(listKeyWrites(api)).toHaveLength(1);
    });
    expect(listKeyWrites(api)[0]?.body).toEqual({ value: KEY_VALUE });

    const listProbeCalls = () => api.calls.filter((call) => call.path.endsWith("/probe"));
    await waitFor(() => {
      expect(listProbeCalls()).toHaveLength(1);
    });
    expect(listProbeCalls()[0]?.body).toEqual({ instanceId: PI_ID });

    // The dialog closes, and the row now shows that the key is set and
    // offers to replace it.
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: KEY_TITLE })).toBeNull();
    });
    await waitFor(async () => {
      expect(
        within(await findPiRow()).getByRole("button", { name: `Replace ${KEY_TITLE}` }),
      ).toBeDefined();
    });
    // The value itself never comes back to the page.
    expect(readPageText()).not.toContain(KEY_VALUE);
  });

  it("offers to replace a key that is already set", async () => {
    await openApp(WITH_PI, { instances: [buildPiInstance(true)] });

    const row = within(await findPiRow());
    expect(row.getByRole("button", { name: `Replace ${KEY_TITLE}` })).toBeDefined();
    // The OAuth login is another provider's flow; pi has no vendor to redirect
    // to, so the row must not offer one.
    expect(row.queryByRole("button", { name: /^log in/i })).toBeNull();
  });
});
