/**
 * Tests the account sign-in as the draft's Sign in button opens it: the
 * dialog, the paste-back sign-in of Claude Code, a refused code, a device
 * login that ends when the `provider` live topic brings a fresh snapshot, and
 * a device code that expires.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CapabilitySnapshot, ProviderAccount, Runner } from "@hercule/contract";
import { PROVIDERS } from "@hercule/client-core/testing";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_ACCOUNT,
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
    harnesses: [{ name: "claude", present: true, path: "/opt/homebrew/bin/claude" }],
    adapters: ["claude-code/claude-code"],
    identityPort: 4939,
  },
};

const SIGNED_IN = FIXTURE_ACCOUNT.snapshots[0]!;

/**
 * Returns the fixture account with one snapshot on moss, probed at `probedAt`,
 * and its readiness there: ready when the snapshot is signed in, else not
 * signed in.
 */
const buildAccount = (
  auth: CapabilitySnapshot["auth"],
  probedAt = SIGNED_IN.probedAt,
): ProviderAccount => ({
  ...FIXTURE_ACCOUNT,
  snapshots: [{ ...SIGNED_IN, auth, probedAt }],
  readiness: [
    { ...FIXTURE_ACCOUNT.readiness[0]!, state: auth.status === "ok" ? "ready" : "not-signed-in" },
  ],
});

const SIGNED_OUT = buildAccount({ status: "unauthenticated" });

const SIGN_IN_PATH = `/api/v1/provider-accounts/${FIXTURE_ACCOUNT.id}/sign-in`;
const CODE_PATH = `/api/v1/provider-accounts/${FIXTURE_ACCOUNT.id}/sign-in-code`;

/**
 * Opens a draft in webshop whose account is not signed in on moss,
 * presses Sign in after the reason, and returns the dialog with the app.
 * A handler for `GET /api/v1/provider-accounts` answers every read of the
 * accounts, so a test can change what the controller holds.
 */
const openSignIn = async (handlers: Readonly<Record<string, Handler>>) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [MOSS], accounts: [SIGNED_OUT] }),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const linkOpen = vi.spyOn(fake.bridge.link, "open");
  const app = await renderApp(fake, { path: `/?project=${WEBSHOP!.id}` });
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.getByText("Can't start yet.").parentElement?.textContent).toBe(
    "Can't start yet. Anthropic is not signed in on moss. Sign in",
  );
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  const dialog = await screen.findByRole<HTMLDialogElement>("dialog", {
    name: "Sign in to Anthropic on moss",
  });
  return { calls, dialog, linkOpen, ...app };
};

/** Returns the requests sent to `path`. */
const readCalls = (calls: readonly Call[], path: string): readonly Call[] =>
  calls.filter((call) => call.method === "POST" && call.path === path);

