import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { envelope, renderApp, stubApi, type Answer, type Handler } from "../app/testing";

const controller = (login: Answer): Readonly<Record<string, Handler>> => ({
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
  it("names neither half when the credentials are refused", async () => {
    const api = stubApi(
      controller({ status: 401, body: envelope("unauthenticated", "no such user") }),
    );
    const { router } = await renderApp({ path: "/login", api: api.fetch });

    await signIn("wrong-password");

    expect((await screen.findByRole("alert")).textContent).toBe("Wrong username or password.");
    expect(router.state.location.pathname).toBe("/login");
  });

  it("says what an empty form is missing, in words a person wrote", async () => {
    const user = userEvent.setup();
    const api = stubApi(controller({ body: {} }));
    await renderApp({ path: "/login", api: api.fetch });

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const messages = screen.getAllByRole("alert").map((alert) => alert.textContent);
    expect(messages).toEqual([
      "A username is 1 to 64 characters.",
      "A password is 1 to 1024 characters.",
    ]);
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("shows any other failure as the API worded it", async () => {
    const api = stubApi(
      controller({ status: 500, body: envelope("internal", "the database is locked") }),
    );
    await renderApp({ path: "/login", api: api.fetch });

    await signIn("hunter2hunter2");

    expect((await screen.findByRole("alert")).textContent).toBe("the database is locked");
  });

  it("holds the token it was given and goes home", async () => {
    const api = stubApi(
      controller({ body: { token: "minted", expiresAt: "2026-10-04T00:00:00.000Z" } }),
    );
    const { router, client } = await renderApp({ path: "/login", api: api.fetch });

    await signIn("hunter2hunter2");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    expect(client.getToken()).toBe("minted");
  });
});
