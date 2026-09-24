import { describe, expect, it } from "vitest";
import { buildPerimeterWarning } from "./perimeter";

describe("buildPerimeterWarning", () => {
  it("says nothing about loopback", () => {
    expect(buildPerimeterWarning("127.0.0.1", 4937)).toBeUndefined();
    expect(buildPerimeterWarning("127.1.2.3", 4937)).toBeUndefined();
    expect(buildPerimeterWarning("localhost", 4937)).toBeUndefined();
    expect(buildPerimeterWarning("::1", 4937)).toBeUndefined();
  });

  it("says nothing about a tailnet address", () => {
    expect(buildPerimeterWarning("100.64.0.1", 4937)).toBeUndefined();
    expect(buildPerimeterWarning("100.127.255.254", 4937)).toBeUndefined();
    expect(buildPerimeterWarning("fd7a:115c:a1e0::1", 4937)).toBeUndefined();
  });

  it("warns about a LAN address, and names it", () => {
    expect(buildPerimeterWarning("192.168.1.10", 4937)).toContain("192.168.1.10:4937");
  });

  it("warns about an address just outside the tailnet range", () => {
    expect(buildPerimeterWarning("100.63.0.1", 4937)).toBeDefined();
    expect(buildPerimeterWarning("100.128.0.1", 4937)).toBeDefined();
    expect(buildPerimeterWarning("fd7a:115c:a1e1::1", 4937)).toBeDefined();
  });

  it("warns about a wildcard bind in terms of what it means", () => {
    expect(buildPerimeterWarning("0.0.0.0", 4937)).toContain("every network interface");
    expect(buildPerimeterWarning("::", 4937)).toContain("every network interface");
  });
});
