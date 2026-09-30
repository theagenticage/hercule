import { describe, expect, it } from "vitest";
import { resolveEntry, type EntryDeps } from "./entry-guard";

/** Returns the guard's reads for a controller in the given state. */
const buildDeps = ({
  complete = true,
  reachable = true,
  token = false,
}: {
  readonly complete?: boolean;
  readonly reachable?: boolean;
  readonly token?: boolean;
}): EntryDeps => ({
  hasToken: () => token,
  readSetup: () =>
    reachable ? Promise.resolve({ complete }) : Promise.reject(new Error("cannot reach")),
});

describe("resolveEntry", () => {
  it("sends every path to the connect screen when the controller cannot be read", async () => {
    for (const pathname of ["/", "/login"]) {
      expect(await resolveEntry(buildDeps({ reachable: false, token: true }), pathname)).toEqual({
        to: "/connect",
        search: { problem: "unreachable" },
      });
    }
  });

  it("sends every path to the connect screen when the controller is not set up", async () => {
    for (const pathname of ["/", "/login"]) {
      expect(await resolveEntry(buildDeps({ complete: false, token: true }), pathname)).toEqual({
        to: "/connect",
        search: { problem: "setupIncomplete" },
      });
    }
  });

  it("sends a user with no token to the sign-in screen", async () => {
    expect(await resolveEntry(buildDeps({}), "/")).toEqual({ to: "/login" });
  });

  it("lets a user with no token onto the sign-in screen", async () => {
    expect(await resolveEntry(buildDeps({}), "/login")).toBeNull();
  });

  it("sends a signed-in user who asks for the sign-in screen home", async () => {
    expect(await resolveEntry(buildDeps({ token: true }), "/login")).toEqual({ to: "/" });
  });

  it("lets a signed-in user through to the screen they asked for", async () => {
    expect(await resolveEntry(buildDeps({ token: true }), "/")).toBeNull();
  });
});
