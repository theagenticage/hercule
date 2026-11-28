/**
 * Tests the comparison of a pasted address with the redirect address of the
 * attempt, without a controller. How the browser's return is read has its own
 * tests in the contract.
 */
import { describe, expect, it } from "vitest";
import { isRedirectAddress } from "./oauth-sign-in";

describe("isRedirectAddress", () => {
  const redirectUri = "http://127.0.0.1:50123/callback";

  it("accepts the redirect address with any query", () => {
    expect(isRedirectAddress(new URL(`${redirectUri}?code=a&state=b`), redirectUri)).toBe(true);
  });

  it("treats the default port as no port", () => {
    expect(
      isRedirectAddress(
        new URL("http://127.0.0.1/callback?code=a"),
        "http://127.0.0.1:80/callback",
      ),
    ).toBe(true);
  });

  it.each([
    ["another port", "http://127.0.0.1:50124/callback?code=a"],
    ["another host", "http://localhost:50123/callback?code=a"],
    ["another path", "http://127.0.0.1:50123/other?code=a"],
    ["another scheme", "https://127.0.0.1:50123/callback?code=a"],
    ["a user name", "http://user@127.0.0.1:50123/callback?code=a"],
  ])("refuses %s", (_name, address) => {
    expect(isRedirectAddress(new URL(address), redirectUri)).toBe(false);
  });
});
