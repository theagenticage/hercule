import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildErrorBody, renderApp, stubApi, type Answer, type Handler } from "../app/testing";

const buildController = (login: Answer): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "POST /api/v1/auth/login": login,
  "GET /api/v1/settings": {
    body: { controller: {}, user: { "onboarding.completedSteps": ["timezone"] } },
  },
});

const signIn = async (password: string) => {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Username"), "rogier");
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("the login screen", () => {
  it("does not say which field was wrong when the credentials are rejected", async () => {
    const api = stubApi(
      buildController({ status: 401, body: buildErrorBody("unauthenticated", "no such user") }),
    );
    const { router } = await renderApp({ path: "/login", api: api.fetch });

    await signIn("wrong-password");

    expect((await screen.findByRole("alert")).textContent).toBe("Wrong username or password.");
    expect(router.state.location.pathname).toBe("/login");
  });

  it("shows a readable message for each empty field, without calling the API", async () => {
    const user = userEvent.setup();
    const api = stubApi(buildController({ body: {} }));
    await renderApp({ path: "/login", api: api.fetch });

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const messages = screen.getAllByRole("alert").map((alert) => alert.textContent);
    expect(messages).toEqual(["Enter your username.", "Enter your password."]);
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("shows the API's error message for any other failure", async () => {
    const api = stubApi(
      buildController({ status: 500, body: buildErrorBody("internal", "the database is locked") }),
    );
    await renderApp({ path: "/login", api: api.fetch });

    await signIn("hunter2hunter2");

    expect((await screen.findByRole("alert")).textContent).toBe("the database is locked");
  });

  it("keeps the returned token and goes to the home screen", async () => {
    const api = stubApi(
      buildController({ body: { token: "minted", expiresAt: "2026-10-04T00:00:00.000Z" } }),
    );
    const { router, client } = await renderApp({ path: "/login", api: api.fetch });

    await signIn("hunter2hunter2");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    expect(client.getToken()).toBe("minted");
  });
});
