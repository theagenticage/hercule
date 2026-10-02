/**
 * Tests the login drawer on its own, against a stubbed API. It covers two
 * flows:
 *
 * - the vendor gives the user a code in the browser, which the user pastes
 *   back here;
 * - the vendor printed a one-time code, and the browser completes the login
 *   on its own. The drawer shows the code, sends nothing, and closes once a
 *   snapshot taken after the login started says the harness is logged in.
 *
 * It also checks that the login address is a link only when it is a web
 * address.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient, queryKeys, type Live, type LiveQueryKey } from "@hercule/client-core";
import { ProviderLogin } from "./provider-login";
import { expectInDocumentOrder, readPageText, stubApi, type Handler } from "../app/testing";

const BASE = "http://controller.test";

const INSTANCE = "01a06d02-1000-7000-8000-000000000001";
const RUNNER = "01a06d02-1000-7000-8000-0000000000aa";

const PASTE_URL = "https://claude.ai/oauth/authorize?code=challenge";
const DEVICE_URL = "https://auth.openai.com/codex/device";
const USER_CODE = "CH61-0FI2N";

const LOGIN = `POST /api/v1/providers/${INSTANCE}/login`;
const LOGIN_CODE = `POST /api/v1/providers/${INSTANCE}/login-code`;
const PROVIDERS = "GET /api/v1/providers";

/** The probe result the login code endpoint returns; the drawer only needs it to be valid. */
const SNAPSHOT = {
  runnerId: RUNNER,
  probedAt: "2026-09-14T09:10:00.000Z",
  harnessVersion: "0.154.0",
  versionVerdict: "ok",
  auth: { status: "ok", identity: "rogier@example.com" },
  models: [],
};

const listSentCodes = (api: ReturnType<typeof stubApi>) =>
  api.calls.filter((call) => call.path.endsWith("/login-code"));

/** Returns the Codex instance as the controller lists it, with `snapshot` as its only snapshot. */
const buildCodex = (snapshot: object) => ({
  id: INSTANCE,
  providerId: "codex",
  name: "Codex",
  config: {},
  displayName: "Codex",
  binaryName: "codex",
  declared: {
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
  },
  secretFields: [],
  snapshots: [snapshot],
  createdAt: "2026-09-14T09:00:00.000Z",
  updatedAt: "2026-09-14T09:00:00.000Z",
});

/** The snapshot from before the login started: the harness is logged out. */
const LOGGED_OUT = { ...SNAPSHOT, auth: { status: "unauthenticated" } };
/** The snapshot the probe takes after the vendor's login ended. */
const LOGGED_IN = { ...SNAPSHOT, probedAt: "2026-09-14T09:12:00.000Z" };

/**
 * Returns a live connection that only records subscriptions. `announce`
 * delivers a push that lists `keys`, as the controller does when a topic's
 * records change.
 */
const buildFakeLive = (): { live: Live; announce: (keys: readonly LiveQueryKey[]) => void } => {
  const handlers = new Set<(keys: readonly LiveQueryKey[]) => void>();
  const subscribe = (_topic: string, handler: (keys: readonly LiveQueryKey[]) => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  };
  const live: Live = {
    start: () => undefined,
    stop: () => Promise.resolve(),
    subscribe: subscribe as Live["subscribe"],
    onStatus: () => () => undefined,
    serverVersion: null,
  };
  return {
    live,
    announce: (keys) => {
      for (const handler of handlers) handler(keys);
    },
  };
};

/** Renders the Log in button and clicks it to start a login. */
const openLoginPanel = async (handlers: Readonly<Record<string, Handler>>) => {
  const api = stubApi(handlers);
  const { live, announce } = buildFakeLive();
  const onLoggedIn = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProviderLogin
        client={createClient({ baseUrl: BASE, fetch: api.fetch, token: "held" })}
        live={live}
        instanceId={INSTANCE}
        runnerId={RUNNER}
        subject="Codex on moss"
        label="Log in"
        onLoggedIn={onLoggedIn}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Log in" }));
  return { api, user, onLoggedIn, announce };
};

/** Returns the instant a code expires, `minutesFromNow` minutes from now; negative is in the past. */
const buildExpiresAt = (minutesFromNow: number): string =>
  new Date(Date.now() + minutesFromNow * 60_000).toISOString();

