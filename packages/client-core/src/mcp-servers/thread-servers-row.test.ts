import { describe, expect, it } from "vitest";
import { LINEAR, SENTRY_WORK, buildServer } from "./testing";
import { countServersNeedingSignIn, describeThreadServersRow } from "./thread-servers-row";

describe("countServersNeedingSignIn", () => {
  it("counts only the thread's own servers that need sign-in", () => {
    const servers = [
      buildServer("s-work", "sentry", "c-work", { status: "needs-sign-in" }),
      buildServer("s-hobby", "sentry", "c-hobby", { status: "needs-sign-in" }),
      buildServer("s-off", "alpha", "c-linear", { status: "needs-sign-in", enabled: false }),
      LINEAR,
    ];

    expect(countServersNeedingSignIn(servers, ["s-work", "s-off", "s-linear"])).toBe(1);
  });
});

describe("describeThreadServersRow", () => {
  it("says none for an empty list, and the count otherwise", () => {
    const servers = [SENTRY_WORK, LINEAR];

    expect(describeThreadServersRow(servers, [])).toEqual({ words: "none", failing: false });
    expect(describeThreadServersRow(servers, ["s-work"])).toEqual({ words: "1", failing: false });
    expect(describeThreadServersRow(servers, ["s-work", "s-linear"])).toEqual({
      words: "2",
      failing: false,
    });
  });

  it("names the servers that need sign-in, in the singular and the plural", () => {
    const servers = [
      buildServer("s-work", "sentry", "c-work", { status: "needs-sign-in" }),
      buildServer("s-linear", "linear", "c-linear", { status: "needs-sign-in" }),
      buildServer("s-gh", "github", "c-linear"),
    ];

    expect(describeThreadServersRow(servers, ["s-work", "s-gh"])).toEqual({
      words: "1 needs sign-in",
      failing: true,
    });
    expect(describeThreadServersRow(servers, ["s-work", "s-linear", "s-gh"])).toEqual({
      words: "2 need sign-in",
      failing: true,
    });
  });

  it("shows the count while the servers are not read", () => {
    expect(describeThreadServersRow([], ["s-work", "s-linear"])).toEqual({
      words: "2",
      failing: false,
    });
  });
});
