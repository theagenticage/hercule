/**
 * Tests Settings > Providers: one card per Provider Account with its mark,
 * name, identity line and machine pips, the reads the section makes as it
 * opens, the account sheet, renaming an account, choosing its default
 * harness, a delete the controller refuses, a delete it accepts, and a
 * sign-in started from a machine's row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HARNESSES, PROVIDERS } from "@hercule/client-core/testing";
import type { ProviderAccount, Runner } from "@hercule/contract";
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

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

// The sidebar's thread list draws only the rows that fit its height.
beforeEach(() => {
  stubElementSize(272, 800);
});

// The section opened last is kept in memory for as long as the app runs,
// which in a test file is every test.
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
/** atlas, online, with the adapters but no harness installed. */
const ATLAS: Runner = {
  ...MOSS,
  id: "01a06d02-beff-7037-9f5b-0000000000a1",
  name: "atlas",
  facts: { ...MOSS.facts!, harnesses: [{ name: "claude", present: false }] },
};
/** A machine the user retired. */
const OLD_BOX: Runner = {
  ...MOSS,
  id: "01a06d02-beff-7037-9f5b-0000000000b2",
  name: "old-box",
  lifecycle: "retired",
};

/** Anthropic · personal: signed in on moss as rogier@example.com, Claude Max. */
const PERSONAL: ProviderAccount = { ...FIXTURE_ACCOUNT, label: "personal" };
/** A second Anthropic account, signed in nowhere. */
const WORK: ProviderAccount = {
  ...PERSONAL,
  id: "01a06d02-8000-7000-8000-000000000002",
  label: "work",
  identity: null,
  planLabel: null,
  snapshots: [],
};
/** Z.ai, an API key every machine uses. */
const ZAI: ProviderAccount = {
  id: "01a06d02-8000-7000-8000-000000000003",
  providerId: "zai/zai",
  kind: "api-key",
  label: null,
  identity: null,
  planLabel: null,
  defaultHarnessId: "pi/pi",
  expiresAt: null,
  snapshots: [],
  createdAt: PERSONAL.createdAt,
  updatedAt: PERSONAL.updatedAt,
};

const accountPath = (account: ProviderAccount): string => `/api/v1/provider-accounts/${account.id}`;

/**
 * Opens Settings > Providers with `accounts` on the machines `runners`, and
 * `handlers` on top. A handler for `GET /api/v1/provider-accounts` answers
 * every read of the accounts, so a test can change what the controller holds.
 */
const openProviders = async ({
  accounts = [PERSONAL, WORK, ZAI],
  runners = [MOSS, ATLAS, OLD_BOX],
  handlers = {},
}: {
  readonly accounts?: ReadonlyArray<ProviderAccount>;
  readonly runners?: ReadonlyArray<Runner>;
  readonly handlers?: Readonly<Record<string, Handler>>;
} = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [...runners], accounts: [...accounts] }),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path: "/settings/providers" });
  await screen.findByRole("heading", { level: 1, name: "Providers" });
  return { calls, ...app };
};

/** Returns the card of the account named `name`, such as "Anthropic · work". */
const getCard = (name: string): HTMLElement =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

/** Opens the sheet of the account named `name` and returns it. */
const openSheet = async (name: string): Promise<HTMLElement> => {
  await userEvent.click(getCard(name));
  return screen.findByRole("dialog", { name });
};

