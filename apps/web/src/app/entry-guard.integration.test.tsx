import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { buildErrorBody, renderApp, stubApi } from "./testing";

const SETUP_INCOMPLETE = { "GET /api/v1/setup": { body: { complete: false } } };
const SETUP_COMPLETE = { "GET /api/v1/setup": { body: { complete: true } } };

const buildSettingsRoute = (user: Record<string, unknown>) => ({
  "GET /api/v1/settings": { body: { controller: {}, user } },
});

const waitForPath = async (
  router: { state: { location: { pathname: string } } },
  pathname: string,
) => {
  await waitFor(() => {
    expect(router.state.location.pathname).toBe(pathname);
  });
};

describe("the entry guard", () => {
  it("redirects every path to setup until first run is complete", async () => {
    const api = stubApi(SETUP_INCOMPLETE);
    const { router } = await renderApp({ path: "/tasks", api: api.fetch });
    await waitForPath(router, "/setup");
  });

  it("keeps the setup link and its query string until first run is complete", async () => {
    const api = stubApi(SETUP_INCOMPLETE);
    const { router } = await renderApp({ path: "/setup?token=abc", api: api.fetch });
    await waitForPath(router, "/setup");
    expect(router.state.location.search).toEqual({ token: "abc" });
  });

  it("sends a visitor with no token to the login screen", async () => {
    const api = stubApi(SETUP_COMPLETE);
    const { router } = await renderApp({ path: "/runs", api: api.fetch });
    await waitForPath(router, "/login");
  });

  it("sends a signed-in user with an unfinished onboarding step to that step", async () => {
    const api = stubApi({ ...SETUP_COMPLETE, ...buildSettingsRoute({}) });
    const { router } = await renderApp({ path: "/runs", api: api.fetch, token: "bearer" });
    await waitForPath(router, "/onboarding/timezone");
  });

  it("lets a signed-in user who finished onboarding through to the requested route", async () => {
    const api = stubApi({
      ...SETUP_COMPLETE,
      ...buildSettingsRoute({
        timezone: "Europe/Amsterdam",
        "onboarding.completedSteps": ["timezone", "assistant"],
      }),
      "GET /api/v1/runs": { body: { items: [] } },
    });
    const { router } = await renderApp({ path: "/runs", api: api.fetch, token: "bearer" });
    await waitForPath(router, "/runs");
  });

  it("takes a signed-in user off the login screen", async () => {
    const api = stubApi({
      ...SETUP_COMPLETE,
      ...buildSettingsRoute({ "onboarding.completedSteps": ["timezone", "assistant"] }),
    });
    const { router } = await renderApp({ path: "/login", api: api.fetch, token: "bearer" });
    await waitForPath(router, "/");
  });

  it("sends the user to the login screen when the live connection's token is rejected", async () => {
    // The live connection requests its ticket on its own, so this 401 is the
    // only one that arrives without a navigation waiting for it.
    const api = stubApi({
      ...SETUP_COMPLETE,
      ...buildSettingsRoute({ "onboarding.completedSteps": ["timezone", "assistant"] }),
      "GET /api/v1/tasks": { body: { items: [] } },
      "POST /api/v1/auth/ws-ticket": {
        status: 401,
        body: buildErrorBody("unauthenticated", "the token is not valid"),
      },
    });
    const { router, client } = await renderApp({
      path: "/tasks",
      api: api.fetch,
      token: "stale",
    });

    await waitForPath(router, "/login");
    expect(client.getToken()).toBeNull();
  });

  it("sends the user to the login screen and drops the token when the token is rejected", async () => {
    const api = stubApi({
      ...SETUP_COMPLETE,
      "GET /api/v1/settings": {
        status: 401,
        body: buildErrorBody("unauthenticated", "the token is not valid"),
      },
    });
    const { router, client } = await renderApp({
      path: "/tasks",
      api: api.fetch,
      token: "stale",
    });
    await waitForPath(router, "/login");
    expect(client.getToken()).toBeNull();
  });
});
