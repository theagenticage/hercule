import { describe, expect, it } from "vitest";
import { buildServer } from "./testing";
import { describeOffOutcome, describeReadyTools } from "./url-server-flows";
import { describeReplaceDialog, describeReplaceTitle } from "./replace";
import {
  describePasteRefusal,
  describeSignInRefusal,
  describeSignInWaiting,
  offersBrowserSignIn,
} from "./sign-in-words";

describe("describeSignInWaiting", () => {
  it("names who asks for the approval, and says the desktop app finishes by itself", () => {
    const words = describeSignInWaiting({
      approvalHost: "auth.docs.example:8443",
      returnBy: "listener",
      openedByApp: true,
    });

    expect(words.heading).toBe("Finish in your browser");
    expect(words.approval).toBe("You will approve on auth.docs.example:8443.");
    expect(words.instruction).toContain("finishes by itself");
    expect(words.openLabel).toBe("Open again");
    expect(words.pasteQuestion).toBe("Approved, and the browser did not come back here?");
    expect(words.pasteToggle).toBe("Paste the browser's address…");
  });

  it("asks the web app's user to paste the address the browser ends on, with no question and no toggle", () => {
    const words = describeSignInWaiting({
      approvalHost: "auth.docs.example",
      returnBy: "paste",
      openedByApp: false,
    });

    expect(words.instruction).toContain("paste it here");
    expect(words.openLabel).toBe("Open the sign-in page");
    expect(words.pasteQuestion).toBeNull();
    expect(words.pasteToggle).toBeNull();
  });
});

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

describe("the words both apps share", () => {
  it("counts tools after ready", () => {
    expect(describeReadyTools(1)).toBe("ready · 1 tool");
    expect(describeReadyTools(4)).toBe("ready · 4 tools");
  });

  it("says what a switched-off server keeps", () => {
    expect(describeOffOutcome(null)).toBe("This server is switched off, so it is not checked.");
    expect(describeOffOutcome("token")).toBe(
      "The token is saved. This server is switched off, so checking runs when it is switched on.",
    );
    expect(describeOffOutcome("sign-in")).toContain("The sign-in is saved.");
  });

  it("titles the Replace dialog by its server, or asks which one", () => {
    const urlServer = buildServer("s-docs", "docs", "", {
      source: { kind: "url", url: "https://docs.example/mcp", signIn: "none", signInOffered: null },
    });
    const dialog = describeReplaceDialog({
      server: urlServer,
      connection: { label: "work" },
      typeName: "Docs",
    });

    expect(describeReplaceTitle(dialog)).toBe("Replace the docs server you added?");
    expect(describeReplaceTitle(null)).toBe("Which server do you replace?");
  });
});
