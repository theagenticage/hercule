/**
 * The login panel on its own, over a stubbed API. Two flows reach it: the one
 * where the vendor asks for a code the user pastes back, and the one where the
 * vendor printed the code itself and the browser finishes the exchange alone -
 * which this panel only shows, never relays.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient } from "@hydra/client-core";
import { ProviderLogin } from "./provider-login";
import { reading, stubApi, type Handler } from "../app/testing";

const BASE = "http://controller.test";

const INSTANCE = "01a06d02-1000-7000-8000-000000000001";
const RUNNER = "01a06d02-1000-7000-8000-0000000000aa";

const PASTE_URL = "https://claude.ai/oauth/authorize?code=challenge";
const DEVICE_URL = "https://auth.openai.com/codex/device";
const USER_CODE = "CH61-0FI2N";

const LOGIN = `POST /api/v1/providers/${INSTANCE}/login`;
const LOGIN_CODE = `POST /api/v1/providers/${INSTANCE}/login-code`;

/** What the follow-up probe leaves behind; the panel only needs it to be valid. */
const SNAPSHOT = {
  runnerId: RUNNER,
  probedAt: "2026-09-14T09:10:00.000Z",
  harnessVersion: "0.154.0",
  versionVerdict: "ok",
  auth: { status: "ok", identity: "rogier@example.com" },
  models: [],
};

const sentCodes = (api: ReturnType<typeof stubApi>) =>
  api.calls.filter((call) => call.path.endsWith("/login-code"));

/** Mounts the panel and presses the button that starts a login. */
const opened = async (handlers: Readonly<Record<string, Handler>>) => {
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

describe("a login the vendor printed a code for", () => {
  it("shows the code, asks for nothing, and is done when the user says so", async () => {
    const { api, user, onLoggedIn } = await opened({
      [LOGIN]: { body: { url: DEVICE_URL, userCode: USER_CODE } },
      [LOGIN_CODE]: { body: SNAPSHOT },
    });

    await waitFor(() => {
      expect(reading()).toContain(USER_CODE);
    });
    expect(reading()).toContain(DEVICE_URL);
    // What to do when the browser cannot reach this machine at all.
    expect(reading()).toContain("ssh -L 1455:localhost:1455");
    expect(reading()).toContain("auth.json");
    // Both are long enough to mistype and neither can be read off a terminal.
    expect(screen.getByRole("button", { name: "Copy code" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeDefined();
    // The code is typed into the browser, never back into Hydra.
    expect(screen.queryByLabelText("Code", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
    // A second login would kill the child whose code is on screen.
    expect(screen.getByRole("button", { name: "Log in" })).toHaveProperty("disabled", true);

    // Nothing is relayed and nothing is waited on: the browser and the vendor
    // finish this between themselves.
    expect(sentCodes(api)).toEqual([]);
    expect(onLoggedIn).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
    expect(sentCodes(api)).toEqual([]);
  });
});

describe("a login the vendor wants a code pasted into", () => {
  it("asks for the code and waits for the user to send it", async () => {
    const { api } = await opened({
      [LOGIN]: { body: { url: PASTE_URL } },
      [LOGIN_CODE]: { body: SNAPSHOT },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Code", { exact: true })).toBeDefined();
    });
    expect(screen.getByRole("button", { name: /submit/i })).toBeDefined();
    expect(sentCodes(api)).toEqual([]);
  });
});