describe("Settings > Providers", () => {
  it("draws one card per account, in order, with its name, identity line and machines", async () => {
    await openProviders();

    const cards = [...document.querySelectorAll<HTMLElement>(".pa-card")];
    expect(cards.map((card) => card.querySelector("b")!.textContent)).toEqual([
      "Anthropic · personal",
      "Anthropic · work",
      "Z.ai",
    ]);
    // The identity, then the plan; an account that knows no identity shows its kind.
    expect(cards.map((card) => card.querySelector(".pa-identity")!.textContent)).toEqual([
      "rogier@example.com · Claude Max",
      "Claude subscription",
      "API key",
    ]);
    // One pip per machine that is not retired: filled where it is signed in.
    const pips = (card: HTMLElement) => card.querySelector('[role="img"]');
    expect(pips(cards[0]!)?.getAttribute("aria-label")).toBe("moss: ready · atlas: not signed in");
    expect(pips(cards[1]!)?.getAttribute("aria-label")).toBe(
      "moss: not signed in · atlas: not signed in",
    );
    expect(cards[0]!.querySelectorAll(".pa-pip:not(.is-you)")).toHaveLength(1);
    expect(cards[0]!.querySelectorAll(".pa-pip.is-you")).toHaveLength(1);
    // A key account has no pips: every machine uses it.
    expect(pips(cards[2]!)).toBeNull();
    expect(cards[2]!.textContent).toContain("Every machine");
    expect(screen.getByText("Who pays for the models in your menu.")).toBeTruthy();
  });

  it("sends no request of its own as it opens, and none after", async () => {
    const { calls } = await openProviders();
    const reads = (path: string) =>
      calls.filter((call) => call.method === "GET" && call.path === path).length;

    // The shell holds each of these reads for the life of the window, and the
    // `provider` live topic keeps the accounts current, so the section reads
    // each once, as the shell starts, and never polls.
    for (const path of [
      "/api/v1/provider-accounts",
      "/api/v1/providers",
      "/api/v1/harnesses",
      "/api/v1/runners",
      "/api/v1/plugins",
    ]) {
      expect(reads(path), path).toBe(1);
    }
    await userEvent.click(getCard("Anthropic · work"));
    await screen.findByRole("dialog", { name: "Anthropic · work" });
    expect(
      calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/auth/ws-ticket")),
    ).toEqual([]);
  });

  it("says there is no account yet, in one line", async () => {
    await openProviders({ accounts: [] });

    expect(screen.getByText("No accounts yet. Add one to give your agents models.")).toBeTruthy();
    expect(document.querySelector(".pa-card")).toBeNull();
  });

  it("opens the sheet of the account: its name, its machines and as whom, and what each offers", async () => {
    await openProviders();

    const sheet = await openSheet("Anthropic · personal");

    const view = within(sheet);
    expect(view.getByRole("heading", { level: 2 }).textContent).toBe("Anthropic · personal");
    expect(sheet.textContent).toContain("rogier@example.com · Claude Max");
    const machines = [...sheet.querySelectorAll(".pa-machine")].map((row) => row.textContent);
    // The retired machine is not listed. moss is signed in; atlas has no harness.
    expect(machines).toEqual(["mossrogier@example.com", "atlasNot signed inInstall"]);
    expect(view.getByRole("button", { name: "Install" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(view.getByRole("heading", { name: "Delete Anthropic · personal" })).toBeTruthy();
    await userEvent.click(view.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("lists no machines in the sheet of a key account", async () => {
    await openProviders();

    const sheet = await openSheet("Z.ai");

    expect(within(sheet).queryByRole("heading", { name: "Machines" })).toBeNull();
    expect(sheet.textContent).toContain("API key");
  });

  it("renames the account when the user leaves the field, and the card follows", async () => {
    let stored: ProviderAccount[] = [PERSONAL, ZAI];
    const { calls } = await openProviders({
      handlers: {
        "GET /api/v1/provider-accounts": () => ({ body: stored }),
        [`PATCH ${accountPath(PERSONAL)}`]: (call) => {
          const { label } = call.body as { label: string | null };
          stored = stored.map((each) => (each.id === PERSONAL.id ? { ...each, label } : each));
          return { body: stored[0] };
        },
      },
    });
    const sheet = await openSheet("Anthropic · personal");

    const field = within(sheet).getByRole("textbox", { name: "Name" });
    await userEvent.clear(field);
    await userEvent.type(field, "  home  ");
    await userEvent.tab();

    await waitFor(() => {
      expect(within(sheet).getByRole("heading", { level: 2 }).textContent).toBe("Anthropic · home");
    });
    expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
      { label: "home" },
    ]);
    expect(getCard("Anthropic · home")).toBeTruthy();
  });

  it("removes the label when the field is emptied", async () => {
    const { calls } = await openProviders({
      handlers: {
        [`PATCH ${accountPath(PERSONAL)}`]: { body: { ...PERSONAL, label: null } },
      },
    });
    const sheet = await openSheet("Anthropic · personal");

    await userEvent.clear(within(sheet).getByRole("textbox", { name: "Name" }));
    await userEvent.tab();

    await waitFor(() => {
      expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
        { label: null },
      ]);
    });
  });

  it("shows the controller's message when it refuses the name, and puts the old name back", async () => {
    await openProviders({
      handlers: {
        [`PATCH ${accountPath(PERSONAL)}`]: {
          status: 409,
          body: buildErrorBody(
            "conflict",
            "You have another Anthropic account, so this one needs a name.",
          ),
        },
      },
    });
    const sheet = await openSheet("Anthropic · personal");

    const field = within(sheet).getByRole("textbox", { name: "Name" });
    await userEvent.clear(field);
    await userEvent.tab();

    expect((await within(sheet).findByRole("alert")).textContent).toBe(
      "Could not save: You have another Anthropic account, so this one needs a name.",
    );
    await waitFor(() => {
      expect((field as HTMLInputElement).value).toBe("personal");
    });
  });

  it("deletes the account once the user confirms, and closes the sheet", async () => {
    let stored: ProviderAccount[] = [PERSONAL, WORK];
    const { calls } = await openProviders({
      handlers: {
        "GET /api/v1/provider-accounts": () => ({ body: stored }),
        [`DELETE ${accountPath(WORK)}`]: () => {
          stored = stored.filter((each) => each.id !== WORK.id);
          return { body: {} };
        },
      },
    });
    const sheet = await openSheet("Anthropic · work");

    await userEvent.click(within(sheet).getByRole("button", { name: "Delete…" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete Anthropic · work?" });
    expect(confirmation.textContent).toContain(
      "Threads that ran on it keep their history, but cannot continue.",
    );
    expect(
      within(confirmation)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Keep it", "Delete"]);
    await userEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      accountPath(WORK),
    ]);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^Anthropic · work/ })).toBeNull();
    });
    expect(getCard("Anthropic · personal")).toBeTruthy();
    // The user's own delete is not reported as a removal elsewhere.
    expect(document.querySelector(".set-note")).toBeNull();
  });

  it("shows the controller's refusal to delete, and offers only Cancel", async () => {
    const message = "An assistant, Ada, runs on this account. Change it first.";
    const { calls } = await openProviders({
      handlers: {
        [`DELETE ${accountPath(WORK)}`]: {
          status: 409,
          body: buildErrorBody("invalid_state", message),
        },
      },
    });
    const sheet = await openSheet("Anthropic · work");
    await userEvent.click(within(sheet).getByRole("button", { name: "Delete…" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete Anthropic · work?" });

    await userEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));

    expect((await within(confirmation).findByRole("alert")).textContent).toBe(message);
    expect(
      within(confirmation)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel"]);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Delete Anthropic · work?" })).toBeNull();
    });
    // The sheet and the account stay.
    expect(screen.getByRole("dialog", { name: "Anthropic · work" })).toBeTruthy();
  });

  it("starts a sign-in on a machine from its row, in the sign-in dialog", async () => {
    const { calls } = await openProviders({
      handlers: {
        [`POST ${accountPath(WORK)}/sign-in`]: {
          body: { url: "https://claude.ai/oauth/authorize?code=1" },
        },
      },
    });
    const sheet = await openSheet("Anthropic · work");

    // moss has Claude Code, atlas does not: only moss offers Sign in.
    expect(within(sheet).getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
    await userEvent.click(within(sheet).getByRole("button", { name: "Sign in" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Anthropic · work on moss",
    });
    expect(await within(dialog).findByRole("textbox", { name: "Code" })).toBeTruthy();
    expect(
      calls
        .filter((call) => call.method === "POST" && call.path.endsWith("/sign-in"))
        .map((call) => call.body),
    ).toEqual([{ runnerId: MOSS.id }]);
  });

  it("installs the harness on a machine that lacks it", async () => {
    const { calls } = await openProviders({
      handlers: {
        [`POST /api/v1/runners/${ATLAS.id}/install-harness`]: { body: {} },
      },
    });
    const sheet = await openSheet("Anthropic · personal");

    await userEvent.click(within(sheet).getByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(
        calls
          .filter((call) => call.path.endsWith("/install-harness"))
          .map((call) => [call.path, call.body]),
      ).toEqual([
        [`/api/v1/runners/${ATLAS.id}/install-harness`, { harnessId: PERSONAL.defaultHarnessId }],
      ]);
    });
  });

  it("strikes through the harnesses the account cannot run in, with the reason under each", async () => {
    await openProviders();

    const sheet = await openSheet("Z.ai");

    const group = within(sheet).getByRole("radiogroup", { name: "Default harness" });
    const radio = (name: string) => within(group).getByRole<HTMLInputElement>("radio", { name });
    // Z.ai allows its key only in pi; and pi is installed on no machine.
    expect(radio("Claude Code").disabled).toBe(true);
    expect(radio("Claude Code").getAttribute("aria-describedby")).not.toBeNull();
    expect(group.textContent).toContain("Z.ai allows an API key only in pi");
    expect(radio("pi").disabled).toBe(true);
    expect(radio("pi").checked).toBe(true);
    expect(group.textContent).toContain("pi is on no machine");
    expect(
      within(sheet).getByText(
        "Every profile runs this account\u2019s models here, unless the account\u2019s line in a profile picks another.",
      ),
    ).toBeTruthy();
  });

  describe("choosing the default harness", () => {
    /** moss also has pi, and Anthropic lets its subscription run in pi. */
    const withPi = (): Readonly<Record<string, Handler>> => ({
      "GET /api/v1/providers": {
        body: PROVIDERS.map((provider) =>
          provider.id === "anthropic/anthropic"
            ? {
                ...provider,
                kinds: provider.kinds.map((kind) => ({
                  ...kind,
                  harnesses: ["claude-code/claude-code", "pi/pi"],
                })),
              }
            : provider,
        ),
      },
      "GET /api/v1/harnesses": {
        body: HARNESSES.map((harness) =>
          harness.id === "pi/pi"
            ? {
                ...harness,
                runs: [
                  ...harness.runs,
                  {
                    providerId: "anthropic/anthropic",
                    kinds: [{ kind: "subscription-per-machine" }],
                    modelArgument: "anthropic/{model}",
                    models: "own-list",
                  },
                ],
              }
            : harness,
        ),
      },
    });
    const MOSS_WITH_PI: Runner = {
      ...MOSS,
      facts: {
        ...MOSS.facts!,
        harnesses: [...MOSS.facts!.harnesses, { name: "pi", present: true, path: "/bin/pi" }],
      },
    };

    it("saves the harness the user picks, and the radio follows", async () => {
      let stored: ProviderAccount[] = [PERSONAL];
      const { calls } = await openProviders({
        accounts: stored,
        runners: [MOSS_WITH_PI],
        handlers: {
          ...withPi(),
          "GET /api/v1/provider-accounts": () => ({ body: stored }),
          [`PATCH ${accountPath(PERSONAL)}`]: (call) => {
            const { defaultHarnessId } = call.body as { defaultHarnessId: string };
            stored = [{ ...PERSONAL, defaultHarnessId }];
            return { body: stored[0] };
          },
        },
      });
      const sheet = await openSheet("Anthropic · personal");

      const pi = within(sheet).getByRole<HTMLInputElement>("radio", { name: "pi" });
      expect(pi.disabled).toBe(false);
      expect(
        within(sheet).getByRole<HTMLInputElement>("radio", { name: "Claude Code" }).checked,
      ).toBe(true);
      await userEvent.click(pi);

      await waitFor(() => {
        expect(pi.checked).toBe(true);
      });
      expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
        { defaultHarnessId: "pi/pi" },
      ]);
    });

    it("shows the controller's message when it refuses the harness, and keeps the old one", async () => {
      await openProviders({
        runners: [MOSS_WITH_PI],
        handlers: {
          ...withPi(),
          [`PATCH ${accountPath(PERSONAL)}`]: {
            status: 400,
            body: buildErrorBody("validation", "pi cannot run this account: no machine has it."),
          },
        },
      });
      const sheet = await openSheet("Anthropic · personal");

      await userEvent.click(within(sheet).getByRole("radio", { name: "pi" }));

      expect((await within(sheet).findByRole("alert")).textContent).toContain(
        "pi cannot run this account: no machine has it.",
      );
      await waitFor(() => {
        expect(
          within(sheet).getByRole<HTMLInputElement>("radio", { name: "Claude Code" }).checked,
        ).toBe(true);
      });
    });
  });
});