describe("the provider sign-in dialog", () => {
  it("starts a paste-back sign-in as it opens, and closes once the code is accepted", async () => {
    let accounts: readonly ProviderAccount[] = [SIGNED_OUT];
    const { calls, dialog, linkOpen } = await openSignIn({
      "GET /api/v1/provider-accounts": () => ({ body: accounts }),
      [`POST ${SIGN_IN_PATH}`]: { body: { url: "https://claude.ai/oauth/authorize?code=1" } },
      [`POST ${CODE_PATH}`]: () => {
        accounts = [buildAccount({ status: "ok" }, "2026-09-10T09:00:00.000Z")];
        return { body: accounts[0] };
      },
    });

    const view = within(dialog);
    expect(view.getByText("Claude Code · /opt/homebrew/bin/claude")).toBeTruthy();
    await userEvent.click(await view.findByRole("button", { name: "Open sign-in page" }));
    expect(linkOpen).toHaveBeenCalledWith({ url: "https://claude.ai/oauth/authorize?code=1" });

    await userEvent.type(view.getByRole("textbox", { name: "Code" }), "  abc#123 {Enter}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(readCalls(calls, SIGN_IN_PATH)).toHaveLength(1);
    expect(readCalls(calls, CODE_PATH).map((call) => call.body)).toEqual([
      { runnerId: MOSS.id, code: "abc#123" },
    ]);
    expect(screen.queryByText("Can't start yet.")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
  });

  it("marks the field and says why when the vendor refuses the code, and stays open", async () => {
    const { dialog } = await openSignIn({
      [`POST ${SIGN_IN_PATH}`]: { body: { url: "https://claude.ai/oauth/authorize?code=1" } },
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

  it("shows a device code, and closes when a fresh snapshot says the account is signed in", async () => {
    let accounts: readonly ProviderAccount[] = [SIGNED_OUT];
    const expiresAt = new Date(Date.now() + 14 * 60_000 + 30_000).toISOString();
    const { dialog, live } = await openSignIn({
      "GET /api/v1/provider-accounts": () => ({ body: accounts }),
      [`POST ${SIGN_IN_PATH}`]: {
        body: { url: "https://auth.openai.com/codex/device", userCode: "WXYZ-1234", expiresAt },
      },
    });

    const view = within(dialog);
    expect((await view.findByText("WXYZ-1234")).tagName).toBe("B");
    expect(view.getByRole("status").textContent).toBe(
      "Waiting for you to finish signing in. The code expires in 15 minutes.",
    );

    // An older snapshot that says signed in is not the sign-in's result.
    accounts = [buildAccount({ status: "ok" }, "2026-09-10T07:00:00.000Z")];
    live.pushInvalidation("provider");
    await waitFor(() => {
      expect(view.getByRole("status")).toBeTruthy();
    });

    accounts = [buildAccount({ status: "ok" }, "2026-09-10T09:00:00.000Z")];
    live.pushInvalidation("provider");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.queryByText("Can't start yet.")).toBeNull();
  });

  it("starts making a new token when the token of a token account expired, though its last probe found it signed in", async () => {
    const providers = PROVIDERS.map((provider) =>
      provider.id === "anthropic/anthropic"
        ? {
            ...provider,
            kinds: [
              {
                id: "subscription-token",
                title: "Claude subscription, every machine",
                description: "A token.",
                setup: [{ kind: "harness-login" as const, method: "create-token" as const }],
                harnesses: ["claude-code/claude-code"],
              },
            ],
          }
        : provider,
    );
    const expired: ProviderAccount = {
      ...FIXTURE_ACCOUNT,
      kind: "subscription-token",
      expiresAt: "2020-01-01T00:00:00.000Z",
      readiness: [{ ...FIXTURE_ACCOUNT.readiness[0]!, state: "token-expired" }],
    };
    const calls = stubApi({
      ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [MOSS], accounts: [expired] }),
      "GET /api/v1/providers": { body: providers },
      [`POST ${SIGN_IN_PATH}`]: { body: { url: "https://claude.ai/oauth/authorize?code=1" } },
    });
    const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
    await renderApp(fake, { path: `/?project=${WEBSHOP!.id}` });
    await screen.findByRole("textbox", { name: "Message" });

    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    const dialog = await screen.findByRole<HTMLDialogElement>("dialog", {
      name: "Sign in to Anthropic on moss",
    });
    await waitFor(() => {
      expect(readCalls(calls, SIGN_IN_PATH)).toHaveLength(1);
    });
    expect(within(dialog).queryByText("Signed in")).toBeNull();
  });

  it("says when the device code expired, and starts again on request", async () => {
    const { calls, dialog } = await openSignIn({
      [`POST ${SIGN_IN_PATH}`]: () => ({
        body: {
          url: "https://auth.openai.com/codex/device",
          userCode: "WXYZ-1234",
          expiresAt: new Date(Date.now() + 300).toISOString(),
        },
      }),
    });

    const view = within(dialog);
    const expired = await view.findByRole("alert");
    expect(expired.textContent).toBe("The code expired before the sign-in finished.Start again");

    await userEvent.click(view.getByRole("button", { name: "Start again" }));

    await waitFor(() => {
      expect(readCalls(calls, SIGN_IN_PATH)).toHaveLength(2);
    });
  });
});
