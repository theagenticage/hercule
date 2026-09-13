/**
 * The runner page over a stubbed controller.
 *
 * This page is where a machine is changed, so each case asserts both
 * directions: what the reader is told, and what leaves the browser when they
 * act. Retire cannot be taken back, so it is held to the question it asks and
 * to sending nothing until that question is answered.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ageOf, formatStamp } from "@hydra/client-core";
import type { Session } from "@hydra/contract";
import {
  envelope,
  reading,
  renderApp,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";
import {
  CONTROLLER_VERSION,
  GIB,
  MOSS as MACHINE,
  sessionFixture,
  ZONE,
  type Fixture,
} from "./-fixtures";

/** The machine this page is opened on, away since it was last seen. */
const MOSS: Fixture = { ...MACHINE, connectivity: "offline", maxConcurrentSessions: 7 };

/** The same machine, connected, which is what the live moves need. */
const ONLINE: Fixture = { ...MOSS, connectivity: "online" };

/** A machine the controller has lost: retiring it is the case that forces. */
const LOST: Fixture = { ...MOSS, connectivity: "unreachable" };

const BARE: Fixture = {
  ...ONLINE,
  facts: { ...ONLINE.facts!, providers: [{ name: "claude", present: false }] },
};

/** What every provider declares about itself; none of it is this page's subject. */
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

