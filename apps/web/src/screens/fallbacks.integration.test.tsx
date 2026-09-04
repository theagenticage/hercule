import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RouterContextProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { RenderFailure } from "./fallbacks";
import { renderApp, stubApi, type Handler } from "../app/testing";

const api: Readonly<Record<string, Handler>> = {
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
    },
  },
};

/**
 * The failure screen where the router would draw it: in the real router,
 * standing at the path that failed, so the frame it picks is the one the app
 * would show.
 */
const failureAt = async (path: string, token: string | null = "held") => {
  const { router, queryClient, unmount } = await renderApp({
    path,
    api: stubApi(api).fetch,
    token,
  });
  unmount();

  render(
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router}>
        <RenderFailure error={new Error("the chunk did not load")} />
      </RouterContextProvider>
    </QueryClientProvider>,
  );
};

describe("the screen a render failure leaves behind", () => {
  it("names what went wrong and offers the way back", async () => {
    await failureAt("/tasks");

    expect(screen.getByText("This screen did not load")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toBe("the chunk did not load");
    expect(screen.getByRole("link", { name: "Go to Sessions" })).toBeDefined();
  });

  it("is a screen of the shell when the shell is what failed inside", async () => {
    await failureAt("/tasks");

    expect(screen.getByText(/The rest of Hydra is still here/)).toBeDefined();
    expect(screen.queryByText("Hydra")).toBeNull();
  });

  it("is the whole page outside the shell, where there is nothing to keep", async () => {
    await failureAt("/login", null);

    expect(screen.queryByText(/The rest of Hydra is still here/)).toBeNull();
    expect(screen.getByText("Hydra")).toBeDefined();
  });
});
