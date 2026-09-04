import { describe, expect, it } from "vitest";
import { perimeterWarning } from "./perimeter";

describe("perimeterWarning", () => {
  it("says nothing about loopback", () => {
    expect(perimeterWarning("127.0.0.1", 4937)).toBeUndefined();
    expect(perimeterWarning("127.1.2.3", 4937)).toBeUndefined();
    expect(perimeterWarning("localhost", 4937)).toBeUndefined();
    expect(perimeterWarning("::1", 4937)).toBeUndefined();
  });

  it("says nothing about a tailnet address", () => {
    expect(perimeterWarning("100.64.0.1", 4937)).toBeUndefined();
    expect(perimeterWarning("100.127.255.254", 4937)).toBeUndefined();
    expect(perimeterWarning("fd7a:115c:a1e0::1", 4937)).toBeUndefined();
  });

  it("warns about a LAN address, and names it", () => {
    expect(perimeterWarning("192.168.1.10", 4937)).toContain("192.168.1.10:4937");
  });

  it("warns about an address just outside the tailnet range", () => {
    expect(perimeterWarning("100.63.0.1", 4937)).toBeDefined();
    expect(perimeterWarning("100.128.0.1", 4937)).toBeDefined();
    expect(perimeterWarning("fd7a:115c:a1e1::1", 4937)).toBeDefined();
  });

  it("warns about a wildcard bind in terms of what it means", () => {
    expect(perimeterWarning("0.0.0.0", 4937)).toContain("every network interface");
    expect(perimeterWarning("::", 4937)).toContain("every network interface");
  });
});
