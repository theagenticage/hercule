/**
 * The Sessions screen over a stubbed controller. On a fresh install it is the
 * rest of onboarding: the one place that tells the user what stands between
 * them and a thread.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Runner } from "@hydra/contract";
import { envelope, renderApp, stubApi, type Call, type Handler } from "../../app/testing";

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

const snapshot = (auth: Readonly<Record<string, string>>) => ({
  runnerId: MOSS.id,
  probedAt: "2026-09-05T09:14:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth,
  models: [{ slug: "default", name: "Default", options: [] }],
});

const claudeCode = (snapshots: ReadonlyArray<ReturnType<typeof snapshot>>) => ({
  id: CLAUDE_ID,
  providerId: "claude-code",
  name: "Claude Code",
  config: {},
  displayName: "Claude Code",
  binaryName: "claude",
  declared: DECLARED,
  snapshots,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

const LOGGED_IN = snapshot({
  status: "ok",
  identity: "rogier@example.com",
  planLabel: "Claude Max",
});

const NOT_LOGGED_IN = snapshot({ status: "unauthenticated" });

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize?code=challenge";

const controller = (
  runners: ReadonlyArray<Runner>,
  instances: ReadonlyArray<ReturnType<typeof claudeCode>>,
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

const open = async (options: {
  readonly runners: ReadonlyArray<Runner>;
  readonly instances: ReadonlyArray<ReturnType<typeof claudeCode>>;
  readonly local?: string | null;
  readonly extra?: Readonly<Record<string, Handler>>;
}) => {
  const api = stubApi(controller(options.runners, options.instances, options.extra));
  const app = await renderApp({
    path: "/",
    api: api.fetch,
    token: "held",
    detectLocalRunner: () => Promise.resolve(options.local ?? null),
  });
  return { ...app, api };
};

const reading = (): string => (document.body.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * The screen's own control: the sidebar's thread list carries one too. It is a
 * disabled button until the machine is ready, then a real link to the composer.
 */
const newThread = (): HTMLElement => {
  const found = [
    ...screen.queryAllByRole("button", { name: /create new thread/i }),
    ...screen.queryAllByRole("link", { name: /create new thread/i }),
  ].filter((element) => element.closest("nav") === null);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe("Sessions", () => {
  it("says a thread needs a machine when nothing answered on this one", async () => {
    await open({ runners: [], instances: [claudeCode([])], local: null });

    await waitFor(() => {
      expect(reading()).toContain("No runner has been detected on this machine.");
    });
    expect(newThread().hasAttribute("disabled")).toBe(true);
  });

  it("sends the user to Fleet when the machine has no harness on it", async () => {
    await open({ runners: [BARE], instances: [claudeCode([])], local: BARE.id });

    await waitFor(() => {
      expect(reading()).toContain("No coding harness was found on this machine.");
    });
    // The install is a move on the machine, so the screen points at the page
    // that makes it rather than describing what to type.
    expect(screen.getByRole("link", { name: /fleet/i }).getAttribute("href")).toBe(
      `/fleet/${BARE.id}`,
    );
  });

  it("offers a login for a harness that is there and not logged in", async () => {
    await open({ runners: [MOSS], instances: [claudeCode([NOT_LOGGED_IN])], local: MOSS.id });

    await waitFor(() => {
      expect(reading()).toContain("Claude Code was found on this machine.");
    });
    expect(screen.getByRole("button", { name: /log in/i })).toBeDefined();
    expect(newThread().hasAttribute("disabled")).toBe(true);
  });

  it("is ready once the harness on this machine is logged in", async () => {
    await open({ runners: [MOSS], instances: [claudeCode([LOGGED_IN])], local: MOSS.id });

    await waitFor(() => {
      expect(reading()).toContain("Claude Code is ready.");
    });
    // Ready means a thread actually starts from here now: a link to the
    // composer, not a disabled placeholder.
    expect(newThread().getAttribute("href")).toBe("/threads/new");
  });

  it("logs in from here, against the machine this browser is on", async () => {
    const user = userEvent.setup();
    let held = [claudeCode([NOT_LOGGED_IN])];
    const { api } = await open({
      runners: [MOSS],
      instances: held,
      local: MOSS.id,
      extra: {
        "GET /api/v1/providers": () => ({ body: held }),
        [`POST /api/v1/providers/${CLAUDE_ID}/login`]: { body: { url: AUTHORIZE_URL } },
        [`POST /api/v1/providers/${CLAUDE_ID}/login-code`]: (call: Call) => {
          if ((call.body as { code: string }).code !== "the-whole-code") {
            return { status: 400, body: envelope("validation", "Invalid code.") };
          }
          held = [claudeCode([LOGGED_IN])];
          return { body: LOGGED_IN };
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(reading()).toContain(AUTHORIZE_URL);
    });
    // The login runs on this machine, whatever else the fleet holds.
    expect(api.calls.filter((call) => call.path.endsWith("/login"))[0]?.body).toEqual({
      runnerId: MOSS.id,
    });

    await user.type(screen.getByLabelText("Code", { exact: true }), "the-whole-code");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    // Finishing the login moves the screen on, without a reload.
    await waitFor(() => {
      expect(reading()).toContain("Claude Code is ready.");
    });
  });
});
