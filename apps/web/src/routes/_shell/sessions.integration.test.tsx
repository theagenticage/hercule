/**
 * Tests the Sessions screen against a stubbed controller. On a fresh install
 * this screen finishes onboarding: it tells the user what they still need
 * before they can start a thread.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProviderSecretField, Runner } from "@hercule/contract";
import {
  buildErrorBody,
  readPageText,
  renderApp,
  stubApi,
  type Call,
  type Handler,
} from "../../app/testing";

const GIB = 1024 * 1024 * 1024;

const ZONE = "Europe/Amsterdam";

const MOSS: Runner = {
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "moss",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.4.2",
  labels: [],
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 64 * GIB,
    docker: true,
    toolchains: [],
    providers: [{ name: "claude", present: true, path: "/usr/local/bin/claude" }],
    adapters: ["claude-code"],
    identityPort: 4939,
  },
  watermark: null,
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-09-05T09:14:00.000Z",
};

const BARE: Runner = {
  ...MOSS,
  facts: { ...MOSS.facts!, providers: [{ name: "claude", present: false }] },
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

const CLAUDE_ID = "01a06d02-1000-7000-8000-000000000001";

const buildSnapshot = (auth: Readonly<Record<string, string>>) => ({
  runnerId: MOSS.id,
  probedAt: "2026-09-05T09:14:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth,
  models: [{ slug: "default", name: "Default", options: [] }],
});

const buildClaudeCodeInstance = (snapshots: ReadonlyArray<ReturnType<typeof buildSnapshot>>) => ({
  id: CLAUDE_ID,
  providerId: "claude-code",
  name: "Claude Code",
  config: {},
  displayName: "Claude Code",
  binaryName: "claude",
  declared: DECLARED,
  secretFields: [] as ReadonlyArray<ProviderSecretField>,
  snapshots,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

const LOGGED_IN = buildSnapshot({
  status: "ok",
  identity: "rogier@example.com",
  planLabel: "Claude Max",
});

const NOT_LOGGED_IN = buildSnapshot({ status: "unauthenticated" });

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize?code=challenge";

const buildController = (
  runners: ReadonlyArray<Runner>,
  instances: ReadonlyArray<ReturnType<typeof buildClaudeCodeInstance>>,
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
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
      version: "0.4.2",
      defaultRunnerId: null,
    },
  },
  "GET /api/v1/runners": { body: { items: runners } },
  "GET /api/v1/providers": { body: instances },
  ...extra,
});

const openApp = async (options: {
  readonly runners: ReadonlyArray<Runner>;
  readonly instances: ReadonlyArray<ReturnType<typeof buildClaudeCodeInstance>>;
  readonly local?: string | null;
  readonly extra?: Readonly<Record<string, Handler>>;
}) => {
  const api = stubApi(buildController(options.runners, options.instances, options.extra));
  const app = await renderApp({
    path: "/",
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(options.local ?? null),
  });
  return { ...app, api };
};

/**
 * Returns the screen's own Create new thread control, ignoring the one in the
 * sidebar's thread list. It is a disabled button until the machine is ready,
 * then a link to the composer.
 */
