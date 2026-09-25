import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe("the settings table is locked");
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
