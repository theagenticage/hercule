import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildErrorBody,
  CONTROLLER_URL,
  createFakeBridge,
  refuseConnection,
  renderApp,
  stubApi,
  type Answer,
  type Handler,
} from "../../app/testing";

const LOGIN_RESULT: Answer = {
  body: { token: "fresh-bearer", expiresAt: "2026-10-29T12:00:00.000Z" },
};

/** Opens the sign-in screen with `login` as the controller's answer to signing in. */
const openSignIn = async (login: Handler = LOGIN_RESULT) => {
  const user = userEvent.setup();
  const calls = stubApi({ "POST /api/v1/auth/login": login });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL });
  const { router } = await renderApp(fake);
  return { user, calls, fake, router };
};

/** Fills both fields and presses Sign in. */
const signIn = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.type(screen.getByRole("textbox", { name: "Username" }), "rogier");
  await user.type(screen.getByLabelText("Password"), "hunter2");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("the sign-in screen", () => {
  it("enables Sign in only once both fields hold text", async () => {
    const { user } = await openSignIn();
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Sign in" });
    expect(button.disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Username" }), "rogier");
    expect(button.disabled).toBe(true);
    await user.type(screen.getByLabelText("Password"), "hunter2");
    expect(button.disabled).toBe(false);
  });

  it("signs in, stores the token with main, and shows the shell", async () => {
    const { user, calls, fake, router } = await openSignIn();
    await signIn(user);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    expect(calls.find((call) => call.path === "/api/v1/auth/login")?.body).toEqual({
      username: "rogier",
      password: "hunter2",
    });
    expect(fake.tokenWrites).toEqual(["fresh-bearer"]);
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("shows Signing in… while the controller checks the password, and keeps focus on the button", async () => {
    let answer: (result: Answer) => void = () => {};
    const { user } = await openSignIn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await signIn(user);
    const button = screen.getByRole("button", { name: "Signing in…" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    answer({ status: 401, body: buildErrorBody("unauthenticated", "no such user") });
    await waitFor(() => {
      expect(button.textContent).toBe("Sign in");
    });
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });

  it("signs in once when Enter is pressed twice", async () => {
    const { user, calls } = await openSignIn(() => new Promise(() => {}));
    await user.type(screen.getByRole("textbox", { name: "Username" }), "rogier");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    // No delay between the presses, so the second arrives before React renders again.
    await userEvent.setup({ delay: null }).keyboard("{Enter}{Enter}");
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/v1/auth/login")).toHaveLength(1);
    });
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
  });

  it("says the username or password is wrong, without saying which", async () => {
    const { user, fake } = await openSignIn({
      status: 401,
      body: buildErrorBody("unauthenticated", "no such user"),
    });
    await signIn(user);
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong username or password.");
    // No token is stored. The client clears its token on every
    // `unauthenticated` error, so main is told to remove one.
    expect(fake.tokenWrites).toEqual([null]);
  });

  it("names the controller it could not reach", async () => {
    const { user } = await openSignIn(refuseConnection);
    await signIn(user);
    expect((await screen.findByRole("alert")).textContent).toBe(
      `Could not reach ${CONTROLLER_URL}.`,
    );
  });

  it("shows the controller and goes back to the connect screen on Change", async () => {
    const { user, router } = await openSignIn();
    expect(screen.getByText(`Connected to ${CONTROLLER_URL}`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/connect");
    });
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Controller address" }).value,
    ).toBe(CONTROLLER_URL);
  });
});
