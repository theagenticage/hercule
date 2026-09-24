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
 * Renders the failure screen inside the real router, at the path that failed,
 * so it picks the same frame the app would show.
 */
const renderFailureAt = async (path: string, token: string | null = "held") => {
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

describe("the screen shown after a render failure", () => {
  it("shows the error message and a link back to Sessions", async () => {
    await renderFailureAt("/tasks");

    expect(screen.getByText("This screen did not load")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toBe("the chunk did not load");
    expect(screen.getByRole("link", { name: "Go to Sessions" })).toBeDefined();
  });

  it("renders inside the shell when the failure is inside the shell", async () => {
    await renderFailureAt("/tasks");

    expect(screen.getByText(/The rest of Hercule is still here/)).toBeDefined();
    expect(screen.queryByText("Hercule")).toBeNull();
  });

  it("takes the whole page when the failure is outside the shell", async () => {
    await renderFailureAt("/login", null);

    expect(screen.queryByText(/The rest of Hercule is still here/)).toBeNull();
    expect(screen.getByText("Hercule")).toBeDefined();
  });
});
