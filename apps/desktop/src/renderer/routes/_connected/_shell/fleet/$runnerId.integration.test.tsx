/**
 * Tests a machine's page (spec 17 §Fleet, A machine's page): its head and
 * room line, the banner of a machine that is away, the Software section, and
 * the Settings rows with their saves, refusals and Retire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HARNESSES } from "@hercule/client-core/testing";
import type { Harness, ProviderAccount, Runner } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_ACCOUNT,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Call,
  type Handler,
} from "../../../../app/testing";

beforeEach(() => {
  stubIntersectionObserver();
  vi.stubEnv("TZ", "UTC");
  vi.useFakeTimers({ now: new Date("2026-11-02T14:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  localStorage.clear();
});

const GIB = 1024 ** 3;
const [MOSS_RECORD] = SIDEBAR_FIXTURE.runners;

/** atlas: online, 16 GiB, a cap of 8, a 10 GiB disk limit with 100 GB free, and the label gpu. */
const ATLAS: Runner = {
  ...MOSS_RECORD!,
  name: "atlas",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.9.3",
  labels: ["gpu"],
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 16 * GIB,
    docker: false,
    toolchains: [],
    harnesses: [
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: true, path: "/usr/local/bin/codex" },
    ],
    adapters: ["claude-code/claude-code", "codex/codex"],
    identityPort: 4939,
  },
  watermark: { diskFreeBytes: 100_000_000_000, availableMemoryBytes: 8 * GIB },
  maxConcurrentSessions: 8,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-11-02T09:12:00.000Z",
};

/** atlas as the controller returns it from an operation on one runner. */
const asDetail = (runner: Runner) => ({
  ...runner,
  negotiatedCapabilities: null,
  protocolVersion: null,
});

/** Claude Code is installed on atlas below the oldest supported version, Codex above the newest tested one, and pi is missing. */
const HARNESSES_ON_ATLAS: readonly Harness[] = HARNESSES.map((harness) => {
  const onAtlas = (version: string, versionVerdict: "below-floor" | "above-tested-max") => [
    { runnerId: ATLAS.id, installed: true, version, versionVerdict },
  ];
  if (harness.id === "claude-code/claude-code") {
    return { ...harness, runners: onAtlas("1.0.0", "below-floor") };
  }
  if (harness.id === "codex/codex") {
    return { ...harness, runners: onAtlas("9.9.9", "above-tested-max") };
  }
  return harness;
});

/** Anthropic: a subscription account that is not signed in on atlas. */
const ANTHROPIC_UNSIGNED: ProviderAccount = {
  ...FIXTURE_ACCOUNT,
  snapshots: [],
  readiness: [],
};

/** OpenAI: a subscription account signed in on atlas. */
const OPENAI_SIGNED_IN: ProviderAccount = {
  ...FIXTURE_ACCOUNT,
  id: "01a06d02-7600-7000-8000-000000000002",
  providerId: "openai/openai",
  defaultHarnessId: "codex/codex",
  readiness: [{ harnessId: "codex/codex", runnerId: ATLAS.id, state: "ready" }],
  snapshots: [
    {
      ...FIXTURE_ACCOUNT.snapshots[0]!,
      runnerId: ATLAS.id,
      harnessId: "codex/codex",
      auth: { status: "ok", identity: "rogier@openai.example", planLabel: "Plus" },
    },
  ],
};

/** Z.ai: an API key account, which works on every machine and has no sign-in. */
const ZAI_KEY: ProviderAccount = {
  ...FIXTURE_ACCOUNT,
  id: "01a06d02-7600-7000-8000-000000000003",
  providerId: "zai/zai",
  kind: "api-key",
  defaultHarnessId: "pi/pi",
  readiness: [],
  snapshots: [],
};

const buildControllerInfo = (version: string) => ({
  id: "01a06d02-7800-7000-8000-000000000001",
  publicKey: "controller-key",
  version,
  defaultRunnerId: null,
  localRunnerId: null,
  textGeneration: { model: null, lastFailure: null, unavailableReason: null },
});

const RUNNER_PATH = `/api/v1/runners/${ATLAS.id}`;

/**
 * Opens atlas's page. The controller holds the runner in `held.runner`, which
 * a PATCH, a drain, an undrain and a retire change as the real controller
 * does, so the page reads back what was saved. `overrides` replace any
 * answer.
 */
