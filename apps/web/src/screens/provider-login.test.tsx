/**
 * Tests the login drawer on its own, against a stubbed API. It covers two
 * flows:
 *
 * - the vendor gives the user a code in the browser, which the user pastes
 *   back here;
 * - the vendor printed a one-time code, and the browser completes the login
 *   on its own. The drawer only shows the code and sends nothing.
 *
 * It also checks that the login address is a link only when it is a web
 * address.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient } from "@hercule/client-core";
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

/** Renders the Log in button and clicks it to start a login. */
const openLoginPanel = async (handlers: Readonly<Record<string, Handler>>) => {
  const api = stubApi(handlers);
  const onLoggedIn = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProviderLogin
        client={createClient({ baseUrl: BASE, fetch: api.fetch, token: "held" })}
        instanceId={INSTANCE}
        runnerId={RUNNER}
        subject="Codex on moss"
        label="Log in"
        onLoggedIn={onLoggedIn}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Log in" }));
  return { api, user, onLoggedIn };
};

describe("a login with a one-time code from the vendor", () => {
  it("shows the code, asks for no input, and finishes when the user clicks Done", async () => {
    const { api, user, onLoggedIn } = await openLoginPanel({
      [LOGIN]: { body: { url: DEVICE_URL, userCode: USER_CODE } },
      [LOGIN_CODE]: { body: SNAPSHOT },
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

    // Nothing is sent and nothing is awaited: the browser and the vendor
    // complete the login between them.
    expect(listSentCodes(api)).toEqual([]);
    expect(onLoggedIn).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
    expect(listSentCodes(api)).toEqual([]);
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
