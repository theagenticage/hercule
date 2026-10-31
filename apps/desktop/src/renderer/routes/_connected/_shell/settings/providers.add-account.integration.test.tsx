/**
 * Tests the add-account sheet of Settings > Providers from the header's Add an
 * account: a key account made in one request, the controller's refusal of a
 * key (under the key's field), an account that signs in on a machine (its
 * label asked before the sign-in, the sign-in dialog, Done, the harness
 * installed from the sheet's own button), a token made with the pasted code,
 * Discard, which deletes an account the sign-in never finished, also when the
 * delete is refused, and the sheet staying shut to Esc, the scrim and its
 * buttons while the account is being created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PROVIDERS } from "@hercule/client-core/testing";
import type { AccountKind, Provider, ProviderAccount, Runner } from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_ACCOUNT,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Handler,
} from "../../../../app/testing";

vi.mock("../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

beforeEach(() => {
  stubElementSize(272, 800);
});
afterEach(forgetLastSettingsSection);

const [MOSS_RECORD] = SIDEBAR_FIXTURE.runners;

/** moss, online, with Claude Code installed and its adapter in the runner's build. */
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

const TOKEN_KIND: AccountKind = {
  id: "subscription-token",
  title: "Claude subscription, every machine",
  description: "Sign in once and every machine uses it. The token lasts a year.",
  setup: [{ kind: "harness-login", method: "create-token" }],
  harnesses: ["claude-code/claude-code"],
};
const KEY_KIND: AccountKind = {
  id: "api-key",
  title: "API key",
  description: "Pay per use with a key from the Anthropic console.",
  setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
  harnesses: ["claude-code/claude-code", "pi/pi"],
};

/** The shipped providers, with the Claude subscription token and an API key beside Anthropic's subscription. */
const TEST_PROVIDERS: ReadonlyArray<Provider> = PROVIDERS.map((provider) =>
  provider.id === "anthropic/anthropic"
    ? { ...provider, kinds: [TOKEN_KIND, ...provider.kinds, KEY_KIND] }
    : provider,
);

/** Anthropic · personal: signed in on moss. */
const PERSONAL: ProviderAccount = { ...FIXTURE_ACCOUNT, label: "personal" };

/** The account the controller creates, as the request asked for it. */
const buildCreated = (
  id: string,
  providerId: string,
  kind: string,
  label: string | null,
  defaultHarnessId: string,
): ProviderAccount => ({
  id,
  providerId,
  kind,
  label,
  identity: null,
  planLabel: null,
  defaultHarnessId,
  expiresAt: null,
  usage: [],
  failure: null,
  snapshots: [],
  createdAt: PERSONAL.createdAt,
  updatedAt: PERSONAL.updatedAt,
});

const ACCOUNTS_PATH = "/api/v1/provider-accounts";

/**
 * Opens Settings > Providers with `accounts` held by the controller, which
 * `handlers` change: `stored` is what the controller holds, so a test's
 * create and delete handlers change what a later read answers.
 */
const openProviders = async ({
  stored,
  handlers = {},
}: {
  readonly stored: ProviderAccount[];
  readonly handlers?: Readonly<Record<string, Handler>>;
}) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [MOSS], accounts: stored }),
    "GET /api/v1/providers": { body: TEST_PROVIDERS },
    "GET /api/v1/controller": {
      body: {
        id: "01a06d02-7800-7000-8000-000000000001",
        publicKey: "controller-key",
        version: "0.4.2",
        defaultRunnerId: null,
        localRunnerId: MOSS.id,
        textGeneration: { model: null, lastFailure: null, unavailableReason: null },
      },
    },
    [`GET ${ACCOUNTS_PATH}`]: () => ({ body: stored }),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path: "/settings/providers" });
  await screen.findByRole("heading", { level: 1, name: "Providers" });
  return { calls, ...app };
};

/** Presses the header's Add an account and returns the sheet. */
const openSheet = async (): Promise<HTMLElement> => {
  await userEvent.click(screen.getByRole("button", { name: "Add an account" }));
  return screen.findByRole("dialog", { name: "Add an account" });
};

