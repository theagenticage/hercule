/**
 * Tests the provider login as the draft's Log in button opens it: the
 * dialog, the paste-back login of Claude Code, a refused code, a device-code
 * login that ends when the `provider` live topic brings a fresh snapshot, and
 * a device code that expires.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CapabilitySnapshot, ProviderInstance, Runner } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../app/testing";

const [WEBSHOP] = SIDEBAR_FIXTURE.projects;
const [MOSS_RECORD] = SIDEBAR_FIXTURE.runners;

/** moss, with Claude Code installed and its adapter in the runner's build. */
const MOSS: Runner = {
  ...MOSS_RECORD!,
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 64 * 1024 ** 3,
    docker: true,
    toolchains: [],
    providers: [{ name: "claude", present: true, path: "/opt/homebrew/bin/claude" }],
    adapters: ["claude-code"],
    identityPort: 4939,
  },
};

const LOGGED_IN = FIXTURE_INSTANCE.snapshots[0]!;

/** Returns the fixture instance with one snapshot on moss, probed at `probedAt`. */
const buildInstance = (
  auth: CapabilitySnapshot["auth"],
  probedAt = LOGGED_IN.probedAt,
): ProviderInstance => ({
  ...FIXTURE_INSTANCE,
  snapshots: [{ ...LOGGED_IN, auth, probedAt }],
});

const LOGGED_OUT = buildInstance({ status: "unauthenticated" });

const LOGIN_PATH = `/api/v1/providers/${FIXTURE_INSTANCE.id}/login`;
const CODE_PATH = `/api/v1/providers/${FIXTURE_INSTANCE.id}/login-code`;

/**
 * Opens a draft in webshop whose provider instance is not logged in on moss,
 * presses Log in after the reason, and returns the dialog with the app.
 * `providers` answers every read of the instances, so a test can change
 * what the controller holds.
 */
const openLogin = async (handlers: Readonly<Record<string, Handler>>) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [MOSS], providers: [LOGGED_OUT] }),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const linkOpen = vi.spyOn(fake.bridge.link, "open");
  const app = await renderApp(fake, { path: `/?project=${WEBSHOP!.id}` });
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.getByText("Can't start yet.").parentElement?.textContent).toBe(
    "Can't start yet. Claude Code is on moss but not logged in. Log in",
  );
  await userEvent.click(screen.getByRole("button", { name: "Log in" }));
  const dialog = await screen.findByRole<HTMLDialogElement>("dialog", {
    name: "Log in to Claude Code on moss",
  });
  return { calls, dialog, linkOpen, ...app };
};

/** Returns the requests sent to `path`. */
const readCalls = (calls: readonly Call[], path: string): readonly Call[] =>
  calls.filter((call) => call.method === "POST" && call.path === path);

describe("the provider login dialog", () => {
  it("starts a paste-back login as it opens, and closes once the code is accepted", async () => {
    let providers: readonly ProviderInstance[] = [LOGGED_OUT];
    const { calls, dialog, linkOpen } = await openLogin({
      "GET /api/v1/providers": () => ({ body: providers }),
      [`POST ${LOGIN_PATH}`]: { body: { url: "https://claude.ai/oauth/authorize?code=1" } },
      [`POST ${CODE_PATH}`]: () => {
        providers = [buildInstance({ status: "ok" }, "2026-09-10T09:00:00.000Z")];
        return { body: providers[0]!.snapshots[0] };
      },
    });

    const view = within(dialog);
    expect(view.getByText("/opt/homebrew/bin/claude")).toBeTruthy();
    await userEvent.click(await view.findByRole("button", { name: "Open sign-in page" }));
    expect(linkOpen).toHaveBeenCalledWith({ url: "https://claude.ai/oauth/authorize?code=1" });

    await userEvent.type(view.getByRole("textbox", { name: "Code" }), "  abc#123 {Enter}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(readCalls(calls, LOGIN_PATH)).toHaveLength(1);
    expect(readCalls(calls, CODE_PATH).map((call) => call.body)).toEqual([
      { runnerId: MOSS.id, code: "abc#123" },
    ]);
    expect(screen.queryByText("Can't start yet.")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
  });

  it("marks the field and says why when the vendor refuses the code, and stays open", async () => {
    const { dialog } = await openLogin({
      [`POST ${LOGIN_PATH}`]: { body: { url: "https://claude.ai/oauth/authorize?code=1" } },
      [`POST ${CODE_PATH}`]: {
        status: 400,
        body: {
          error: {
            code: "validation",
            message: "The login code was not accepted.",
            details: { issues: [{ path: ["code"], message: "that code was rejected" }] },
          },
        },
      },
    });

    const view = within(dialog);
    await userEvent.type(await view.findByRole("textbox", { name: "Code" }), "used-code{Enter}");

    expect((await view.findByRole("alert")).textContent).toBe(
      "That code wasn’t accepted. A code works once; open the sign-in page for a new one.",
    );
    expect(view.getByRole("textbox", { name: "Code" }).parentElement?.className).toBe(
      "field is-bad",
    );
    expect(dialog.open).toBe(true);
  });

  it("shows a device code, and closes when a fresh snapshot says the harness is logged in", async () => {
    let providers: readonly ProviderInstance[] = [LOGGED_OUT];
    const expiresAt = new Date(Date.now() + 14 * 60_000 + 30_000).toISOString();
    const { dialog, live } = await openLogin({
      "GET /api/v1/providers": () => ({ body: providers }),
      [`POST ${LOGIN_PATH}`]: {
        body: { url: "https://auth.openai.com/codex/device", userCode: "WXYZ-1234", expiresAt },
      },
    });

    const view = within(dialog);
    expect((await view.findByText("WXYZ-1234")).tagName).toBe("B");
    expect(view.getByRole("status").textContent).toBe(
      "Waiting for you to finish signing in. The code expires in 15 minutes.",
    );

    // An older snapshot that says logged in is not the login's result.
    providers = [buildInstance({ status: "ok" }, "2026-09-10T07:00:00.000Z")];
    live.pushInvalidation("provider");
    await waitFor(() => {
      expect(view.getByRole("status")).toBeTruthy();
    });

    providers = [buildInstance({ status: "ok" }, "2026-09-10T09:00:00.000Z")];
    live.pushInvalidation("provider");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.queryByText("Can't start yet.")).toBeNull();
  });

  it("says when the device code expired, and starts again on request", async () => {
    const { calls, dialog } = await openLogin({
      [`POST ${LOGIN_PATH}`]: () => ({
        body: {
          url: "https://auth.openai.com/codex/device",
          userCode: "WXYZ-1234",
          expiresAt: new Date(Date.now() + 300).toISOString(),
        },
      }),
    });

    const view = within(dialog);
    const expired = await view.findByRole("alert", {}, { timeout: 2000 });
    expect(expired.textContent).toBe("The code expired before the login finished.Start again");

    await userEvent.click(view.getByRole("button", { name: "Start again" }));

    await waitFor(() => {
      expect(readCalls(calls, LOGIN_PATH)).toHaveLength(2);
    });
  });
});
