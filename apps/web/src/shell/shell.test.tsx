import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, stubApi, type Handler } from "../app/testing";

const settings = (user: Record<string, unknown>) => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: { controller: {}, user: { "onboarding.completedSteps": ["timezone"], ...user } },
  },
});

const inShell = (user: Record<string, unknown> = {}): Readonly<Record<string, Handler>> =>
  settings({ timezone: "Europe/Amsterdam", ...user });

const hydraNav = () => within(screen.getByRole("navigation", { name: "Hydra" }));

const threadsNav = () => within(screen.getByRole("navigation", { name: "Threads" }));

const navLabels = (): string[] =>
  hydraNav()
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("the two-face sidebar", () => {
  it("shows the Hydra face on an orchestration screen, in its pinned order", async () => {
    await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    expect(navLabels()).toEqual([
      "Intake",
      "Check-in",
      "Tasks",
      "Runs",
      "Workflows",
      "Fleet",
      "Connections",
      "Notifications",
      "Settings",
    ]);
  });

  it("carries a glyph on the entity items and on no other", async () => {
    await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    const withGlyph = hydraNav()
      .getAllByRole("link")
      .filter((link) => link.querySelector("[data-mark]") !== null)
      .map((link) => link.textContent);

    expect(withGlyph).toEqual(["Tasks", "Runs", "Workflows"]);
  });

  it("shows the Threads face on Sessions", async () => {
    await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    expect(
      threadsNav()
        .getByRole("button", { name: /Create new thread/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(threadsNav().getByText("No threads yet")).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Hydra" })).toBeNull();
  });

  it("switches face when the segmented switch is used", async () => {
    const user = userEvent.setup();
    await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    await user.click(screen.getByRole("radio", { name: /Hydra/ }));

    expect(navLabels()[0]).toBe("Intake");
  });

  it("puts the screen back in charge of the face on the next navigation", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    await user.click(screen.getByRole("radio", { name: /Hydra/ }));
    await user.click(hydraNav().getByRole("link", { name: "Intake" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/intake");
    });
    expect(navLabels()[0]).toBe("Intake");

    await user.click(screen.getByRole("radio", { name: "Threads" }));
    expect(threadsNav().getByText("No threads yet")).toBeDefined();
  });

  it("reads the thread-row density from the settings store", async () => {
    await renderApp({
      path: "/",
      api: stubApi(inShell({ "ui.threadRows": "plain" })).fetch,
      token: "held",
    });

    expect(threadsNav().getByText("No threads yet").parentElement?.dataset.threadRows).toBe(
      "plain",
    );
  });

  it("defaults the thread-row density to meta", async () => {
    await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    expect(threadsNav().getByText("No threads yet").parentElement?.dataset.threadRows).toBe("meta");
  });

  it("opens the marks legend on ?", async () => {
    const user = userEvent.setup();
    await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    expect(screen.queryByLabelText("Marks legend")).toBeNull();
    await user.keyboard("?");

    expect(await screen.findByLabelText("Marks legend")).toBeDefined();
  });
});

describe("the pulse at the sidebar foot", () => {
  const pulseButton = () => screen.getByRole("button", { name: /Nothing to report yet/ });

  it("is collapsed on arrival", async () => {
    await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    expect(pulseButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on click and remembers that for the browser session", async () => {
    const user = userEvent.setup();
    const first = await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    await user.click(pulseButton());
    expect(pulseButton().getAttribute("aria-expanded")).toBe("true");

    // The second load is a second page load, so the first one is gone by then
    // and the pulse is the only one on screen.
    first.unmount();
    await renderApp({ path: "/runs", api: stubApi(inShell()).fetch, token: "held" });
    expect(pulseButton().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("the top bar", () => {
  it("names the screen and reads the clock in the user's zone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      await renderApp({ path: "/runs", api: stubApi(inShell()).fetch, token: "held" });

      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Runs");
      expect(screen.getByText("Monday 09:14")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a zone this browser does not know in UTC, and says so", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      const api = stubApi(inShell({ timezone: "Europe/Nowhere" }));
      await renderApp({ path: "/runs", api: api.fetch, token: "held" });

      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Runs");
      expect(screen.getByText("Monday 07:14")).toBeDefined();
      expect(
        screen.getByRole("link", { name: /does not know the zone Europe\/Nowhere/ }),
      ).toBeDefined();
      expect(screen.getByRole("navigation", { name: "Hydra" })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("frames Intake on when the user last checked", async () => {
    const api = stubApi(inShell({ "lastChecked.intake": "2026-09-06T20:10:00.000Z" }));
    await renderApp({ path: "/intake", api: api.fetch, token: "held" });

    expect(screen.getByText("since Sunday 22:10")).toBeDefined();
  });

  it("reads Intake as the plain clock until that marker exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      await renderApp({ path: "/intake", api: stubApi(inShell()).fetch, token: "held" });

      expect(screen.getByText("Monday 09:14")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