/**
 * Answers the providers read with the logged-out snapshot until `loggedIn` is
 * called, and with the fresh logged-in one after that.
 */
const stubProviders = (): { handler: Handler; loggedIn: () => void } => {
  let snapshot: object = LOGGED_OUT;
  return {
    handler: () => ({ body: [buildCodex(snapshot)] }),
    loggedIn: () => {
      snapshot = LOGGED_IN;
    },
  };
};

describe("a login with a one-time code from the vendor", () => {
  it("shows the code, asks for no input, and closes once a fresh snapshot is logged in", async () => {
    const providers = stubProviders();
    const { api, onLoggedIn, announce } = await openLoginPanel({
      [LOGIN]: { body: { url: DEVICE_URL, userCode: USER_CODE, expiresAt: buildExpiresAt(15) } },
      [LOGIN_CODE]: { body: SNAPSHOT },
      [PROVIDERS]: providers.handler,
    });

    await waitFor(() => {
      expect(readPageText()).toContain(USER_CODE);
    });
    expect(readPageText()).toContain(DEVICE_URL);
    // The fallback instructions for when the browser cannot reach this machine at all.
    expect(readPageText()).toContain("ssh -L 1455:localhost:1455");
    expect(readPageText()).toContain("auth.json");
    // Both are long enough to mistype, so both get a copy button.
    expect(screen.getByRole("button", { name: "Copy code" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeDefined();
    // The code is typed into the browser, never back into Hercule.
    expect(screen.queryByLabelText("Code", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
    // A second login would kill the process whose code is on screen.
    expect(screen.getByRole("button", { name: "Log in" })).toHaveProperty("disabled", true);

    // Nothing is sent: the browser and the vendor complete the login between
    // them. The drawer waits for the controller to announce the result.
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "The code works for 15 more minutes.",
      );
    });
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(listSentCodes(api)).toEqual([]);
    expect(onLoggedIn).not.toHaveBeenCalled();

    // An announcement while the harness is still logged out keeps the drawer open.
    const countProviderReads = () =>
      api.calls.filter((call) => call.path === "/api/v1/providers").length;
    const before = countProviderReads();
    act(() => {
      announce([queryKeys.providers()]);
    });
    await waitFor(() => {
      expect(countProviderReads()).toBeGreaterThan(before);
    });
    expect(screen.getByRole("dialog")).toBeDefined();

    providers.loggedIn();
    act(() => {
      announce([queryKeys.providers()]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
    expect(listSentCodes(api)).toEqual([]);
  });

  it("says the code expired and offers to start again", async () => {
    const providers = stubProviders();
    const { user, api } = await openLoginPanel({
      [LOGIN]: { body: { url: DEVICE_URL, userCode: USER_CODE, expiresAt: buildExpiresAt(-1) } },
      [PROVIDERS]: providers.handler,
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The code expired before the login finished.");
    await user.click(screen.getByRole("button", { name: "Start again" }));
    await waitFor(() => {
      expect(api.calls.filter((call) => call.path.endsWith("/login"))).toHaveLength(2);
    });
  });
});

describe("a login where the user pastes back a code", () => {
  it("asks for the code and waits for the user to submit it", async () => {
    const { api } = await openLoginPanel({
      [LOGIN]: { body: { url: PASTE_URL } },
      [LOGIN_CODE]: { body: SNAPSHOT },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Code", { exact: true })).toBeDefined();
    });
    // Cancel comes first and Submit last, as everywhere in the app.
    expectInDocumentOrder([
      screen.getByRole("button", { name: "Cancel" }),
      screen.getByRole("button", { name: /submit/i }),
    ]);
    expect(listSentCodes(api)).toEqual([]);
  });
});

describe("the login address", () => {
  it("is a link when it is a web address", async () => {
    await openLoginPanel({ [LOGIN]: { body: { url: PASTE_URL } } });

    const link = await screen.findByRole("link", { name: PASTE_URL });
    expect(link.getAttribute("href")).toBe(PASTE_URL);
  });

  it("is shown as text, not a link, when it is not a web address", async () => {
    const dataUrl = "data:text/html,<h1>Sign in</h1>";
    await openLoginPanel({ [LOGIN]: { body: { url: dataUrl } } });

    await waitFor(() => {
      expect(readPageText()).toContain(dataUrl);
    });
    expect(screen.queryByRole("link")).toBeNull();
  });
});