const openMachine = async ({
  runner = ATLAS,
  controllerVersion = "0.9.4",
  overrides = {},
}: {
  readonly runner?: Runner;
  readonly controllerVersion?: string;
  readonly overrides?: Readonly<Record<string, Handler>>;
} = {}) => {
  const held = { runner };
  const change = (update: Partial<Runner>) => {
    held.runner = { ...held.runner, ...update };
    return { body: asDetail(held.runner) };
  };
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      runners: [runner],
      accounts: [ANTHROPIC_UNSIGNED, OPENAI_SIGNED_IN, ZAI_KEY],
    }),
    "GET /api/v1/runners": () => ({ body: { items: [held.runner] } }),
    "GET /api/v1/harnesses": { body: HARNESSES_ON_ATLAS },
    "GET /api/v1/controller": { body: buildControllerInfo(controllerVersion) },
    [`PATCH ${RUNNER_PATH}`]: (call) => change(call.body as Partial<Runner>),
    [`POST ${RUNNER_PATH}/drain`]: () => change({ lifecycle: "draining" }),
    [`POST ${RUNNER_PATH}/undrain`]: () => change({ lifecycle: "active" }),
    [`POST ${RUNNER_PATH}/retire`]: () => change({ lifecycle: "retired" }),
    ...overrides,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: `/fleet/${runner.id}` },
  );
  await screen.findByRole("heading", { level: 2, name: runner.name });
  return { calls, ...app };
};

/** Returns the requests in `calls` with `method` to `path`. */
const readCalls = (calls: readonly Call[], method: string, path: string): readonly Call[] =>
  calls.filter((call) => call.method === method && call.path === path);

const getSettings = () => screen.getByRole("region", { name: "Settings" });
const getSoftware = () => screen.getByRole("region", { name: "Software" });

describe("a machine's head", () => {
  it("shows the name, the status, what the runner reported, and the room line", async () => {
    await openMachine();

    const head = screen.getByRole("heading", { level: 2, name: "atlas" }).closest("header")!;
    expect(head.textContent).toBe(
      "atlasOnline·darwin · arm64·16 GiB·Runner 0.9.3·update available",
    );
    expect(screen.getByText(/^Room for/).textContent).toBe("Room for 4 more, under its cap of 8");
    expect(screen.getByText("4").tagName).toBe("B");
  });

  it("names the state of a machine that takes no new work, in the head and in the room line", async () => {
    await openMachine({ runner: { ...ATLAS, lifecycle: "draining" } });

    const head = screen.getByRole("heading", { level: 2, name: "atlas" }).closest("header")!;
    expect(within(head).getByText("Takes no new work")).toBeTruthy();
    expect(screen.getByText("No room: it takes no new work")).toBeTruthy();
  });

  it("shows no update hint when the runner runs the controller's release", async () => {
    await openMachine({ controllerVersion: "0.9.3" });

    expect(screen.queryByText("update available")).toBeNull();
  });
});

describe("a machine that is away", () => {
  const OFFLINE: Runner = { ...ATLAS, connectivity: "offline" };

  it("shows the banner in place of the room line, with the command to start it again", async () => {
    await openMachine({ runner: OFFLINE });

    // Four threads of atlas have not exited; the fifth has.
    const banner = screen.getByText(/^atlas has not been heard from since 09:12\./).closest("div")!;
    expect(banner.textContent).toBe(
      "atlas has not been heard from since 09:12.It may be asleep, off the network, or without power. Its 4 threads can carry on once it is back, and work waiting for it starts then. If it does not come back by itself, start Hercule on it again: hercule service start. What you see below is from 09:12.",
    );
    expect(within(banner).getByText("hercule service start").tagName).toBe("CODE");
    expect(screen.queryByText(/^Room for/)).toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: "atlas" }).closest("header")!.textContent,
    ).toContain("Offline");
  });

  it("asks the same retire question from the banner as from Settings", async () => {
    const { calls } = await openMachine({ runner: OFFLINE });

    const [fromBanner] = screen.getAllByRole("button", { name: "Retire…" });
    await userEvent.click(fromBanner!);

    const dialog = await screen.findByRole("dialog", { name: "Retire atlas?" });
    expect(within(dialog).getByRole("button", { name: "Retire" })).toBeTruthy();
    expect(readCalls(calls, "POST", `${RUNNER_PATH}/retire`)).toHaveLength(0);
  });

  it("offers no Sign in on the machine", async () => {
    await openMachine({ runner: OFFLINE });

    expect(within(getSoftware()).queryByRole("button", { name: /^Sign in/ })).toBeNull();
  });
});