const instance = (
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
  snapshots,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

const model = (slug: string, name: string) => ({ slug, name, options: [] as const });

const snapshot = (fields: Partial<Snapshot> & Pick<Snapshot, "auth">): Snapshot => ({
  runnerId: MOSS.id,
  probedAt: "2026-09-05T09:14:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  models: [model("default", "Default"), model("claude-opus-4-8", "Opus 4.8")],
  ...fields,
});

const LOGGED_IN = snapshot({
  auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
});

const NOT_LOGGED_IN = snapshot({ auth: { status: "unauthenticated" }, models: [] });

const NO_ADAPTER = snapshot({
  harnessVersion: null,
  versionVerdict: "unknown",
  auth: { status: "error", message: "no adapter for codex in this runner build" },
  models: [],
});

const CLAUDE_ID = "01a06d02-1000-7000-8000-000000000001";
const CODEX_ID = "01a06d02-1000-7000-8000-000000000002";

const claudeCode = (snapshots: readonly Snapshot[]) =>
  instance(CLAUDE_ID, "claude-code", "Claude Code", snapshots);

const CODEX = instance(CODEX_ID, "codex", "Codex", [NO_ADAPTER]);

const INSTANCES = [claudeCode([LOGGED_IN]), CODEX];

/** A controller answering for itself, for the runner given, and for its writes. */
const controller = (
  runner: Fixture,
  options: {
    readonly defaultRunnerId?: string | null;
    readonly instances?: ReadonlyArray<ReturnType<typeof instance>>;
    readonly extra?: Readonly<Record<string, Handler>>;
  } = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/providers": { body: options.instances ?? INSTANCES },
  "GET /api/v1/setup": { body: { complete: true } },
  // The shell's thread list reads this on every path it mounts on; a test
  // about the machine's own sessions overrides it with a real list.
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

const open = async (
  runner: Fixture,
  options: {
    readonly defaultRunnerId?: string | null;
    readonly instances?: ReadonlyArray<ReturnType<typeof instance>>;
    readonly extra?: Readonly<Record<string, Handler>>;
  } = {},
) => {
  const api = stubApi(controller(runner, options));
  const app = await renderApp({ path: `/fleet/${runner.id}`, api: api.fetch, token: "held" });
  return { ...app, api };
};

/** Everything this page sent about the runner, in order. */
const writesTo = (api: { readonly calls: readonly Call[] }, id: string) =>
  api.calls.filter(
    (call) => call.method !== "GET" && call.path.startsWith(`/api/v1/runners/${id}`),
  );

/**
 * Whether a size is on screen, as the whole number of gibibytes the fixtures
 * are all round multiples of.
 */
const showsSize = (text: string, bytes: number): boolean =>
  new RegExp(`(^|[^\\d.])${(bytes / 1024 ** 3).toFixed(0)} ?GiB`).test(text);

/** The field holding the machine's name. */
const nameField = () => screen.getByLabelText<HTMLInputElement>(/name/i);

/** The control saying whether the machine is the owner's alone. */
const reservedField = () => screen.getByRole("checkbox", { name: /personal machine|reserved/i });

/** Whether a control is ticked, whichever way the control says so. */
const ticked = (control: HTMLElement): boolean =>
  control.getAttribute("aria-checked") === "true" || (control as HTMLInputElement).checked;

/**
 * The smallest part of the page holding both a message and the field it is
 * about. A message is beside its field when that part holds no other field.
 */
const around = (message: HTMLElement, field: HTMLElement): HTMLElement => {
  let group: HTMLElement = message;
  while (group.parentElement !== null && !group.contains(field)) {
    group = group.parentElement;
  }
  return group;
};

const action = (name: RegExp) => screen.getByRole("button", { name });

describe("Runner", () => {
  it("says what the machine is, where it stands and what it may run", async () => {
    await open(MOSS);

    const shown = await waitFor(() => {
      const text = reading();
      expect(text).toContain(MOSS.name);
      return text;
    });

    // Where it stands, on both axes. A page states every fact, so the ordinary
    // lifecycle is written out here rather than left to be inferred from the
    // moves being offered.
    expect(shown).toContain(MOSS.lifecycle);
    expect(shown).toContain(MOSS.connectivity);
    // A machine that is not connected carries how long ago its page was true.
    expect(shown).toMatch(/last seen/i);
    expect(shown).toContain(formatStamp(new Date(MOSS.lastSeenAt!), ZONE)!);

    // What it probed about itself.
    expect(shown).toContain(MOSS.facts!.os);
    expect(shown).toContain(MOSS.facts!.arch);
    expect(shown).toContain("2.50.1");
    expect(showsSize(shown, MOSS.facts!.totalMemoryBytes), `memory in: ${shown}`).toBe(true);

    expect(nameField().value).toBe(MOSS.name);
    expect(ticked(reservedField())).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>(/session/i).value).toBe(
      String(MOSS.maxConcurrentSessions),
    );
    expect(screen.getByLabelText<HTMLInputElement>(/disk watermark/i).value).toBe(
      String(MOSS.diskWatermarkBytes / GIB),
    );
  });

  it("says a machine is the owner's own when it is", async () => {
    await open({ ...MOSS, reserved: true });

    await waitFor(() => {
      expect(ticked(reservedField())).toBe(true);
    });
  });
});

describe("Runner > saving", () => {
  /** A controller that answers a patch with the machine the patch makes. */
  const applyPatch = (runner: Fixture) => (call: Call) => ({
    body: { ...runner, ...(call.body as Record<string, unknown>) },
  });

  it("sends the fields the owner changed and nothing else, and says it landed", async () => {
    const user = userEvent.setup();
    const { api } = await open(MOSS, {
      extra: { [`PATCH /api/v1/runners/${MOSS.id}`]: applyPatch(MOSS) },
    });

    await waitFor(() => {
      expect(nameField().value).toBe(MOSS.name);
    });
    // Nothing has been touched, so there is no patch to send and Save says so.
    expect(action(/^save$/i).hasAttribute("disabled")).toBe(true);

    await user.clear(nameField());
    await user.type(nameField(), "moss-2");
    await user.click(action(/^save$/i));

    expect((await screen.findByRole("status")).textContent).toMatch(/saved/i);
    expect(writesTo(api, MOSS.id)).toHaveLength(1);
    expect(writesTo(api, MOSS.id)[0]?.body).toEqual({ name: "moss-2" });

    // The name is now what was saved, so the next write carries only the tick.
    await user.click(reservedField());
    await user.click(action(/^save$/i));

    await waitFor(() => {
      expect(writesTo(api, MOSS.id)).toHaveLength(2);
    });
    expect(writesTo(api, MOSS.id)[1]?.body).toEqual({ reserved: true });
  });

  it("puts a refused name beside the name", async () => {
    const user = userEvent.setup();
    const complaint = "another runner is already called hetzner-01";
    const { api } = await open(MOSS, {
      extra: {
        [`PATCH /api/v1/runners/${MOSS.id}`]: {
          status: 409,
          body: envelope("conflict", complaint),
        },
      },
    });

    await waitFor(() => {
      expect(nameField().value).toBe(MOSS.name);
    });
    await user.clear(nameField());
    await user.type(nameField(), "hetzner-01");
    await user.click(action(/^save$/i));

    const shown = await screen.findByText(new RegExp(complaint));
    const group = around(shown, nameField());
    expect(group.contains(nameField())).toBe(true);
    expect(group.contains(reservedField())).toBe(false);
    expect(writesTo(api, MOSS.id)).toHaveLength(1);
  });

  it("puts a refused reserved beside the tick", async () => {
    const user = userEvent.setup();
    const complaint = "the default runner cannot be reserved";
    await open(MOSS, {
      defaultRunnerId: MOSS.id,
      extra: {
        [`PATCH /api/v1/runners/${MOSS.id}`]: {
          status: 409,
          body: envelope("conflict", complaint),
        },
      },
    });

    await waitFor(() => {
      expect(ticked(reservedField())).toBe(false);
    });
    await user.click(reservedField());
    await user.click(action(/^save$/i));

    const shown = await screen.findByText(new RegExp(complaint));
    const group = around(shown, reservedField());
    expect(group.contains(reservedField())).toBe(true);
    expect(group.contains(nameField())).toBe(false);
  });
});

describe("Runner > moves", () => {
  it("drains the machine and shows that it is draining", async () => {
    const user = userEvent.setup();
    const draining: Fixture = { ...ONLINE, lifecycle: "draining" };
    const { api } = await open(ONLINE, {
      extra: { [`POST /api/v1/runners/${ONLINE.id}/drain`]: { body: draining } },
    });

    await user.click(await screen.findByRole("button", { name: /^drain$/i }));

    await waitFor(() => {
      expect(reading()).toContain("draining");
    });
    expect(writesTo(api, ONLINE.id).map((call) => call.path)).toEqual([
      `/api/v1/runners/${ONLINE.id}/drain`,
    ]);
  });

  it("calls a drain off again", async () => {
    const user = userEvent.setup();
    const draining: Fixture = { ...ONLINE, lifecycle: "draining" };
    const { api } = await open(draining, {
      extra: { [`POST /api/v1/runners/${draining.id}/undrain`]: { body: ONLINE } },
    });

    await user.click(await screen.findByRole("button", { name: /^undrain$/i }));

    await waitFor(() => {
      expect(reading()).not.toContain("draining");
    });
    expect(writesTo(api, draining.id).map((call) => call.path)).toEqual([
      `/api/v1/runners/${draining.id}/undrain`,
    ]);
  });

  it("asks the machine to probe itself again and shows what came back", async () => {
    const user = userEvent.setup();
    const probed: Fixture = {
      ...ONLINE,
      facts: { ...ONLINE.facts!, totalMemoryBytes: 32 * GIB, arch: "x64" },
    };
    const { api } = await open(ONLINE, {
      extra: { [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: { body: probed } },
    });

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));

    await waitFor(() => {
      expect(reading()).toContain("x64");
    });
    expect(showsSize(reading(), 32 * GIB), `the new memory in: ${reading()}`).toBe(true);
    expect(writesTo(api, ONLINE.id).map((call) => call.path)).toEqual([
      `/api/v1/runners/${ONLINE.id}/refresh-facts`,
    ]);
  });

  it("does not send a field the owner never touched after a move changed it", async () => {
    // The derived session cap follows the machine's memory, so a re-probe moves
    // it under the form. Saving must never send that number back: the
    // controller would store it as an override, and there is no control
    // anywhere that undoes one.
    const user = userEvent.setup();
    const probed: Fixture = {
      ...ONLINE,
      facts: { ...ONLINE.facts!, totalMemoryBytes: 8 * GIB },
      maxConcurrentSessions: 4,
    };
    const { api } = await open(ONLINE, {
      // The answer to a patch is the machine as it now stands, cap included.
      extra: {
        [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: { body: probed },
        [`PATCH /api/v1/runners/${ONLINE.id}`]: (call: Call) => ({
          body: { ...probed, ...(call.body as Record<string, unknown>) },
        }),
      },
    });

    await waitFor(() => {
      expect(nameField().value).toBe(ONLINE.name);
    });
    await user.clear(nameField());
    await user.type(nameField(), "moss-2");

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));

    // The re-probe changed the cap, but a half-typed form is not overwritten,
    // so the field still holds what the reader is working from.
    await waitFor(() => {
      expect(reading()).toContain("8 GiB");
    });
    expect(nameField().value).toBe("moss-2");

    await user.click(action(/^save$/i));
    await screen.findByRole("status");

    // Only the name. The cap the re-probe moved is not the user's to send.
    const first = writesTo(api, ONLINE.id).filter((call) => call.method === "PATCH");
    expect(first).toHaveLength(1);
    expect(first[0]?.body).toEqual({ name: "moss-2" });

    // The save answered with the machine whole, so the form now shows the cap
    // the re-probe derived rather than the one it opened with.
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(/session/i).value).toBe("4");
    });

    // The answer to the save above is what the next patch is measured against,
    // whole, so nothing is left to send and Save is no longer offered.
    expect(action(/^save$/i).hasAttribute("disabled")).toBe(true);
    await user.click(action(/^save$/i));
    expect(writesTo(api, ONLINE.id).filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("says what a refused move was refused with", async () => {
    const user = userEvent.setup();
    const complaint = "the runner did not answer within 10s";
    const { api } = await open(ONLINE, {
      extra: {
        [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: {
          status: 409,
          body: envelope("invalid_state", complaint),
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));

    expect((await screen.findByRole("alert")).textContent).toContain(complaint);
    expect(writesTo(api, ONLINE.id)).toHaveLength(1);
  });

  it("drops what a refused move said once another move succeeds", async () => {
    const user = userEvent.setup();
    const complaint = "the runner did not answer within 10s";
    await open(ONLINE, {
      extra: {
        [`POST /api/v1/runners/${ONLINE.id}/refresh-facts`]: {
          status: 409,
          body: envelope("invalid_state", complaint),
        },
        [`POST /api/v1/runners/${ONLINE.id}/drain`]: {
          body: { ...ONLINE, lifecycle: "draining" },
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: /refresh facts/i }));
    expect((await screen.findByRole("alert")).textContent).toContain(complaint);

    await user.click(action(/^drain$/i));

    // The drain worked, so the refusal above it is not this page's state any
    // more; leaving it there reads as the drain having failed.
    await waitFor(() => {
      expect(reading()).toContain("draining");
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(reading()).not.toContain(complaint);
  });
});

describe("Runner > retiring", () => {
  const retired = (runner: Fixture): Fixture => ({ ...runner, lifecycle: "retired" });

  it("asks before it retires, and sends nothing until the question is answered", async () => {
    const user = userEvent.setup();
    const { api } = await open(ONLINE, {
      extra: { [`POST /api/v1/runners/${ONLINE.id}/retire`]: { body: retired(ONLINE) } },
    });

    await user.click(await screen.findByRole("button", { name: /^retire$/i }));
    expect(writesTo(api, ONLINE.id)).toEqual([]);

    // Backing out leaves the machine as it was.
    await user.click(action(/^cancel$/i));
    expect(writesTo(api, ONLINE.id)).toEqual([]);
    expect(reading()).not.toContain("retired");

    await user.click(await screen.findByRole("button", { name: /^retire$/i }));
    await user.click(action(/^confirm$/i));

    await waitFor(() => {
      expect(reading()).toContain("retired");
    });
    const sent = writesTo(api, ONLINE.id);
    expect(sent.map((call) => call.path)).toEqual([`/api/v1/runners/${ONLINE.id}/retire`]);
    // A machine the controller can account for is not forced.
    expect((sent[0]?.body as { force?: boolean } | undefined)?.force).not.toBe(true);
  });

  it("says that retiring a machine it cannot reach forces it, and forces it", async () => {
    const user = userEvent.setup();
    const { api } = await open(LOST, {
      extra: { [`POST /api/v1/runners/${LOST.id}/retire`]: { body: retired(LOST) } },
    });

    await user.click(await screen.findByRole("button", { name: /^retire$/i }));

    expect(reading()).toContain("This runner is unreachable; retiring it now forces it");

    await user.click(action(/^confirm$/i));

    await waitFor(() => {
      expect(writesTo(api, LOST.id)).toHaveLength(1);
    });
    expect(writesTo(api, LOST.id)[0]?.body).toEqual({ force: true });
  });

  // The default-runner sentence and the case where neither sentence applies are
  // pinned exactly, and in every combination, by retireQuestion's unit test. Only
  // the unreachable case is driven through the browser, because it is the one
  // that also has to prove `force: true` reaches the wire.

  it("offers nothing to do to a machine that has been retired", async () => {
    await open(retired(MOSS));

    await waitFor(() => {
      expect(reading()).toContain("retired");
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

  const row = (name: string): Promise<HTMLElement> => screen.findByRole("group", { name });

  const claudeRow = () => row("Claude Code");

  it("says what each instance last reported on this machine", async () => {
    await open(ONLINE);

    const claude = reading(await claudeRow());
    expect(claude).toContain("2.1.263");
    expect(claude).toContain("rogier@example.com");
    expect(claude).toContain("Claude Max");
    expect(claude).toMatch(/2 models/i);
    // A version the build was tested against is remarked on with nothing at all.
    expect(claude).not.toMatch(/below|above|untested/i);

    expect(reading(await row("Codex"))).toContain("no adapter");
  });

  it("marks a harness older than the one this build talks to", async () => {
    await open(ONLINE, {
      instances: [
        claudeCode([
          snapshot({
            harnessVersion: "2.0.9",
            versionVerdict: "below-floor",
            auth: LOGGED_IN.auth,
          }),
        ]),
        CODEX,
      ],
    });

    const claude = reading(await claudeRow());
    expect(claude).toContain("2.0.9");
    expect(claude).toMatch(/below/i);
  });

  it("offers to log in again and to re-probe a harness that is on the machine", async () => {
    await open(ONLINE);

    const claude = within(await claudeRow());
    expect(claude.getByRole("button", { name: /log in again/i })).toBeDefined();
    expect(claude.getByRole("button", { name: /probe now/i })).toBeDefined();
    // Nothing to install: the machine reported the binary.
    expect(claude.queryByRole("button", { name: /install/i })).toBeNull();
  });

  it("offers to install a harness that is missing, and cannot for a provider it has no adapter for", async () => {
    await open(BARE, { instances: [claudeCode([]), CODEX] });

    const claude = within(await claudeRow());
    expect(claude.getByRole("button", { name: /install/i }).hasAttribute("disabled")).toBe(false);
    // There is nothing to log in to until the harness is on the machine.
    expect(claude.queryByRole("button", { name: /log in/i })).toBeNull();

    const codexRow = await row("Codex");
    const codex = within(codexRow);
    expect(codex.getByRole("button", { name: /install/i }).hasAttribute("disabled")).toBe(true);
    // Said before the user presses anything, rather than discovered by failing.
    expect(reading(codexRow)).toMatch(/no adapter/i);
  });

  it("logs in through the dialog and shows the account the machine came back with", async () => {
    const user = userEvent.setup();
    let held = [claudeCode([NOT_LOGGED_IN]), CODEX];
    const { api } = await open(ONLINE, {
      instances: held,
      extra: {
        "GET /api/v1/providers": () => ({ body: held }),
        [`POST /api/v1/providers/${CLAUDE_ID}/login`]: { body: { url: AUTHORIZE_URL } },
        [`POST /api/v1/providers/${CLAUDE_ID}/login-code`]: (call: Call) => {
          if ((call.body as { code: string }).code !== "the-whole-code") {
            return { status: 400, body: envelope("validation", INVALID) };
          }
          held = [claudeCode([LOGGED_IN]), CODEX];
          return { body: LOGGED_IN };
        },
      },
    });

    await user.click(within(await claudeRow()).getByRole("button", { name: /log in/i }));

    // The user reads the URL on this screen and opens it wherever they like:
    // the machine running the harness may have no browser at all.
    await waitFor(() => {
      expect(reading()).toContain(AUTHORIZE_URL);
    });
    // And is told which site they are about to sign in at, which is the one
    // part of a long opaque address they can check before they do.
    expect(reading()).toContain("You will sign in at claude.ai");
    expect(api.calls.filter((call) => call.path.endsWith("/login"))[0]?.body).toEqual({
      runnerId: ONLINE.id,
    });

    const code = () => screen.getByLabelText<HTMLInputElement>("Code", { exact: true });
    await user.type(code(), "half-a-code");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect((await screen.findByText(new RegExp(INVALID))).textContent).toContain("Invalid code");
    await user.clear(code());
    await user.type(code(), "the-whole-code");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Code", { exact: true })).toBeNull();
    });
    await waitFor(() => {
      expect(reading()).toContain("rogier@example.com");
    });
  });

  it("probes one instance on demand and shows what came back", async () => {
    const user = userEvent.setup();
    const fresh = snapshot({ harnessVersion: "2.1.300", auth: LOGGED_IN.auth });
    let held = INSTANCES;
    const { api } = await open(ONLINE, {
      extra: {
        "GET /api/v1/providers": () => ({ body: held }),
        [`POST /api/v1/runners/${ONLINE.id}/probe`]: () => {
          held = [claudeCode([fresh]), CODEX];
          return { body: fresh };
        },
      },
    });

    await user.click(within(await claudeRow()).getByRole("button", { name: /probe now/i }));

    await waitFor(() => {
      expect(reading()).toContain("2.1.300");
    });
    const asked = api.calls.filter((call) => call.path.endsWith("/probe"));
    // One instance, not the machine's whole set: the button is on the row.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toEqual({ instanceId: CLAUDE_ID });
  });

  it("reads the card again when a snapshot changes elsewhere", async () => {
    let held = INSTANCES;
    const { live } = await open(ONLINE, {
      extra: { "GET /api/v1/providers": () => ({ body: held }) },
    });

    await waitFor(() => {
      expect(live.topics()).toContain("provider");
    });
    held = [claudeCode([snapshot({ harnessVersion: "2.1.300", auth: LOGGED_IN.auth })]), CODEX];
    act(() => {
      live.push("provider", { _tag: "invalidate", ids: [CLAUDE_ID], kind: "updated" });
    });

    await waitFor(() => {
      expect(reading()).toContain("2.1.300");
    });
  });
});

describe("Runner > sessions", () => {
  /** A machine with two slots, which is what makes a queue possible at all. */
  const TWO: Fixture = { ...ONLINE, maxConcurrentSessions: 2 };

  const minutesAgo = (minutes: number): string =>
    new Date(Date.now() - minutes * 60_000).toISOString();

  const RUNNING = sessionFixture({
    id: "01a06d02-2000-7000-8000-00000000000a",
    title: "Fix the login bug",
    status: "busy",
    at: minutesAgo(200),
  });

  /** Queued out of order in the fixture, so an ordered reading is the page's doing. */
  const WAITED_LESS = sessionFixture({
    id: "01a06d02-2000-7000-8000-00000000000c",
    title: "Write the changelog",
    status: "queued",
    at: minutesAgo(5),
  });

  const WAITED_LONGEST = sessionFixture({
    id: "01a06d02-2000-7000-8000-00000000000b",
    title: "Investigate the flaky test",
    status: "queued",
    at: minutesAgo(130),
  });

  /**
   * The controller's answer to `session.query`, narrowed by whatever the page
   * asked for. Written as a filter rather than a fixed body so the page is free
   * to ask once for the machine's sessions or once per status.
   */
  const listing = (sessions: () => readonly Session[]) => (call: Call) => {
    const asked = new URLSearchParams(call.search);
    const runnerId = asked.get("runnerId");
    // A status filter is one bare key or several repeated ones - the page
    // asks for its whole running-or-queued mix in one read.
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

  /** The page itself, without the shell's own thread list beside it. */
  const page = () => reading(screen.getByRole("main"));

  /** Every reading of the session list this browser has made. */
  const listings = (api: { readonly calls: readonly Call[] }) =>
    api.calls.filter((call) => call.method === "GET" && call.path === "/api/v1/sessions");

  const openWith = (runner: Fixture, sessions: () => readonly Session[]) =>
    open(runner, { extra: { "GET /api/v1/sessions": listing(sessions) } });

  it("says how full the machine is and lists what is waiting for a slot", async () => {
    const held = [RUNNING, WAITED_LESS, WAITED_LONGEST];
    await openWith(TWO, () => held);

    await waitFor(() => {
      expect(page()).toContain("1 running of 2 · 2 queued");
    });

    const shown = page();
    // Oldest first: the session that has waited longest is the next to start,
    // and a queue that read newest first would say the opposite.
    expect(shown.indexOf(WAITED_LONGEST.title)).toBeGreaterThan(-1);
    expect(shown.indexOf(WAITED_LONGEST.title)).toBeLessThan(shown.indexOf(WAITED_LESS.title));

    // Each row carries how long it has been waiting, read the same way every
    // other row in the app reads an age.
    expect(shown).toContain(ageOf(WAITED_LONGEST.createdAt, new Date()));
    expect(shown).toContain(ageOf(WAITED_LESS.createdAt, new Date()));

    // The rows are the queue. A running session holds a slot, which the line
    // above has already said; listing it again would read as waiting.
    expect(shown).not.toContain(RUNNING.title);
  });

  it("has the queue in hand when the page opens", async () => {
    // The loader reads it, so nothing below the route suspends: a reader never
    // sees the machine's facts arrive with its capacity still blank.
    const held = [RUNNING, WAITED_LESS, WAITED_LONGEST];
    await openWith(TWO, () => held);

    expect(page()).toContain("1 running of 2 · 2 queued");
  });

  it("says only how full the machine is when nothing is waiting", async () => {
    const held = [RUNNING];
    await openWith(TWO, () => held);

    await waitFor(() => {
      expect(page()).toContain("1 running of 2");
    });
    expect(page()).not.toMatch(/queued/i);
    expect(page()).not.toContain(RUNNING.title);
  });

  it("reads the list again when a session moves elsewhere", async () => {
    let held: readonly Session[] = [RUNNING, WAITED_LESS, WAITED_LONGEST];
    const { api, live } = await openWith(TWO, () => held);

    await waitFor(() => {
      expect(page()).toContain("1 running of 2 · 2 queued");
    });
    await waitFor(() => {
      expect(live.topics()).toContain("session");
    });
    const before = listings(api).length;

    // The controller started the one that had waited longest.
    held = [RUNNING, WAITED_LESS, { ...WAITED_LONGEST, status: "starting" }];
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [WAITED_LONGEST.id], kind: "updated" });
    });

    await waitFor(() => {
      expect(page()).toContain("2 running of 2 · 1 queued");
    });
    // The page says so because it read the list again, not because the push
    // carried the session with it.
    expect(listings(api).length).toBeGreaterThan(before);
    expect(page()).not.toContain(WAITED_LONGEST.title);
  });
});
