import { describe, expect, it } from "vitest";
import { canonicalizeAnnounceAddress } from "./exchange";

describe("canonicalizeAnnounceAddress", () => {
  it("returns the origin of an http or https URL", () => {
    expect(canonicalizeAnnounceAddress("http://hercule.local:9/path")).toBe(
      "http://hercule.local:9",
    );
    expect(canonicalizeAnnounceAddress("https://hercule.example")).toBe("https://hercule.example");
  });

  it("refuses a non-http URL, userinfo, or a value that is not a URL", () => {
    expect(canonicalizeAnnounceAddress("ftp://hercule.local")).toBeUndefined();
    expect(canonicalizeAnnounceAddress("http://user:pass@hercule.local")).toBeUndefined();
    expect(canonicalizeAnnounceAddress("not a url")).toBeUndefined();
  });
});