describe("the Software section", () => {
  it("lists each harness with its version and what the version means for this Hercule", async () => {
    await openMachine();

    const rows = within(within(getSoftware()).getByRole("list", { name: "Harnesses" }))
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(rows.slice(0, 2)).toEqual([
      "Claude Code1.0.0Too old for this Hercule: update it",
      "Codex9.9.9Newer than this Hercule was tested with",
    ]);
    // pi has no logo, so its mark is the character π before the name.
    expect(rows[2]).toMatch(/piNot installed$/);
    expect(rows).toHaveLength(3);
    expect(within(getSoftware()).queryByRole("button", { name: /Install|Update/ })).toBeNull();
  });

  it("lists the accounts that sign in on each machine, and leaves out a key account", async () => {
    await openMachine();

    const rows = within(
      within(getSoftware()).getByRole("list", { name: "Accounts signed in here" }),
    )
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(rows).toEqual([
      "AnthropicClaude CodeNot signed inSign in",
      "OpenAICodexSigned in as rogier@openai.example",
    ]);
  });

  it("opens the account's sign-in dialog for this machine from Sign in", async () => {
    const { calls } = await openMachine({
      overrides: {
        [`POST /api/v1/provider-accounts/${ANTHROPIC_UNSIGNED.id}/sign-in`]: {
          body: { url: "https://claude.ai/oauth/authorize?code=1" },
        },
      },
    });

    await userEvent.click(
      within(getSoftware()).getByRole("button", { name: "Sign in to Anthropic" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Sign in to Anthropic on atlas" }),
    ).toBeTruthy();
    expect(
      readCalls(calls, "POST", `/api/v1/provider-accounts/${ANTHROPIC_UNSIGNED.id}/sign-in`),
    ).toHaveLength(1);
  });
});

describe("the Settings section", () => {
  it("saves the session cap, and refuses text that is not a whole number of 1 or more", async () => {
    const { calls } = await openMachine();
    const field = within(getSettings()).getByRole("textbox", { name: "Session cap" });

    await userEvent.clear(field);
    await userEvent.type(field, "0{Enter}");

    expect((await within(getSettings()).findByRole("alert")).textContent).toBe(
      "The session cap must be a whole number of 1 or more, such as 8.",
    );
    expect((field as HTMLInputElement).value).toBe("8");
    expect(readCalls(calls, "PATCH", RUNNER_PATH)).toHaveLength(0);

    await userEvent.type(field, "{Backspace}12{Enter}");

    await waitFor(() => {
      expect(readCalls(calls, "PATCH", RUNNER_PATH).map((call) => call.body)).toEqual([
        { maxConcurrentSessions: 12 },
      ]);
    });
    await waitFor(() => {
      expect(within(getSettings()).queryByRole("alert")).toBeNull();
    });
    expect((field as HTMLInputElement).value).toBe("12");
  });

  it("adds a label, removes one, and refuses a label it has", async () => {
    const { calls } = await openMachine();

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Add a label" }));
    await userEvent.type(screen.getByRole("textbox", { name: "New label" }), "  fast {Enter}");
    await waitFor(() => {
      expect(readCalls(calls, "PATCH", RUNNER_PATH).map((call) => call.body)).toEqual([
        { labels: ["gpu", "fast"] },
      ]);
    });
    await within(getSettings()).findByText("fast");

    await userEvent.click(
      within(getSettings()).getByRole("button", { name: "Remove the label gpu" }),
    );
    await waitFor(() => {
      expect(readCalls(calls, "PATCH", RUNNER_PATH).map((call) => call.body)).toEqual([
        { labels: ["gpu", "fast"] },
        { labels: ["fast"] },
      ]);
    });

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Add a label" }));
    await userEvent.type(screen.getByRole("textbox", { name: "New label" }), "fast{Enter}");
    expect((await within(getSettings()).findByRole("alert")).textContent).toBe(
      'This machine already has the label "fast".',
    );
    expect(readCalls(calls, "PATCH", RUNNER_PATH)).toHaveLength(2);
  });

  it("refuses a label of more than 64 characters", async () => {
    const { calls } = await openMachine();

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Add a label" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "New label" }),
      `${"a".repeat(65)}{Enter}`,
    );

    expect((await within(getSettings()).findByRole("alert")).textContent).toMatch(
      /^A label can have at most 64 characters\./,
    );
    expect(readCalls(calls, "PATCH", RUNNER_PATH)).toHaveLength(0);
  });

  it("saves the Reserved switch", async () => {
    const { calls } = await openMachine();

    await userEvent.click(within(getSettings()).getByRole("switch", { name: "Reserved" }));

    await waitFor(() => {
      expect(readCalls(calls, "PATCH", RUNNER_PATH).map((call) => call.body)).toEqual([
        { reserved: true },
      ]);
    });
    await waitFor(() => {
      expect(
        within(getSettings())
          .getByRole("switch", { name: "Reserved" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });
  });

  it("puts the switch back and says why when a save is refused", async () => {
    await openMachine({
      overrides: {
        [`PATCH ${RUNNER_PATH}`]: {
          status: 409,
          body: buildErrorBody("conflict", "another change got there first"),
        },
      },
    });

    await userEvent.click(within(getSettings()).getByRole("switch", { name: "Reserved" }));

    expect((await within(getSettings()).findByRole("alert")).textContent).toBe(
      "Could not save: another change got there first",
    );
    expect(
      within(getSettings()).getByRole("switch", { name: "Reserved" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("shows the disk limit in gigabytes and saves a changed one", async () => {
    const { calls } = await openMachine();
    const field = within(getSettings()).getByRole("textbox", { name: "Disk limit" });
    // 10 GiB is 10.737 GB.
    expect((field as HTMLInputElement).value).toBe("10.7");

    await userEvent.clear(field);
    await userEvent.type(field, "20{Enter}");

    await waitFor(() => {
      expect(readCalls(calls, "PATCH", RUNNER_PATH).map((call) => call.body)).toEqual([
        { diskWatermarkBytes: 20_000_000_000 },
      ]);
    });
  });

  it("does not rewrite the stored disk limit when the text is back to what it showed", async () => {
    const { calls } = await openMachine();
    const field = within(getSettings()).getByRole("textbox", { name: "Disk limit" });

    // The text ends as it began, so rounding "10.7" back to bytes would change the stored 10 GiB.
    await userEvent.type(field, "{Backspace}7");
    await userEvent.tab();

    expect((field as HTMLInputElement).value).toBe("10.7");
    expect(readCalls(calls, "PATCH", RUNNER_PATH)).toHaveLength(0);
  });

  it("refuses a disk limit with two decimals", async () => {
    const { calls } = await openMachine();
    const field = within(getSettings()).getByRole("textbox", { name: "Disk limit" });

    await userEvent.clear(field);
    await userEvent.type(field, "1.25{Enter}");

    expect((await within(getSettings()).findByRole("alert")).textContent).toMatch(
      /^The disk limit must be a number of gigabytes/,
    );
    expect(readCalls(calls, "PATCH", RUNNER_PATH)).toHaveLength(0);
  });

  it("stops new work with drain, and takes new work again with undrain", async () => {
    const { calls } = await openMachine();

    await userEvent.click(within(getSettings()).getByRole("switch", { name: "Stop new work" }));

    await waitFor(() => {
      expect(
        within(getSettings())
          .getByRole("switch", { name: "Stop new work" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });
    expect(readCalls(calls, "POST", `${RUNNER_PATH}/drain`)).toHaveLength(1);
    expect(screen.getByText("No room: it takes no new work")).toBeTruthy();

    await userEvent.click(within(getSettings()).getByRole("switch", { name: "Stop new work" }));

    await waitFor(() => {
      expect(
        within(getSettings())
          .getByRole("switch", { name: "Stop new work" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });
    expect(readCalls(calls, "POST", `${RUNNER_PATH}/undrain`)).toHaveLength(1);
  });

  it("puts Stop new work back and says why when the controller refuses", async () => {
    await openMachine({
      overrides: {
        [`POST ${RUNNER_PATH}/drain`]: {
          status: 409,
          body: buildErrorBody("invalid_state", "atlas is being retired"),
        },
      },
    });

    await userEvent.click(within(getSettings()).getByRole("switch", { name: "Stop new work" }));

    expect((await within(getSettings()).findByRole("alert")).textContent).toBe(
      "Could not save: atlas is being retired",
    );
    expect(
      within(getSettings())
        .getByRole("switch", { name: "Stop new work" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("Retire", () => {
  it("asks first, then retires the machine and goes to Fleet", async () => {
    const { calls, router } = await openMachine();

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Retire…" }));
    const dialog = await screen.findByRole("dialog", { name: "Retire atlas?" });
    expect(readCalls(calls, "POST", `${RUNNER_PATH}/retire`)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Retire" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/fleet");
    });
    expect(readCalls(calls, "POST", `${RUNNER_PATH}/retire`).map((call) => call.body)).toEqual([
      {},
    ]);
  });

  it("forces the retire of an unreachable machine and says so", async () => {
    const { calls } = await openMachine({ runner: { ...ATLAS, connectivity: "unreachable" } });

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Retire…" }));
    const dialog = await screen.findByRole("dialog", { name: "Retire atlas?" });
    expect(
      within(dialog).getByText("This runner is unreachable; retiring it now forces it."),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retire" }));

    await waitFor(() => {
      expect(readCalls(calls, "POST", `${RUNNER_PATH}/retire`).map((call) => call.body)).toEqual([
        { force: true },
      ]);
    });
  });

  it("shows the controller's refusal in the dialog and stays on the page", async () => {
    const { router } = await openMachine({
      overrides: {
        [`POST ${RUNNER_PATH}/retire`]: {
          status: 409,
          body: buildErrorBody("invalid_state", "atlas still has a session starting"),
        },
      },
    });

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Retire…" }));
    const dialog = await screen.findByRole("dialog", { name: "Retire atlas?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Retire" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "atlas still has a session starting",
    );
    expect(within(dialog).queryByRole("button", { name: "Retire" })).toBeNull();
    expect(router.state.location.pathname).toBe(`/fleet/${ATLAS.id}`);
  });
});
