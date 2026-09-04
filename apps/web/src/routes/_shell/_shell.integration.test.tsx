import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp, stubApi, type Handler } from "../../app/testing";

const api: Readonly<Record<string, Handler>> = {
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
    },
  },
  // Tasks is the one screen here that reads something of its own.
  "GET /api/v1/tasks": { body: { items: [] } },
  "GET /api/v1/projects": { body: { items: [] } },
};

/** Every screen inside the shell, and the first thing it says. */
const screens: readonly [path: string, title: string, headline: string][] = [
  ["/", "Sessions", "No runner has been detected on this machine."],
  ["/intake", "Intake", "Nothing has come in yet."],
  ["/check-in", "Check-in", "Nothing in motion yet."],
  ["/tasks", "Tasks", "No tasks yet."],
  ["/runs", "Runs", "No runs yet."],
  ["/workflows", "Workflows", "No workflows yet."],
  ["/fleet", "Fleet", "Add machine"],
  ["/connections", "Connections", "Nothing connected yet."],
  ["/notifications", "Notifications", "Decisions and outcomes will land here."],
  ["/settings/profile", "Profile", "Timezone"],
  ["/settings/threads", "Threads", "Sidebar rows"],
  ["/settings/assistants", "Assistants", "No assistant has been created yet."],
  ["/settings/identities", "Identities", "No platform identity is paired."],
  [
    "/settings/permission-profiles",
    "Permission profiles",
    "Permission profiles are not editable yet.",
  ],
  ["/settings/secrets", "Secrets", "No secrets are stored."],
  ["/settings/bounds", "Bounds", "No trigger has a bound to show yet."],
  ["/settings/plugins", "Plugins", "No plugins are installed."],
  ["/settings/system", "System", "The controller's settings are not editable yet."],
];

describe("every screen inside the shell", () => {
  it.each(screens)("%s is titled %s and opens on its own words", async (path, title, headline) => {
    const { router } = await renderApp({ path, api: stubApi(api).fetch, token: "held" });

    expect(router.state.location.pathname).toBe(path);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
    expect(screen.getAllByText(headline).length).toBeGreaterThan(0);
  });

  it("lands the section path on the first screen of its sub-navigation", async () => {
    const { router } = await renderApp({
      path: "/settings",
      api: stubApi(api).fetch,
      token: "held",
    });

    expect(router.state.location.pathname).toBe("/settings/profile");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Profile");
  });

  it("shows an entry that failed as a Hydra screen with a way out", async () => {
    const broken: Readonly<Record<string, Handler>> = {
      ...api,
      "GET /api/v1/settings": { status: 500, body: { error: { code: "internal", message: "no" } } },
    };
    await renderApp({ path: "/tasks", api: stubApi(broken).fetch, token: "held" });

    expect(screen.getByText("This screen did not load")).toBeDefined();
    expect(screen.getByRole("link", { name: "Go to Sessions" })).toBeDefined();
    // Nothing was mounted to keep: the guard failed before the shell.
    expect(screen.queryByRole("navigation", { name: "Hydra" })).toBeNull();
  });

  it("answers a path no screen owns without taking the navigation away", async () => {
    await renderApp({ path: "/nope", api: stubApi(api).fetch, token: "held" });

    expect(screen.getByText("No screen here")).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Hydra" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Go to Sessions" })).toBeDefined();
  });

  it("answers a path it cannot even decode as a Hydra screen", async () => {
    // A malformed percent escape fails to decode before any route is matched,
    // so this one never reaches the shell.
    await renderApp({ path: "/%zz", api: stubApi(api).fetch, token: "held" });

    expect(screen.getByText("No screen here")).toBeDefined();
    expect(screen.getByRole("link", { name: "Go to Sessions" })).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Hydra" })).toBeNull();
  });
});
