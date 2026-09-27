import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resolveBrowserTimezone } from "@hercule/client-core";
import { renderApp, stubApi, type Handler } from "../../app/testing";

/**
 * The assistant list the next step, `/onboarding/assistant`, reads. It is
 * empty because these tests only check that the step is reached.
 */
const NO_ASSISTANTS: Readonly<Record<string, Handler>> = {
  "GET /api/v1/assistants": { body: { items: [] } },
};

/** Returns stub routes for a controller whose user has completed no onboarding steps yet. */
const buildFreshController = (): Readonly<Record<string, Handler>> => {
  let user: Record<string, unknown> = {};
  return {
    ...NO_ASSISTANTS,
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": () => ({ body: { controller: {}, user } }),
    "PATCH /api/v1/settings": (call) => {
      user = { ...user, ...(call.body as { user: Record<string, unknown> }).user };
      return { body: { controller: {}, user } };
    },
  };
};

describe("the timezone step", () => {
  it("offers the zone the browser detected", async () => {
    const api = stubApi(buildFreshController());
    await renderApp({ path: "/", api: api.fetch, token: "bearer" });

    const field = await screen.findByLabelText<HTMLSelectElement>("Timezone");
    expect(field.value).toBe(resolveBrowserTimezone());
  });

  it("offers only zones this browser can format, and no free text", async () => {
    const api = stubApi(buildFreshController());
    await renderApp({ path: "/", api: api.fetch, token: "bearer" });

    const field = await screen.findByLabelText<HTMLSelectElement>("Timezone");
    expect(field.tagName).toBe("SELECT");
    const offered = [...field.options].map((option) => option.value);
    expect(offered).toContain("UTC");
    expect(offered).not.toContain("Amsterdam");
    for (const zone of offered) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone })).not.toThrow();
    }
  });

  it("sends the zone the user picks", async () => {
    const api = stubApi(buildFreshController());
    const { router } = await renderApp({ path: "/", api: api.fetch, token: "bearer" });

    const field = await screen.findByLabelText<HTMLSelectElement>("Timezone");
    const user = userEvent.setup();
    await user.selectOptions(field, "Pacific/Auckland");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/onboarding/assistant");
    });
    const written = api.calls.find((call) => call.method === "PATCH")!;
    expect((written.body as { user: Record<string, unknown> }).user).toMatchObject({
      timezone: "Pacific/Auckland",
    });
  });

  it("records the step as completed and moves on to the assistant step", async () => {
    const api = stubApi(buildFreshController());
    const { router } = await renderApp({ path: "/", api: api.fetch, token: "bearer" });

    await screen.findByLabelText<HTMLSelectElement>("Timezone");
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/onboarding/assistant");
    });
    const written = api.calls.find((call) => call.method === "PATCH")!;
    expect(written.body).toEqual({
      user: {
        timezone: resolveBrowserTimezone(),
        "onboarding.completedSteps": ["timezone"],
      },
    });
  });

  it("keeps the steps already recorded", async () => {
    const api = stubApi({
      ...NO_ASSISTANTS,
      "GET /api/v1/setup": { body: { complete: true } },
      "GET /api/v1/settings": {
        body: { controller: {}, user: { "onboarding.completedSteps": ["from-a-later-client"] } },
      },
      "PATCH /api/v1/settings": (call) => ({
        body: { controller: {}, user: (call.body as { user: unknown }).user },
      }),
    });
    const { router } = await renderApp({ path: "/", api: api.fetch, token: "bearer" });

    await screen.findByLabelText<HTMLSelectElement>("Timezone");
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/onboarding/assistant");
    });
    const written = api.calls.find((call) => call.method === "PATCH")!;
    expect((written.body as { user: Record<string, unknown> }).user).toMatchObject({
      "onboarding.completedSteps": ["from-a-later-client", "timezone"],
    });
  });
});