const getNewThreadControl = (): HTMLElement => {
  const found = [
    ...screen.queryAllByRole("button", { name: /create new thread/i }),
    ...screen.queryAllByRole("link", { name: /create new thread/i }),
  ].filter((element) => element.closest("nav") === null);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe("Sessions", () => {
  it("says a thread needs a runner when none is detected on this machine", async () => {
    await openApp({ runners: [], instances: [buildClaudeCodeInstance([])], local: null });

    await waitFor(() => {
      expect(readPageText()).toContain("No runner has been detected on this machine.");
    });
    expect(getNewThreadControl().hasAttribute("disabled")).toBe(true);
  });

  it("sends the user to Fleet when the machine has no harness on it", async () => {
    await openApp({ runners: [BARE], instances: [buildClaudeCodeInstance([])], local: BARE.id });

    await waitFor(() => {
      expect(readPageText()).toContain("No coding harness was found on this machine.");
    });
    // Installing is an action on the runner's page, so the screen links there
    // rather than describing what to type.
    expect(screen.getByRole("link", { name: /fleet/i }).getAttribute("href")).toBe(
      `/fleet/${BARE.id}`,
    );
  });

  it("offers a login for an installed harness that is not logged in", async () => {
    await openApp({
      runners: [MOSS],
      instances: [buildClaudeCodeInstance([NOT_LOGGED_IN])],
      local: MOSS.id,
    });

    await waitFor(() => {
      expect(readPageText()).toContain("Claude Code was found on this machine.");
    });
    expect(screen.getByRole("button", { name: /log in/i })).toBeDefined();
    expect(getNewThreadControl().hasAttribute("disabled")).toBe(true);
  });

  it("is ready once the harness on this machine is logged in", async () => {
    await openApp({
      runners: [MOSS],
      instances: [buildClaudeCodeInstance([LOGGED_IN])],
      local: MOSS.id,
    });

    await waitFor(() => {
      expect(readPageText()).toContain("Claude Code is ready.");
    });
    // Ready means a thread can now be started from here: the control is a
    // link to the composer, not a disabled button.
    expect(getNewThreadControl().getAttribute("href")).toBe("/threads/new");
  });

  it("logs in from this screen, on the runner on the browser's machine", async () => {
    const user = userEvent.setup();
    let held = [buildClaudeCodeInstance([NOT_LOGGED_IN])];
    const { api } = await openApp({
      runners: [MOSS],
      instances: held,
      local: MOSS.id,
      extra: {
        "GET /api/v1/providers": () => ({ body: held }),
        [`POST /api/v1/providers/${CLAUDE_ID}/login`]: { body: { url: AUTHORIZE_URL } },
        [`POST /api/v1/providers/${CLAUDE_ID}/login-code`]: (call: Call) => {
          if ((call.body as { code: string }).code !== "the-whole-code") {
            return { status: 400, body: buildErrorBody("validation", "Invalid code.") };
          }
          held = [buildClaudeCodeInstance([LOGGED_IN])];
          return { body: LOGGED_IN };
        },
        // Every finished login is followed by a probe, so this screen shows
        // the machine's current login state.
        [`POST /api/v1/runners/${MOSS.id}/probe`]: () => ({ body: LOGGED_IN }),
      },
    });

    await user.click(await screen.findByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(readPageText()).toContain(AUTHORIZE_URL);
    });
    // The login runs on this machine's runner, whatever other runners the fleet has.
    expect(api.calls.filter((call) => call.path.endsWith("/login"))[0]?.body).toEqual({
      runnerId: MOSS.id,
    });

    await user.type(screen.getByLabelText("Code", { exact: true }), "the-whole-code");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    // Finishing the login updates the screen without a reload.
    await waitFor(() => {
      expect(readPageText()).toContain("Claude Code is ready.");
    });
  });

  it("shows the error when the probe after a login fails", async () => {
    const user = userEvent.setup();
    await openApp({
      runners: [MOSS],
      instances: [buildClaudeCodeInstance([NOT_LOGGED_IN])],
      local: MOSS.id,
      extra: {
        [`POST /api/v1/providers/${CLAUDE_ID}/login`]: { body: { url: AUTHORIZE_URL } },
        [`POST /api/v1/providers/${CLAUDE_ID}/login-code`]: { body: LOGGED_IN },
        [`POST /api/v1/runners/${MOSS.id}/probe`]: {
          status: 500,
          body: buildErrorBody("internal", "moss stopped answering"),
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: /log in/i }));
    await user.type(await screen.findByLabelText("Code", { exact: true }), "the-whole-code");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect((await screen.findByRole("alert")).textContent).toBe("moss stopped answering");
  });
});

/**
 * A provider that authenticates with a key rather than a vendor's browser
 * login. The screen offers the same action Fleet does, because both use the
 * same data: a harness that is installed but cannot run yet.
 */
describe("Sessions > a harness that needs a key", () => {
  const PI_ID = "01a06d02-1000-7000-8000-000000000003";
  const KEY_TITLE = "Z.ai API key";
  const KEY_DESCRIPTION = "From your Z.ai Coding Plan subscription.";
  const KEY_VALUE = "a-paid-credential-nobody-else-holds";

  const WITH_PI: Runner = {
    ...MOSS,
    facts: {
      ...MOSS.facts!,
      providers: [{ name: "pi", present: true, path: "/usr/local/bin/pi" }],
      adapters: ["pi"],
    },
  };

  const PI_SNAPSHOT = buildSnapshot({ status: "unauthenticated" });

  const buildPiInstance = (set: boolean) => ({
    ...buildClaudeCodeInstance([PI_SNAPSHOT]),
    id: PI_ID,
    providerId: "pi",
    name: "pi",
    displayName: "pi",
    binaryName: "pi",
    secretFields: [{ name: "zaiApiKey", title: KEY_TITLE, description: KEY_DESCRIPTION, set }],
  });

  it("asks for the key on this screen, and shows ready once it is saved", async () => {
    const user = userEvent.setup();
    let held = [buildPiInstance(false)];
    const { api } = await openApp({
      runners: [WITH_PI],
      instances: held,
      local: WITH_PI.id,
      extra: {
        "GET /api/v1/providers": () => ({ body: held }),
        [`PUT /api/v1/secrets/provider-instance/${PI_ID}/zaiApiKey`]: () => {
          held = [
            {
              ...buildPiInstance(true),
              snapshots: [buildSnapshot({ status: "ok", backend: "api_key" })],
            },
          ];
          return {
            body: {
              ownerKind: "provider-instance",
              ownerId: PI_ID,
              name: "zaiApiKey",
              createdAt: "2026-09-19T09:00:00.000Z",
            },
          };
        },
        [`POST /api/v1/runners/${WITH_PI.id}/probe`]: () => ({
          body: buildSnapshot({ status: "ok", backend: "api_key" }),
        }),
      },
    });

    await user.click(await screen.findByRole("button", { name: new RegExp(KEY_TITLE, "i") }));

    const form = await screen.findByRole("dialog", { name: KEY_TITLE });
    expect(form.textContent ?? "").toContain(KEY_DESCRIPTION);
    const field = within(form).getByLabelText<HTMLInputElement>(KEY_TITLE, { exact: true });
    expect(field.type).toBe("password");

    await user.type(field, KEY_VALUE);
    await user.click(within(form).getByRole("button", { name: /save/i }));

    // The key is saved, the runner is probed, and the screen updates without a reload.
    await waitFor(() => {
      expect(readPageText()).toContain("pi is ready.");
    });
    const wrote = api.calls.filter((call) => call.method === "PUT");
    expect(wrote).toHaveLength(1);
    expect(wrote[0]?.path).toBe(`/api/v1/secrets/provider-instance/${PI_ID}/zaiApiKey`);
    expect(wrote[0]?.body).toEqual({ value: KEY_VALUE });
    expect(readPageText()).not.toContain(KEY_VALUE);
  });
});