describe("Settings > Providers, Add an account", () => {
  it("offers one tile per provider, then the kinds of the one picked", async () => {
    await openProviders({ stored: [PERSONAL] });

    const sheet = await openSheet();
    expect(
      within(sheet)
        .getAllByRole("button", { name: /^(Anthropic|OpenAI|Z\.ai)$/ })
        .map((tile) => tile.querySelector("b")?.textContent),
    ).toEqual(["Anthropic", "OpenAI", "Z.ai"]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Anthropic" }));

    const picked = await screen.findByRole("dialog", { name: "Add Anthropic" });
    expect(
      within(picked)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")?.querySelector("b")?.textContent),
    ).toEqual([TOKEN_KIND.title, "Claude subscription", KEY_KIND.title]);
    // Continue waits for a kind.
    expect(
      within(picked).getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled,
    ).toBe(true);
  });

  it("creates a key account in one request with the key, and its card appears", async () => {
    const stored: ProviderAccount[] = [PERSONAL];
    const { calls } = await openProviders({
      stored,
      handlers: {
        [`POST ${ACCOUNTS_PATH}`]: () => {
          const created = buildCreated(
            "01a06d02-8000-7000-8000-0000000000c1",
            "zai/zai",
            "api-key",
            null,
            "pi/pi",
          );
          stored.push(created);
          return { body: created };
        },
      },
    });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Z.ai" }));
    const keyStep = await screen.findByRole("dialog", { name: "Add Z.ai" });

    // The key kind is the provider's only one, and Z.ai has no account yet, so
    // the key is the only thing asked.
    const done = within(keyStep).getByRole<HTMLButtonElement>("button", { name: "Done" });
    expect(done.disabled).toBe(true);
    await userEvent.type(within(keyStep).getByLabelText("API key"), "  zai-key-123 ");
    await userEvent.click(done);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(
      calls
        .filter((call) => call.method === "POST" && call.path === ACCOUNTS_PATH)
        .map((call) => call.body),
    ).toEqual([{ providerId: "zai/zai", kind: "api-key", credentials: { apiKey: "zai-key-123" } }]);
    expect(await screen.findByRole("button", { name: /^Z\.ai/ })).toBeTruthy();
  });

  it("shows the controller's refusal of a key under the key's field, not in the sheet, and keeps the typed key", async () => {
    const stored: ProviderAccount[] = [PERSONAL];
    await openProviders({
      stored,
      handlers: {
        [`POST ${ACCOUNTS_PATH}`]: {
          status: 400,
          body: {
            error: {
              code: "validation",
              message: "Key refused: invalid x-api-key",
              details: {
                issues: [{ path: ["credentials", "apiKey"], message: "invalid x-api-key" }],
              },
            },
          },
        },
      },
    });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Z.ai" }));
    const keyStep = await screen.findByRole("dialog", { name: "Add Z.ai" });
    await userEvent.type(within(keyStep).getByLabelText("API key"), "wrong-key");

    await userEvent.click(within(keyStep).getByRole("button", { name: "Done" }));

    const refusal = await within(keyStep).findByRole("alert");
    expect(refusal.textContent).toBe("invalid x-api-key");
    // The message sits in the key's field, and nothing repeats it below the form.
    expect(refusal.closest(".credential-fields")).not.toBeNull();
    expect(within(keyStep).getAllByRole("alert")).toHaveLength(1);
    expect(within(keyStep).getByLabelText<HTMLInputElement>("API key").value).toBe("wrong-key");
    expect(screen.queryByRole("button", { name: /^Z\.ai/ })).toBeNull();
  });

  it("shows a refused key in the sheet when the create was sent from the name step, where the key's field is not drawn", async () => {
    await openProviders({
      stored: [PERSONAL],
      handlers: {
        [`POST ${ACCOUNTS_PATH}`]: {
          status: 400,
          body: {
            error: {
              code: "validation",
              message: "Key refused: invalid x-api-key",
              details: {
                issues: [{ path: ["credentials", "apiKey"], message: "invalid x-api-key" }],
              },
            },
          },
        },
      },
    });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Anthropic" }));
    const kind = await screen.findByRole("dialog", { name: "Add Anthropic" });
    await userEvent.click(within(kind).getByText(KEY_KIND.title));
    await userEvent.click(within(kind).getByRole("button", { name: "Continue" }));
    await userEvent.type(within(kind).getByLabelText("API key"), "wrong-key");
    await userEvent.click(within(kind).getByRole("button", { name: "Continue" }));
    // Anthropic has an account already, so the key is followed by a name.
    await userEvent.type(await within(kind).findByLabelText("Name"), "second");

    await userEvent.click(within(kind).getByRole("button", { name: "Done" }));

    const refusal = await within(kind).findByRole("alert");
    expect(refusal.textContent).toContain("invalid x-api-key");
    expect(within(kind).getAllByRole("alert")).toHaveLength(1);
    await userEvent.click(within(kind).getByRole("button", { name: "Back" }));
    expect(within(kind).getByLabelText<HTMLInputElement>("API key").value).toBe("wrong-key");
  });

  it("shows a failure that belongs to no field, such as an unreachable provider, in the sheet", async () => {
    await openProviders({
      stored: [PERSONAL],
      handlers: {
        [`POST ${ACCOUNTS_PATH}`]: {
          status: 409,
          body: buildErrorBody(
            "invalid_state",
            "Could not reach Z.ai to check the key. Try again.",
          ),
        },
      },
    });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Z.ai" }));
    const keyStep = await screen.findByRole("dialog", { name: "Add Z.ai" });
    await userEvent.type(within(keyStep).getByLabelText("API key"), "zai-key-123");

    await userEvent.click(within(keyStep).getByRole("button", { name: "Done" }));

    const alert = await within(keyStep).findByRole("alert");
    expect(alert.textContent).toBe("Could not reach Z.ai to check the key. Try again.");
    expect(alert.closest(".credential-fields")).toBeNull();
  });

  it("cannot be left while the account is being created, so no account is made after a cancel", async () => {
    const stored: ProviderAccount[] = [PERSONAL];
    let finishCreate: () => void = () => undefined;
    const created = buildCreated(
      "01a06d02-8000-7000-8000-0000000000c4",
      "zai/zai",
      "api-key",
      null,
      "pi/pi",
    );
    await openProviders({
      stored,
      handlers: {
        [`POST ${ACCOUNTS_PATH}`]: () =>
          new Promise((resolve) => {
            finishCreate = () => {
              stored.push(created);
              resolve({ body: created });
            };
          }),
      },
    });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Z.ai" }));
    const keyStep = await screen.findByRole("dialog", { name: "Add Z.ai" });
    await userEvent.type(within(keyStep).getByLabelText("API key"), "zai-key-123");

    await userEvent.click(within(keyStep).getByRole("button", { name: "Done" }));

    // The button says what runs; the sheet draws no spinner.
    const checking = await within(keyStep).findByRole("button", { name: "Checking the key…" });
    expect(checking.getAttribute("aria-busy")).toBe("true");
    expect(keyStep.querySelector(".spin")).toBeNull();
    expect(
      within(keyStep).getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled,
    ).toBe(true);
    expect(within(keyStep).getByRole<HTMLButtonElement>("button", { name: "Close" }).disabled).toBe(
      true,
    );
    expect(within(keyStep).getByRole<HTMLButtonElement>("button", { name: "Back" }).disabled).toBe(
      true,
    );
    // Esc is cancelled, which stops the browser from closing the dialog, and a press on the scrim does nothing.
    expect(fireEvent.keyDown(keyStep, { key: "Escape" })).toBe(false);
    fireEvent.pointerDown(keyStep);
    fireEvent.click(keyStep);
    expect(keyStep.hasAttribute("open")).toBe(true);

    finishCreate();

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(await screen.findByRole("button", { name: /^Z\.ai/ })).toBeTruthy();
  });

  describe("an account that signs in on a machine", () => {
    const CREATED_ID = "01a06d02-8000-7000-8000-0000000000c2";
    const CREATED = buildCreated(
      CREATED_ID,
      "anthropic/anthropic",
      "subscription-per-machine",
      "home",
      "claude-code/claude-code",
    );
    const SIGNED_IN: ProviderAccount = {
      ...CREATED,
      identity: "home@example.com",
      planLabel: "Claude Pro",
      snapshots: PERSONAL.snapshots,
    };

    /** Opens the sheet on the machine step: Anthropic, the subscription kind, the label "home". */
    const reachSignIn = async (stored: ProviderAccount[], handlers: Record<string, Handler>) => {
      const opened = await openProviders({
        stored,
        handlers: {
          [`POST ${ACCOUNTS_PATH}`]: () => {
            stored.push(CREATED);
            return { body: CREATED };
          },
          ...handlers,
        },
      });
      const sheet = await openSheet();
      await userEvent.click(within(sheet).getByRole("button", { name: "Anthropic" }));
      const kind = await screen.findByRole("dialog", { name: "Add Anthropic" });
      await userEvent.click(within(kind).getByText("Claude subscription"));
      await userEvent.click(within(kind).getByRole("button", { name: "Continue" }));
      // Anthropic has an account already, so the new one needs a name.
      expect(
        within(kind).getByText("Give this one a name, so you can tell them apart."),
      ).toBeTruthy();
      await userEvent.type(within(kind).getByLabelText("Name"), "home");
      await userEvent.click(within(kind).getByRole("button", { name: "Continue" }));
      await within(kind).findByRole("radio", { name: /moss/ });
      return { ...opened, sheet: kind };
    };

    it("asks for the label before the sign-in, creates the account without credentials, and signs in on the picked machine", async () => {
      const stored: ProviderAccount[] = [PERSONAL];
      const { calls, sheet } = await reachSignIn(stored, {
        [`POST ${ACCOUNTS_PATH}/${CREATED_ID}/sign-in`]: {
          body: { url: "https://claude.ai/oauth/authorize?code=1" },
        },
        [`POST ${ACCOUNTS_PATH}/${CREATED_ID}/sign-in-code`]: () => {
          stored.splice(1, 1, SIGNED_IN);
          return { body: SIGNED_IN };
        },
      });

      expect(
        calls
          .filter((call) => call.method === "POST" && call.path === ACCOUNTS_PATH)
          .map((call) => call.body),
      ).toEqual([
        { providerId: "anthropic/anthropic", kind: "subscription-per-machine", label: "home" },
      ]);
      // The account exists, so there is nothing to go back to and leaving discards it.
      expect(within(sheet).queryByRole("button", { name: "Back" })).toBeNull();
      expect(within(sheet).getByRole("button", { name: "Discard" })).toBeTruthy();

      await userEvent.click(within(sheet).getByRole("button", { name: "Sign in" }));
      const login = await screen.findByRole("dialog", {
        name: "Sign in to Anthropic · home on moss",
      });
      await userEvent.type(await within(login).findByRole("textbox", { name: "Code" }), "abc-123");
      await userEvent.click(within(login).getByRole("button", { name: "Submit" }));

      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Sign in to Anthropic · home on moss" }),
        ).toBeNull();
      });
      expect(within(sheet).getByText("Signed in on moss")).toBeTruthy();
      // Signed in, the account stays: the sheet no longer offers to discard it.
      expect(within(sheet).queryByRole("button", { name: "Discard" })).toBeNull();
      await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(await screen.findByRole("button", { name: /^Anthropic · home/ })).toBeTruthy();
      expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
    });

    it("keeps the sheet locked when the user types in the label while the account is being created", async () => {
      const stored: ProviderAccount[] = [PERSONAL];
      let finishCreate: () => void = () => undefined;
      await openProviders({
        stored,
        handlers: {
          [`POST ${ACCOUNTS_PATH}`]: () =>
            new Promise((resolve) => {
              finishCreate = () => {
                stored.push(CREATED);
                resolve({ body: CREATED });
              };
            }),
        },
      });
      const sheet = await openSheet();
      await userEvent.click(within(sheet).getByRole("button", { name: "Anthropic" }));
      const kind = await screen.findByRole("dialog", { name: "Add Anthropic" });
      await userEvent.click(within(kind).getByText("Claude subscription"));
      await userEvent.click(within(kind).getByRole("button", { name: "Continue" }));
      const name = within(kind).getByLabelText<HTMLInputElement>("Name");
      await userEvent.type(name, "home");
      await userEvent.click(within(kind).getByRole("button", { name: "Continue" }));
      await within(kind).findByRole("button", { name: "Adding…" });

      await userEvent.type(name, "more");

      expect(name.readOnly).toBe(true);
      expect(name.value).toBe("home");
      expect(within(kind).getByRole("button", { name: "Adding…" })).toBeTruthy();
      expect(within(kind).getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(
        true,
      );

      finishCreate();
      await within(kind).findByRole("radio", { name: /moss/ });
    });

    it("deletes the account when the user discards it before the sign-in succeeded", async () => {
      const stored: ProviderAccount[] = [PERSONAL];
      const { calls, sheet } = await reachSignIn(stored, {
        [`DELETE ${ACCOUNTS_PATH}/${CREATED_ID}`]: () => {
          stored.splice(1, 1);
          return { body: {} };
        },
      });

      await userEvent.click(within(sheet).getByRole("button", { name: "Discard" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
        `${ACCOUNTS_PATH}/${CREATED_ID}`,
      ]);
      expect(screen.queryByRole("button", { name: /^Anthropic · home/ })).toBeNull();
    });

    it("reopens the sheet with the controller's message when the delete is refused", async () => {
      const stored: ProviderAccount[] = [PERSONAL];
      const message = "A session runs on this account.";
      const { sheet } = await reachSignIn(stored, {
        [`DELETE ${ACCOUNTS_PATH}/${CREATED_ID}`]: {
          status: 409,
          body: buildErrorBody("invalid_state", message),
        },
      });

      await userEvent.click(within(sheet).getByRole("button", { name: "Discard" }));

      const alert = await within(sheet).findByRole("alert");
      expect(alert.textContent).toBe(
        `Anthropic · home was added but not signed in, and could not be discarded: ${message}`,
      );
      expect(sheet.hasAttribute("open")).toBe(true);
      expect(within(sheet).getByRole("button", { name: "Discard" })).toBeTruthy();
    });
  });

  it("makes a token on a machine: the button says so, and the sign-in dialog asks for the pasted code", async () => {
    const created = buildCreated(
      "01a06d02-8000-7000-8000-0000000000c3",
      "anthropic/anthropic",
      "subscription-token",
      "team",
      "claude-code/claude-code",
    );
    const stored: ProviderAccount[] = [PERSONAL];
    const { calls } = await openProviders({
      stored,
      handlers: {
        [`POST ${ACCOUNTS_PATH}`]: () => {
          stored.push(created);
          return { body: created };
        },
        [`POST ${ACCOUNTS_PATH}/${created.id}/sign-in`]: {
          body: { url: "https://claude.ai/oauth/authorize?code=2" },
        },
      },
    });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Anthropic" }));
    const kind = await screen.findByRole("dialog", { name: "Add Anthropic" });
    await userEvent.click(within(kind).getByText(TOKEN_KIND.title));
    await userEvent.click(within(kind).getByRole("button", { name: "Continue" }));
    await userEvent.type(within(kind).getByLabelText("Name"), "team");
    await userEvent.click(within(kind).getByRole("button", { name: "Continue" }));

    await userEvent.click(await within(kind).findByRole("button", { name: "Make the token" }));

    const login = await screen.findByRole("dialog", {
      name: "Sign in to Anthropic · team on moss",
    });
    expect(await within(login).findByRole("textbox", { name: "Code" })).toBeTruthy();
    expect(
      calls
        .filter((call) => call.method === "POST" && call.path.endsWith("/sign-in"))
        .map((call) => call.body),
    ).toEqual([{ runnerId: MOSS.id }]);
  });

  it("offers the machines that have the provider's own harness, whatever order the kind lists its harnesses in", async () => {
    // The kind lists pi first, but a new Anthropic account starts in Claude
    // Code. With no account yet, the sign-in is offered before the account
    // exists, so the provider's own harness is all the sheet has to go by.
    const reordered: AccountKind = {
      ...TOKEN_KIND,
      harnesses: ["pi/pi", "claude-code/claude-code"],
    };
    await openProviders({
      stored: [],
      handlers: {
        "GET /api/v1/providers": {
          body: TEST_PROVIDERS.map((provider) =>
            provider.id === "anthropic/anthropic" ? { ...provider, kinds: [reordered] } : provider,
          ),
        },
      },
    });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Anthropic" }));
    const kind = await screen.findByRole("dialog", { name: "Add Anthropic" });

    // moss has Claude Code and no pi, so it can make the token.
    const button = await within(kind).findByRole<HTMLButtonElement>("button", {
      name: "Make the token",
    });
    expect(button.disabled).toBe(false);
  });

  it("installs the harness from the sheet's own button, then opens a sign-in that does not ask for the install again", async () => {
    const created = buildCreated(
      "01a06d02-8000-7000-8000-0000000000c5",
      "anthropic/anthropic",
      "subscription-per-machine",
      "home",
      "claude-code/claude-code",
    );
    const stored: ProviderAccount[] = [PERSONAL];
    let installed = false;
    const bare = (): Runner => ({
      ...MOSS,
      facts: {
        ...MOSS.facts!,
        harnesses: [
          installed
            ? { name: "claude", present: true, path: "/opt/homebrew/bin/claude" }
            : { name: "claude", present: false },
        ],
      },
    });
    const { calls } = await openProviders({
      stored,
      handlers: {
        "GET /api/v1/runners": () => ({ body: { items: [bare()] } }),
        [`GET /api/v1/runners/${MOSS.id}`]: () => ({
          body: { ...bare(), negotiatedCapabilities: null, protocolVersion: 1 },
        }),
        [`POST /api/v1/runners/${MOSS.id}/install-harness`]: () => {
          installed = true;
          return { body: { ...bare(), negotiatedCapabilities: null, protocolVersion: 1 } };
        },
        [`POST ${ACCOUNTS_PATH}`]: () => {
          stored.push(created);
          return { body: created };
        },
        [`POST ${ACCOUNTS_PATH}/${created.id}/sign-in`]: {
          body: { url: "https://claude.ai/oauth/authorize?code=3" },
        },
      },
    });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Anthropic" }));
    const kind = await screen.findByRole("dialog", { name: "Add Anthropic" });
    await userEvent.click(within(kind).getByText("Claude subscription"));
    await userEvent.click(within(kind).getByRole("button", { name: "Continue" }));
    await userEvent.type(within(kind).getByLabelText("Name"), "home");
    await userEvent.click(within(kind).getByRole("button", { name: "Continue" }));

    await userEvent.click(await within(kind).findByRole("button", { name: "Install" }));

    const login = await screen.findByRole("dialog", {
      name: "Sign in to Anthropic · home on moss",
    });
    expect(await within(login).findByRole("textbox", { name: "Code" })).toBeTruthy();
    expect(within(login).queryByRole("button", { name: /Install/ })).toBeNull();
    expect(
      calls
        .filter((call) => call.method === "POST" && call.path.endsWith("/install-harness"))
        .map((call) => call.body),
    ).toEqual([{ harnessId: "claude-code/claude-code" }]);
  });

  it("closes without a request when the user cancels before anything was created", async () => {
    const { calls } = await openProviders({ stored: [PERSONAL] });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Z.ai" }));
    const keyStep = await screen.findByRole("dialog", { name: "Add Z.ai" });
    await userEvent.type(within(keyStep).getByLabelText("API key"), "zai-key-123");

    await userEvent.click(within(keyStep).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(
      calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/ws-ticket")),
    ).toEqual([]);
  });
});
