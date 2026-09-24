import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resolveBrowserTimezone } from "@hercule/client-core";
import { buildErrorBody, renderApp, stubApi, type Answer, type Handler } from "../app/testing";

/** A controller on its first run, which is over once setup has answered. */
const buildFirstRunController = (complete: Answer): Readonly<Record<string, Handler>> => {
  let done = false;
  return {
    "GET /api/v1/setup": () => ({ body: { complete: done } }),
    "POST /api/v1/setup/complete": () => {
      done = true;
      return complete;
    },
    "GET /api/v1/settings": { body: { controller: {}, user: {} } },
  };
};

const fillIn = async (username: string, password: string) => {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Username"), username);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Create account" }));
};

describe("the setup screen", () => {
  it("asks for the setup link when the token is missing", async () => {
    const api = stubApi({ "GET /api/v1/setup": { body: { complete: false } } });
    await renderApp({ path: "/setup", api: api.fetch });

    expect(await screen.findByText(/printed a setup URL/)).toBeDefined();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("sends the browser's timezone with the account, without asking for it", async () => {
    const api = stubApi(buildFirstRunController({ body: { token: "minted" } }));
    const { client } = await renderApp({ path: "/setup?token=one-time", api: api.fetch });

    await fillIn("rogier", "hunter2hunter2");

    await waitFor(() => {
      expect(api.calls.some((call) => call.path === "/api/v1/setup/complete")).toBe(true);
    });
    const complete = api.calls.find((call) => call.path === "/api/v1/setup/complete")!;
    expect(complete.token).toBe("one-time");
    expect(complete.body).toEqual({
      username: "rogier",
      password: "hunter2hunter2",
      timezone: resolveBrowserTimezone(),
    });
    await waitFor(() => {
      expect(client.getToken()).toBe("minted");
    });
  });

  it("takes the spent token out of the address bar and out of the back button", async () => {
    const api = stubApi(buildFirstRunController({ body: { token: "minted" } }));
    const { router } = await renderApp({ path: "/setup?token=one-time", api: api.fetch });

    await fillIn("rogier", "hunter2hunter2");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/onboarding/timezone");
    });
    expect(router.state.location.searchStr).toBe("");
    expect(router.history.canGoBack()).toBe(false);
  });

  it("shows what the API said when it refuses", async () => {
    const api = stubApi(
      buildFirstRunController({
        status: 401,
        body: buildErrorBody("unauthenticated", "the setup token has expired"),
      }),
    );
    const { router } = await renderApp({ path: "/setup?token=stale", api: api.fetch });

    await fillIn("rogier", "hunter2hunter2");

    expect((await screen.findByRole("alert")).textContent).toBe("the setup token has expired");
    expect(router.state.location.pathname).toBe("/setup");
  });

  it("refuses a password the contract would refuse, without asking the API", async () => {
    const api = stubApi(buildFirstRunController({ body: { token: "minted" } }));
    await renderApp({ path: "/setup?token=one-time", api: api.fetch });

    await fillIn("rogier", "short");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "A password is at least 8 characters.",
    );
    expect(api.calls.some((call) => call.path === "/api/v1/setup/complete")).toBe(false);
  });
});
