import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection } from "@hercule/contract";
import { buildErrorBody, renderApp, stubApi, type Call, type Handler } from "../../../app/testing";

const stored = {
  controller: {},
  user: { "onboarding.completedSteps": ["timezone", "assistant"], timezone: "Europe/Amsterdam" },
};

/** Builds a stub controller that responds to `settings.update` with the settings after the patch. */
const buildController = (update?: Handler): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": { body: stored },
  "PATCH /api/v1/settings": update ?? applyPatch,
  // The four defaults on Settings > Threads read these. They are empty on
  // purpose: these tests are about the sidebar-rows control, not the defaults.
  "GET /api/v1/providers": { body: [] },
  "GET /api/v1/runners": { body: { items: [] } },
  "GET /api/v1/profiles": { body: { items: [] } },
  // Settings > Profile reads this for its GitHub card. It is empty for the
  // same reason: the Profile tests that use it are about the timezone and
  // signing out.
  "GET /api/v1/connections": { body: { items: [] } },
});

const applyPatch = (call: Call) => ({
  body: {
    controller: {},
    user: { ...stored.user, ...(call.body as { user: Record<string, unknown> }).user },
  },
});

describe("Settings > Profile", () => {
  it("saves the timezone and shows that it did", async () => {
    const user = userEvent.setup();
    const api = stubApi(buildController());
    await renderApp({ path: "/settings/profile", api: api.fetch, token: "held" });

    const field = screen.getByLabelText<HTMLSelectElement>("Timezone");
    expect(field.value).toBe("Europe/Amsterdam");

    await user.selectOptions(field, "Pacific/Auckland");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("status")).toBeDefined();
    const written = api.calls.filter((call) => call.method === "PATCH");
    expect(written).toHaveLength(1);
    expect(written[0]?.body).toEqual({ user: { timezone: "Pacific/Auckland" } });
  });

  it("offers only zones this browser can format, and no free text", async () => {
    const api = stubApi(buildController());
    await renderApp({ path: "/settings/profile", api: api.fetch, token: "held" });

    const field = screen.getByLabelText<HTMLSelectElement>("Timezone");
    expect(field.tagName).toBe("SELECT");
    const offered = [...field.options].map((option) => option.value);
    expect(offered).toContain("Europe/Amsterdam");
    expect(offered).not.toContain("Amsterdam");
    for (const zone of offered) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone })).not.toThrow();
    }
  });

  it("signs out even when revoking the token fails", async () => {
    const user = userEvent.setup();
    const api = stubApi({
      ...buildController(),
      "POST /api/v1/auth/logout": { status: 500, body: buildErrorBody("internal", "no") },
    });
    const { router, client, live } = await renderApp({
      path: "/settings/profile",
      api: api.fetch,
      token: "held",
    });
    await waitFor(() => {
      expect(live.connected()).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    // A failed revocation leaves the old token valid, so a live connection
    // left open would keep that session's access for whoever signs in next.
    await waitFor(() => {
      expect(live.connected()).toBe(false);
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    expect(client.getToken()).toBeNull();
    expect(api.calls.some((call) => call.path === "/api/v1/auth/logout")).toBe(true);

    // Nothing is fetched without a token after sign-out. A refetch would be
    // queued rather than sent at once, so the queue runs first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = api.calls.slice(
      api.calls.findIndex((call) => call.path === "/api/v1/auth/logout"),
    );
    expect(after.filter((call) => call.path === "/api/v1/settings")).toEqual([]);
  });

  it("shows a failed write's error message as the API sent it", async () => {
    const user = userEvent.setup();
    const api = stubApi(
      buildController({
        status: 500,
        body: buildErrorBody("internal", "the settings table is locked"),
      }),
    );
    await renderApp({ path: "/settings/profile", api: api.fetch, token: "held" });

    await user.selectOptions(screen.getByLabelText("Timezone"), "Pacific/Auckland");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe("the settings table is locked");
  });

  it("turns Save off while the timezone is the stored one, and again after it saves", async () => {
    const user = userEvent.setup();
    const api = stubApi(buildController());
    await renderApp({ path: "/settings/profile", api: api.fetch, token: "held" });

    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save" });
    expect(save.disabled).toBe(true);

    const field = screen.getByLabelText("Timezone");
    await user.selectOptions(field, "Pacific/Auckland");
    expect(save.disabled).toBe(false);
    await user.selectOptions(field, "Europe/Amsterdam");
    expect(save.disabled).toBe(true);

    await user.selectOptions(field, "Pacific/Auckland");
    await user.click(save);
    expect(await screen.findByRole("status")).toBeDefined();
    expect(save.disabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The GitHub account a thread or an assistant's session acts through
 * when it has no checkout. It moved here from Settings > Threads,
 * because it applies to more than threads. Like the other selects on
 * the settings screens, it saves as soon as an account is picked.
 * ------------------------------------------------------------------ */

const CONNECTION_AT = "2026-09-10T09:00:00.000Z";

const GITHUB: Connection = {
  id: "01a06d02-7500-7000-8000-000000000001",
  type: "github/github",
  label: "personal",
  displayName: "rogierpennink",
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: CONNECTION_AT,
  updatedAt: CONNECTION_AT,
};

const GITHUB_WORK: Connection = {
  ...GITHUB,
  id: "01a06d02-7500-7000-8000-000000000002",
  label: "work",
  displayName: "acme-bot",
};

/** A connection of another type, which the select must not offer. */
const SLACK: Connection = {
  ...GITHUB,
  id: "01a06d02-7500-7000-8000-000000000003",
  type: "slack",
  label: "acme",
  displayName: "acme.slack.com",
};

/**
 * Opens Settings > Profile for a user whose stored settings include `user`.
 * `connections` replaces the answer to the connections read.
 */
const openProfileWithConnections = async (
  user: Record<string, unknown> = {},
  connections: Handler = { body: { items: [GITHUB, SLACK, GITHUB_WORK] } },
) => {
  let held = { controller: {}, user: { ...stored.user, ...user } };
  const api = stubApi({
    ...buildController(),
    "GET /api/v1/settings": () => ({ body: held }),
    "PATCH /api/v1/settings": (call) => {
      held = {
        controller: {},
        user: { ...held.user, ...(call.body as { user: Record<string, unknown> }).user },
      };
      return { body: held };
    },
    "GET /api/v1/connections": connections,
  });
  await renderApp({ path: "/settings/profile", api: api.fetch, token: "held" });
  return { api };
};

describe("Settings > Profile: the default GitHub account", () => {
  it("offers None and the GitHub connections only, and shows the stored one", async () => {
    await openProfileWithConnections({ "github.defaultConnectionId": GITHUB_WORK.id });

    const field = await screen.findByLabelText<HTMLSelectElement>("Default GitHub account");
    expect(field.tagName).toBe("SELECT");
    expect([...field.options].map((option) => option.textContent)).toEqual([
      "None",
      GITHUB.label,
      GITHUB_WORK.label,
    ]);
    expect(field.value).toBe(GITHUB_WORK.id);
  });

  // Added in review round 1 of #92 slice 4. A select whose value is none of
  // its options shows its first option, which would claim "None".
  it("shows a stored account that is no longer a Connection as not found", async () => {
    await openProfileWithConnections({
      "github.defaultConnectionId": "01a06d02-5000-7000-8000-0000000000ff",
    });

    const field = await screen.findByLabelText<HTMLSelectElement>("Default GitHub account");
    expect(field.value).toBe("01a06d02-5000-7000-8000-0000000000ff");
    expect(field.selectedOptions[0]?.textContent).toBe("000000ff (not found)");
  });

  it("shows a stored account as list not loaded, and says why, when the connections cannot be read", async () => {
    await openProfileWithConnections(
      { "github.defaultConnectionId": GITHUB_WORK.id },
      { status: 500, body: buildErrorBody("internal", "the database is locked") },
    );

    const field = await screen.findByLabelText<HTMLSelectElement>("Default GitHub account");
    expect(field.value).toBe(GITHUB_WORK.id);
    expect(field.selectedOptions[0]?.textContent).toBe("00000002 (list not loaded)");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load the GitHub accounts: the database is locked",
    );
  });

  it("shows None when no account is stored", async () => {
    await openProfileWithConnections();

    const field = await screen.findByLabelText<HTMLSelectElement>("Default GitHub account");
    expect(field.selectedOptions[0]?.textContent).toBe("None");
  });

  it("writes github.defaultConnectionId when an account is picked", async () => {
    const user = userEvent.setup();
    const { api } = await openProfileWithConnections();

    await user.selectOptions(
      await screen.findByLabelText<HTMLSelectElement>("Default GitHub account"),
      GITHUB_WORK.id,
    );

    await waitFor(() => {
      expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    });
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      user: { "github.defaultConnectionId": GITHUB_WORK.id },
    });
  });

  it("clears the setting rather than storing an empty id when None is picked", async () => {
    const user = userEvent.setup();
    const { api } = await openProfileWithConnections({ "github.defaultConnectionId": GITHUB.id });

    await user.selectOptions(
      await screen.findByLabelText<HTMLSelectElement>("Default GitHub account"),
      "None",
    );

    await waitFor(() => {
      expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    });
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      user: { "github.defaultConnectionId": null },
    });
  });
});

describe("Settings > Threads", () => {
  it("starts on the default row style and writes the one the user picks", async () => {
    const user = userEvent.setup();
    const api = stubApi(buildController());
    await renderApp({ path: "/settings/threads", api: api.fetch, token: "held" });

    const rows = screen.getByRole("radiogroup", { name: "Sidebar rows" });
    const readChosenRowsOption = () =>
      within(rows)
        .getAllByRole("radio")
        .find((item) => item.getAttribute("aria-checked") === "true")?.textContent;
    expect(readChosenRowsOption()).toBe("meta");

    await user.click(within(rows).getByRole("radio", { name: "plain" }));

    expect(await screen.findByRole("status")).toBeDefined();
    expect(api.calls.filter((call) => call.method === "PATCH")[0]?.body).toEqual({
      user: { "ui.threadRows": "plain" },
    });
    // The response replaces the cached settings, so the screen and the
    // sidebar both show the choice without a refetch.
    expect(readChosenRowsOption()).toBe("plain");
  });
});
