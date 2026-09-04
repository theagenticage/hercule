import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { envelope, renderApp, stubApi } from "./testing";

const SETUP_INCOMPLETE = { "GET /api/v1/setup": { body: { complete: false } } };
const SETUP_COMPLETE = { "GET /api/v1/setup": { body: { complete: true } } };

const settings = (user: Record<string, unknown>) => ({
  "GET /api/v1/settings": { body: { controller: {}, user } },
});

const at = async (router: { state: { location: { pathname: string } } }, pathname: string) => {
  await waitFor(() => {
    expect(router.state.location.pathname).toBe(pathname);
  });
};

describe("the entry guard", () => {
  it("sends everything to setup while first run has not happened", async () => {
    const api = stubApi(SETUP_INCOMPLETE);
    const { router } = await renderApp({ path: "/tasks", api: api.fetch });
    await at(router, "/setup");
  });

  it("leaves the setup link alone while first run has not happened", async () => {
    const api = stubApi(SETUP_INCOMPLETE);
    const { router } = await renderApp({ path: "/setup?token=abc", api: api.fetch });
    await at(router, "/setup");
    expect(router.state.location.search).toEqual({ token: "abc" });
  });

  it("sends a visitor with no token to the login screen", async () => {
    const api = stubApi(SETUP_COMPLETE);
    const { router } = await renderApp({ path: "/runs", api: api.fetch });
    await at(router, "/login");
  });

  it("sends a signed-in user with onboarding left to the step that is left", async () => {
    const api = stubApi({ ...SETUP_COMPLETE, ...settings({}) });
    const { router } = await renderApp({ path: "/runs", api: api.fetch, token: "bearer" });
    await at(router, "/onboarding/timezone");
  });

  it("lets a signed-in user with onboarding done through to the route they asked for", async () => {
    const api = stubApi({
      ...SETUP_COMPLETE,
      ...settings({ timezone: "Europe/Amsterdam", "onboarding.completedSteps": ["timezone"] }),
      "GET /api/v1/runs": { body: { items: [] } },
    });
    const { router } = await renderApp({ path: "/runs", api: api.fetch, token: "bearer" });
    await at(router, "/runs");
  });

  it("takes a signed-in user off the login screen", async () => {
    const api = stubApi({
      ...SETUP_COMPLETE,
      ...settings({ "onboarding.completedSteps": ["timezone"] }),
    });
    const { router } = await renderApp({ path: "/login", api: api.fetch, token: "bearer" });
    await at(router, "/");
  });

  it("sends a rejected token back to the login screen, holding it no longer", async () => {
    const api = stubApi({
      ...SETUP_COMPLETE,
      "GET /api/v1/settings": {
        status: 401,
        body: envelope("unauthenticated", "the token is not valid"),
      },
    });
    const { router, client } = await renderApp({
      path: "/tasks",
      api: api.fetch,
      token: "stale",
    });
    await at(router, "/login");
    expect(client.getToken()).toBeNull();
  });
});
