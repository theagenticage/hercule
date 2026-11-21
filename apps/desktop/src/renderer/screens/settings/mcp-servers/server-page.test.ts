import { describe, expect, it } from "vitest";
import { describeOfferAddress } from "./server-page";

describe("describeOfferAddress", () => {
  it.each([
    ["https://mcp.sentry.dev", "mcp.sentry.dev"],
    ["https://mcp.example.com:8443", "mcp.example.com:8443"],
    ["http://localhost:3000", "localhost:3000"],
  ])("writes the origin %s as %s", (origin, address) => {
    expect(describeOfferAddress(origin)).toBe(address);
  });
});
