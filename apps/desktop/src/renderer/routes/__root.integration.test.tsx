import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  buildErrorBody,
  CONTROLLER_URL,
  createFakeBridge,
  neverAnswer,
  refuseConnection,
  renderApp,
  stubApi,
  type Handler,
} from "../app/testing";

/** A query the shell might have cached while the user was signed in. */
const CACHED_KEY = ["cached-before-sign-out"];

/**
 * Starts the app signed in, with `logout` as the controller's answer to
 * signing out, and caches one query as the signed-in user.
 */
const startSignedIn = async ({
  logout = { body: {} },
  setup = { body: { complete: true } },
}: { readonly logout?: Handler; readonly setup?: Handler } = {}) => {
  const calls = stubApi({ "POST /api/v1/auth/logout": logout, "GET /api/v1/setup": setup });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const { router, context } = await renderApp(fake);
  context.queryClient.setQueryData(CACHED_KEY, "read as the signed-in user");
  return { calls, fake, router, context };
};

describe("Sign Out from the app menu", () => {
  it("forgets the token, shows the sign-in screen, empties the caches and revokes the token", async () => {
    const { calls, fake, router, context } = await startSignedIn();
    const clearRouterCache = vi.spyOn(router, "clearCache");
    fake.sendMenuCommand("signOut");
    expect(await screen.findByRole("textbox", { name: "Username" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    expect(context.controller?.client.getToken()).toBeNull();
    // One write: the successful revoke touches neither the store nor the app's client.
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/v1/auth/logout")).toEqual([
        {
          method: "POST",
          path: "/api/v1/auth/logout",
          query: {},
          body: undefined,
          authorization: "Bearer bearer",
        },
      ]);
    });
    expect(fake.tokenWrites).toEqual([null]);
    expect(context.queryClient.getQueryData(CACHED_KEY)).toBeUndefined();
    expect(clearRouterCache).toHaveBeenCalledOnce();
  });

  it("stops the live connection before it shows the sign-in screen, and empties the caches only once the screen shows", async () => {
    const { fake, router, context } = await startSignedIn();
    const controller = context.controller!;
    const queryClient = context.queryClient;
    const steps: string[] = [];
    // The first stop, Sign Out's, never finishes, as with a socket that
    // does not close. Sign Out must not wait for it.
    vi.spyOn(controller.live, "stop").mockImplementationOnce(() => {
      steps.push(`stop live, token ${String(controller.client.getToken())}`);
      return new Promise(() => {});
    });
    const navigate = router.navigate.bind(router);
    vi.spyOn(router, "navigate").mockImplementation((options) => {
      steps.push(`navigate to ${String(options.to)}`);
      return navigate(options);
    });
    // Emptied while the shell is still on screen, the cache would make the
    // sidebar read again at once, with no token.
    const clear = queryClient.clear.bind(queryClient);
    vi.spyOn(queryClient, "clear").mockImplementation(() => {
      const signInShown = screen.queryByRole("textbox", { name: "Username" }) !== null;
      steps.push(
        `empty the query cache on ${String(router.state.resolvedLocation?.pathname)}, sign-in screen ${signInShown ? "shown" : "not shown"}`,
      );
      clear();
    });

    fake.sendMenuCommand("signOut");
    await waitFor(() => {
      expect(steps).toEqual([
        "stop live, token null",
        "navigate to /login",
        "empty the query cache on /login, sign-in screen shown",
      ]);
    });
    expect(queryClient.getQueryData(CACHED_KEY)).toBeUndefined();
  });

  it("signs out at once when the controller never answers the revoke", async () => {
    const { fake, router, context } = await startSignedIn({ logout: neverAnswer });
    fake.sendMenuCommand("signOut");
    // The token is gone from memory and from main's store before anything
    // is awaited.
    expect(context.controller?.client.getToken()).toBeNull();
    expect(fake.tokenWrites).toEqual([null]);
    expect(await screen.findByRole("textbox", { name: "Username" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    expect(context.queryClient.getQueryData(CACHED_KEY)).toBeUndefined();
  });

  it("keeps a token from signing in again when a late revoke succeeds", async () => {
    let answerRevoke: (answer: { body: unknown }) => void = () => {};
    const { fake, context } = await startSignedIn({
      logout: () =>
        new Promise((resolve) => {
          answerRevoke = resolve;
        }),
    });
    fake.sendMenuCommand("signOut");
    await screen.findByRole("textbox", { name: "Username" });
    context.controller?.client.setToken("signed in again");
    answerRevoke({ body: {} });
    await waitFor(() => {
      expect(fake.tokenWrites).toEqual([null, "signed in again"]);
    });
    expect(context.controller?.client.getToken()).toBe("signed in again");
  });

  it("forgets the token even when the controller refuses to revoke it", async () => {
    const { fake, router, context } = await startSignedIn({
      logout: { status: 500, body: buildErrorBody("internal", "boom") },
    });
    fake.sendMenuCommand("signOut");
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    expect(context.controller?.client.getToken()).toBeNull();
    expect(fake.tokenWrites).toContain(null);
  });

  it("works on the connect screen while the controller is down", async () => {
    const { fake, router, context } = await startSignedIn({
      logout: refuseConnection,
      setup: refuseConnection,
    });
    expect(router.state.location.pathname).toBe("/connect");
    fake.sendMenuCommand("signOut");
    await waitFor(() => {
      expect(fake.tokenWrites).toContain(null);
    });
    expect(context.controller?.client.getToken()).toBeNull();
    // The sign-in screen needs the controller, so the guard sends the user
    // back to the connect screen. Signed out there, the user's reads are
    // emptied all the same.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/connect");
      expect(context.queryClient.getQueryData(CACHED_KEY)).toBeUndefined();
    });
  });
});
