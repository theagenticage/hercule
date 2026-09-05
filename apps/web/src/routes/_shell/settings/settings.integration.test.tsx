import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { envelope, renderApp, stubApi, type Call, type Handler } from "../../../app/testing";

const stored = {
  controller: {},
  user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
};

/** A controller that answers `settings.update` with the store the patch makes. */
const controller = (update?: Handler): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": { body: stored },
  "PATCH /api/v1/settings": update ?? applyPatch,
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
    const api = stubApi(controller());
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
    const api = stubApi(controller());
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

  it("signs out even when the controller refuses the revocation", async () => {
    const user = userEvent.setup();
    const api = stubApi({
      ...controller(),
      "POST /api/v1/auth/logout": { status: 500, body: envelope("internal", "no") },
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

    // A revocation the controller refused leaves the bearer working, so a
    // connection left open would carry whoever signs in next on this one.
    await waitFor(() => {
      expect(live.connected()).toBe(false);
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    expect(client.getToken()).toBeNull();
    expect(api.calls.some((call) => call.path === "/api/v1/auth/logout")).toBe(true);

    // Nothing is read back without a bearer on the way out. A refetch would
    // be queued rather than sent, so the queue is let run first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = api.calls.slice(
      api.calls.findIndex((call) => call.path === "/api/v1/auth/logout"),
    );
    expect(after.filter((call) => call.path === "/api/v1/settings")).toEqual([]);
  });

  it("shows a refused write as the API worded it", async () => {
    const user = userEvent.setup();
    const api = stubApi(
      controller({ status: 500, body: envelope("internal", "the settings table is locked") }),
    );
    await renderApp({ path: "/settings/profile", api: api.fetch, token: "held" });

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe("the settings table is locked");
  });
});

describe("Settings > Threads", () => {
  it("opens on the default density and writes the one the user picks", async () => {
    const user = userEvent.setup();
    const api = stubApi(controller());
    await renderApp({ path: "/settings/threads", api: api.fetch, token: "held" });

    const rows = screen.getByRole("radiogroup", { name: "Sidebar rows" });
    const chosen = () =>
      within(rows)
        .getAllByRole("radio")
        .find((item) => item.getAttribute("aria-checked") === "true")?.textContent;
    expect(chosen()).toBe("meta");

    await user.click(within(rows).getByRole("radio", { name: "plain" }));

    expect(await screen.findByRole("status")).toBeDefined();
    expect(api.calls.filter((call) => call.method === "PATCH")[0]?.body).toEqual({
      user: { "ui.threadRows": "plain" },
    });
    // The answer replaces the cached store, so the screen and the sidebar both
    // read the choice back without a refetch.
    expect(chosen()).toBe("plain");
  });
});
