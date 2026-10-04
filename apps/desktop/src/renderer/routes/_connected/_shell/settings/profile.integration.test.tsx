/**
 * Tests Settings > Profile: the user's name, the two settings that save when
 * they change, a save that fails, a read of the settings that answers after
 * a save, and Sign out.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { queryKeys } from "@hercule/client-core";
import userEvent from "@testing-library/user-event";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_GITHUB_CONNECTION,
  holdAnswer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../../../app/testing";

afterEach(forgetLastSettingsSection);

/** The settings the stubbed controller holds at the start of each test. */
const STORED = {
  controller: {},
  user: {
    timezone: "Europe/Amsterdam",
    "github.defaultConnectionId": FIXTURE_GITHUB_CONNECTION.id,
  },
};

/**
 * Opens Settings > Profile signed in as "rogier", with one GitHub Connection
 * and the `STORED` settings, and `handlers` on top.
 */
const openProfile = async (handlers: Readonly<Record<string, Handler>> = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/connections": { body: { items: [FIXTURE_GITHUB_CONNECTION] } },
    "GET /api/v1/settings": { body: STORED },
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path: "/settings/profile" });
  await screen.findByRole("heading", { level: 1, name: "Profile" });
  return { calls, fake, ...app };
};

/** Returns the settings patches among `calls`, oldest first. */
const listPatches = (calls: readonly Call[]): unknown[] =>
  calls
    .filter((call) => call.method === "PATCH" && call.path === "/api/v1/settings")
    .map((call) => call.body);

describe("Settings > Profile", () => {
  it("shows the user's name and the stored settings", async () => {
    await openProfile();

    expect(screen.getByRole("heading", { level: 2, name: "rogier" })).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Time zone" }).value).toBe(
      "Europe/Amsterdam",
    );
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Default GitHub account" }).value,
    ).toBe(FIXTURE_GITHUB_CONNECTION.id);
  });

  it("saves the time zone as soon as it is picked, and shows it while the save runs", async () => {
    const save = holdAnswer();
    const { calls } = await openProfile({ "PATCH /api/v1/settings": save.handler });
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Time zone" });

    await userEvent.selectOptions(select, "Asia/Tokyo");

    await waitFor(() => {
      expect(listPatches(calls)).toEqual([{ user: { timezone: "Asia/Tokyo" } }]);
    });
    expect(select.value).toBe("Asia/Tokyo");
    save.answer({ body: { ...STORED, user: { ...STORED.user, timezone: "Asia/Tokyo" } } });
    await waitFor(() => {
      expect(select.value).toBe("Asia/Tokyo");
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts the time zone back and shows why under its row when the save fails", async () => {
    await openProfile({
      "PATCH /api/v1/settings": {
        status: 500,
        body: buildErrorBody("internal", "The database is locked."),
      },
    });
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Time zone" });

    await userEvent.selectOptions(select, "Asia/Tokyo");

    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe("Could not save: The database is locked.");
    expect(select.value).toBe("Europe/Amsterdam");
    // The error sits right under the time zone's row.
    expect(error.previousElementSibling?.contains(select)).toBe(true);
  });

  it("saves None as no default GitHub account", async () => {
    const { calls } = await openProfile({
      "PATCH /api/v1/settings": {
        body: { ...STORED, user: { ...STORED.user, "github.defaultConnectionId": null } },
      },
    });
    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Default GitHub account",
    });

    await userEvent.selectOptions(select, "None");

    await waitFor(() => {
      expect(listPatches(calls)).toEqual([{ user: { "github.defaultConnectionId": null } }]);
    });
    expect(select.value).toBe("");
  });

  it("offers a stored default GitHub account that is not among the Connections, marked as not found", async () => {
    const goneId = "01a06d02-7700-7000-8000-0000deadbeef";
    await openProfile({
      "GET /api/v1/settings": {
        body: { ...STORED, user: { ...STORED.user, "github.defaultConnectionId": goneId } },
      },
    });
    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Default GitHub account",
    });

    expect(select.value).toBe(goneId);
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["None", "rogier", "deadbeef (not found)"]);
  });

  it("keeps a saved value when a read of the settings that started before the save answers after it", async () => {
    const staleRead = holdAnswer();
    let reads = 0;
    const { calls, context } = await openProfile({
      "GET /api/v1/settings": () => {
        reads += 1;
        return reads === 1 ? { body: STORED } : staleRead.handler();
      },
      "GET /api/v1/controller": {
        body: {
          id: "01a06d02-7800-7000-8000-000000000001",
          publicKey: "cHVibGljLWtleQ==",
          version: "0.4.2",
          defaultRunnerId: null,
          localRunnerId: null,
        },
      },
      "PATCH /api/v1/settings": {
        body: { ...STORED, user: { ...STORED.user, timezone: "Asia/Tokyo" } },
      },
    });
    // Opening Profile again shows the settings read last at once, and reads
    // them again in the background. The test holds that read.
    await userEvent.click(screen.getByRole("link", { name: "System" }));
    await screen.findByRole("heading", { level: 1, name: "System" });
    await userEvent.click(screen.getByRole("link", { name: "Profile" }));
    await screen.findByRole("heading", { level: 1, name: "Profile" });
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Time zone" });

    await userEvent.selectOptions(select, "Asia/Tokyo");
    await waitFor(() => {
      expect(listPatches(calls)).toHaveLength(1);
      expect(context.queryClient.isMutating()).toBe(0);
    });
    staleRead.answer({ body: STORED });

    // Once no read of the settings is running, the held read has either been
    // dropped or written the cache, so the select shows which one happened.
    await waitFor(() => {
      expect(context.queryClient.isFetching({ queryKey: queryKeys.settings() })).toBe(0);
    });
    expect(select.value).toBe("Asia/Tokyo");
  });

  it("signs out: forgets the token, revokes it and shows the sign-in screen", async () => {
    const { calls, context, fake, router } = await openProfile();

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("textbox", { name: "Username" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    expect(context.controller?.client.getToken()).toBeNull();
    expect(fake.tokenWrites).toEqual([null]);
    await waitFor(() => {
      expect(
        calls.filter((call) => call.method === "POST" && call.path === "/api/v1/auth/logout"),
      ).toHaveLength(1);
    });
  });
});
