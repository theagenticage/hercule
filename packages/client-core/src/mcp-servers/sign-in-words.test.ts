import { describe, expect, it } from "vitest";
import { buildServer } from "./testing";
import { describePasteRefusal, describeSignInRefusal, offersBrowserSignIn } from "./sign-in-words";

describe("describeSignInRefusal", () => {
  it("has its own sentence for each reason, and the controller's words for any other failure", () => {
    expect(describeSignInRefusal("sign-in-expired", "x")).toContain("Start again");
    expect(describeSignInRefusal("sign-in-refused", "x")).toContain("refused the sign-in");
    expect(describeSignInRefusal("source-unreadable", "x")).toContain("Try again later");
    expect(describeSignInRefusal("timed-out", "x")).toContain("10 minutes");
    expect(describeSignInRefusal("failed", "The network is down.")).toBe("The network is down.");
  });

  it("quotes the parser's reason for a pasted text", () => {
    expect(describePasteRefusal("there is no state")).toBe(
      "That is not what the browser ended on: there is no state.",
    );
  });
});

describe("offersBrowserSignIn", () => {
  const urlServer = (signIn: "none" | "token" | "oauth", signInOffered: "token" | "oauth" | null) =>
    buildServer("s-docs", "docs", "", {
      source: { kind: "url", url: "https://docs.example/mcp", signIn, signInOffered },
    });

  it("is true for a server that offers OAuth or holds it, and false for any other", () => {
    expect(offersBrowserSignIn(urlServer("none", "oauth"))).toBe(true);
    expect(offersBrowserSignIn(urlServer("oauth", "oauth"))).toBe(true);
    expect(offersBrowserSignIn(urlServer("token", "token"))).toBe(false);
    expect(offersBrowserSignIn(buildServer("s-work", "sentry", "c-work"))).toBe(false);
  });
});
