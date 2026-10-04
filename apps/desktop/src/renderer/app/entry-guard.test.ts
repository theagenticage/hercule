import { describe, expect, it } from "vitest";
import type { FirstRunProgress } from "../../ipc/contract";
import { resolveEntry, resolveFirstRunEntry, type EntryDeps } from "./entry-guard";

/** Returns the guards' reads for a controller in the given state. */
const buildDeps = ({
  complete = true,
  reachable = true,
  token = false,
  firstRun = null,
}: {
  readonly complete?: boolean;
  readonly reachable?: boolean;
  readonly token?: boolean;
  readonly firstRun?: FirstRunProgress | null;
}): EntryDeps => ({
  hasToken: () => token,
  readSetup: () =>
    reachable ? Promise.resolve({ complete }) : Promise.reject(new Error("cannot reach")),
  readFirstRun: () => Promise.resolve(firstRun),
});

const UNREACHABLE = { to: "/connect", search: { problem: "unreachable" } };
const IN_PROGRESS: FirstRunProgress = { putOff: ["github"] };

describe("resolveEntry", () => {
  it("sends every path to the connect screen when the controller cannot be read", async () => {
    for (const pathname of ["/", "/login"]) {
      expect(await resolveEntry(buildDeps({ reachable: false, token: true }), pathname)).toEqual(
        UNREACHABLE,
      );
    }
  });

  it("sends every path to the first run when the controller is not set up", async () => {
    for (const pathname of ["/", "/login"]) {
      expect(await resolveEntry(buildDeps({ complete: false, token: true }), pathname)).toEqual({
        to: "/first-run",
      });
    }
  });

  it("sends a user with no token to the sign-in screen", async () => {
    expect(await resolveEntry(buildDeps({}), "/")).toEqual({ to: "/login" });
  });

  it("lets a user with no token onto the sign-in screen, even with a first run kept", async () => {
    expect(await resolveEntry(buildDeps({ firstRun: IN_PROGRESS }), "/login")).toBeNull();
  });

  it("sends a signed-in user back to a first run in progress", async () => {
    for (const pathname of ["/", "/login"]) {
      expect(
        await resolveEntry(buildDeps({ token: true, firstRun: IN_PROGRESS }), pathname),
      ).toEqual({ to: "/first-run" });
    }
  });

  it("sends a signed-in user who asks for the sign-in screen home", async () => {
    expect(await resolveEntry(buildDeps({ token: true }), "/login")).toEqual({ to: "/" });
  });

  it("lets a signed-in user through to the screen they asked for", async () => {
    expect(await resolveEntry(buildDeps({ token: true }), "/")).toBeNull();
  });
});

describe("resolveFirstRunEntry", () => {
  it("lets the first run through when no controller is saved", async () => {
    expect(await resolveFirstRunEntry(null)).toBeNull();
  });

  it("sends the user to the connect screen when the controller cannot be read", async () => {
    expect(await resolveFirstRunEntry(buildDeps({ reachable: false }))).toEqual(UNREACHABLE);
  });

  it("lets the first run through while the controller is not set up", async () => {
    expect(await resolveFirstRunEntry(buildDeps({ complete: false }))).toBeNull();
  });

  it("sends a user with no token to the sign-in screen", async () => {
    expect(await resolveFirstRunEntry(buildDeps({ firstRun: IN_PROGRESS }))).toEqual({
      to: "/login",
    });
  });

  it("sends a user set up elsewhere home, because no first run is kept for them", async () => {
    expect(await resolveFirstRunEntry(buildDeps({ token: true }))).toEqual({ to: "/" });
  });

  it("lets a signed-in user resume a first run in progress", async () => {
    expect(
      await resolveFirstRunEntry(buildDeps({ token: true, firstRun: IN_PROGRESS })),
    ).toBeNull();
  });
});
