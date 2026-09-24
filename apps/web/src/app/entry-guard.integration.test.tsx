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
  it("sends everything to setup while first run has not happened", async () => {
    const api = stubApi(SETUP_INCOMPLETE);
    const { router } = await renderApp({ path: "/tasks", api: api.fetch });
    await waitForPath(router, "/setup");
  });

  it("leaves the setup link alone while first run has not happened", async () => {
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

  it("sends a signed-in user with onboarding left to the step that is left", async () => {
    const api = stubApi({ ...SETUP_COMPLETE, ...buildSettingsRoute({}) });
    const { router } = await renderApp({ path: "/runs", api: api.fetch, token: "bearer" });
    await waitForPath(router, "/onboarding/timezone");
  });

  it("lets a signed-in user with onboarding done through to the route they asked for", async () => {
    const api = stubApi({
      ...SETUP_COMPLETE,
      ...buildSettingsRoute({
        timezone: "Europe/Amsterdam",
        "onboarding.completedSteps": ["timezone"],
      }),
      "GET /api/v1/runs": { body: { items: [] } },
    });
    const { router } = await renderApp({ path: "/runs", api: api.fetch, token: "bearer" });
    await waitForPath(router, "/runs");
  });

  it("takes a signed-in user off the login screen", async () => {
    const api = stubApi({
      ...SETUP_COMPLETE,
      ...buildSettingsRoute({ "onboarding.completedSteps": ["timezone"] }),
    });
    const { router } = await renderApp({ path: "/login", api: api.fetch, token: "bearer" });
    await waitForPath(router, "/");
  });

  it("sends a token the live connection found rejected back to the login screen", async () => {
    // Nobody asked for the ticket the live connection fetches, so a refusal
    // there is the one 401 no navigation is waiting behind.
    const api = stubApi({
      ...SETUP_COMPLETE,
      ...buildSettingsRoute({ "onboarding.completedSteps": ["timezone"] }),
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

  it("sends a rejected token back to the login screen, holding it no longer", async () => {
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
