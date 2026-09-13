import { describe, expect, it } from "vitest";
import { redirectUriFor } from "./connections";

describe("redirectUriFor", () => {
  it("is the callback path on the origin the browser is at", () => {
    expect(redirectUriFor("https://n.tail.ts.net")).toBe("https://n.tail.ts.net/oauth/callback");
  });

  it("does not double the slash when the origin carries a trailing one", () => {
    expect(redirectUriFor("https://n.tail.ts.net/")).toBe("https://n.tail.ts.net/oauth/callback");
  });
});
