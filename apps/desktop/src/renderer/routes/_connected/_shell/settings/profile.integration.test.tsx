/**
 * Tests Settings > Profile: the user's name, the two settings that save when
 * they change, a save that fails, a read of the settings that answers after
 * a save, and Sign out.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { queryKeys } from "@hercule/client-core";
import type { SettingsPatch } from "@hercule/contract";
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
  type Answer,
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

/** The settings `STORED` becomes once the time zone is saved as "Asia/Tokyo". */
const STORED_IN_TOKYO = { ...STORED, user: { ...STORED.user, timezone: "Asia/Tokyo" } };

/**
 * Returns handlers that play the controller's settings, starting at
 * `STORED`. A save merges its patch into them and answers with the result,
 * and a read answers with what the saves stored, as the controller's does.
 */
const storeSettings = (): {
  readonly "GET /api/v1/settings": () => Answer;
  readonly "PATCH /api/v1/settings": (call: Call) => Answer;
} => {
  let stored: Required<SettingsPatch> = STORED;
  return {
    "GET /api/v1/settings": () => ({ body: stored }),
    "PATCH /api/v1/settings": (call) => {
      const patch = call.body as SettingsPatch;
      stored = {
        controller: { ...stored.controller, ...patch.controller },
        user: { ...stored.user, ...patch.user },
      };
      return { body: stored };
    },
  };
};

/**
 * Opens Settings > Profile signed in as "rogier", with one GitHub Connection
 * and the settings of `storeSettings`, and `handlers` on top.
 */
const openProfile = async (handlers: Readonly<Record<string, Handler>> = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/connections": { body: { items: [FIXTURE_GITHUB_CONNECTION] } },
    ...storeSettings(),
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
    const settings = storeSettings();
    const save = holdAnswer();
    // The controller stores the save, and the test holds its answer.
    const { calls } = await openProfile({
      ...settings,
      "PATCH /api/v1/settings": (call) => {
        settings["PATCH /api/v1/settings"](call);
        return save.handler();
      },
    });
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Time zone" });

    await userEvent.selectOptions(select, "Asia/Tokyo");

    await waitFor(() => {
      expect(listPatches(calls)).toEqual([{ user: { timezone: "Asia/Tokyo" } }]);
    });
    expect(select.value).toBe("Asia/Tokyo");
    save.answer({ body: STORED_IN_TOKYO });
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
    const { calls, context } = await openProfile();
    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Default GitHub account",
    });

    await userEvent.selectOptions(select, "None");

    await waitFor(() => {
      expect(listPatches(calls)).toEqual([{ user: { "github.defaultConnectionId": null } }]);
      expect(context.queryClient.isMutating()).toBe(0);
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
    const settings = storeSettings();
    const staleRead = holdAnswer();
    let reads = 0;
    const { calls, context } = await openProfile({
      ...settings,
      // The second read is held; every other read answers with what the
      // controller stores.
      "GET /api/v1/settings": () => {
        reads += 1;
        return reads === 2 ? staleRead.handler() : settings["GET /api/v1/settings"]();
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
    // The save read the settings again, and that read replaced the held one.
    expect(reads).toBe(3);
    staleRead.answer({ body: STORED });

    // Once no read of the settings is running, the held read has either been
    // dropped or written the cache, so the select shows which one happened.
    await waitFor(() => {
      expect(context.queryClient.isFetching({ queryKey: queryKeys.settings() })).toBe(0);
    });
    expect(select.value).toBe("Asia/Tokyo");
  });

  it("keeps a saved value when a read of the settings that started while the save ran answers after it", async () => {
    const settings = storeSettings();
    const save = holdAnswer();
    const staleRead = holdAnswer();
    let reads = 0;
    const { context } = await openProfile({
      // The second read is held; every other read answers with what the
      // controller stores.
      "GET /api/v1/settings": () => {
        reads += 1;
        return reads === 2 ? staleRead.handler() : settings["GET /api/v1/settings"]();
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
      // The controller stores the save, and the test holds its answer.
      "PATCH /api/v1/settings": (call) => {
        settings["PATCH /api/v1/settings"](call);
        return save.handler();
      },
    });
    await userEvent.selectOptions(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Time zone" }),
      "Asia/Tokyo",
    );
    await waitFor(() => {
      expect(context.queryClient.isMutating()).toBe(1);
    });
    // Opening Profile again while the save runs reads the settings again in
    // the background. The test holds that read.
    await userEvent.click(screen.getByRole("link", { name: "System" }));
    await screen.findByRole("heading", { level: 1, name: "System" });
    await userEvent.click(screen.getByRole("link", { name: "Profile" }));
    await screen.findByRole("heading", { level: 1, name: "Profile" });
    await waitFor(() => {
      expect(reads).toBe(2);
    });

    save.answer({ body: STORED_IN_TOKYO });
    await waitFor(() => {
      expect(context.queryClient.isMutating()).toBe(0);
    });
    // The held read answers with the settings the controller read before it
    // stored the save.
    staleRead.answer({ body: STORED });

    await waitFor(() => {
      expect(context.queryClient.isFetching({ queryKey: queryKeys.settings() })).toBe(0);
    });
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Time zone" }).value).toBe(
      "Asia/Tokyo",
    );
    expect(context.queryClient.getQueryData(queryKeys.settings())).toMatchObject({
      user: { timezone: "Asia/Tokyo" },
    });
    // The save's own read replaced the held one, and left nothing to read again.
    expect(context.queryClient.getQueryState(queryKeys.settings())?.isInvalidated).toBe(false);
    expect(reads).toBe(3);
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
