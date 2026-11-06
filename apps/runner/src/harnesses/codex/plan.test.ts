import { describe, expect, it } from "vitest";
import { describePlanType, isUnnamedPlanType } from "./plan";

describe("describePlanType", () => {
  it.each([
    ["free", "Free"],
    ["pro", "Pro 200"],
    ["prolite", "Pro 100"],
    ["promax", "Pro 500"],
    ["team", "Business"],
    ["business", "Enterprise"],
    ["self_serve_business_prolite", "Business Premium"],
    ["enterprise_cbp_automation", "Enterprise (Automation)"],
    ["sci_plus", "Academic Researchers Plus"],
  ])("names %s as %s, the way Codex's /status does", (id, label) => {
    expect(describePlanType(id)).toBe(label);
  });

  it("gives no name to `unknown`, nor to an id it has never seen", () => {
    expect(describePlanType("unknown")).toBeUndefined();
    expect(describePlanType("future_plan")).toBeUndefined();
    expect(describePlanType("")).toBeUndefined();
  });

  it.each(["toString", "__proto__", "constructor", "hasOwnProperty"])(
    "gives no name to %s, which only exists on every object",
    (id) => {
      expect(describePlanType(id)).toBeUndefined();
    },
  );
});

describe("isUnnamedPlanType", () => {
  it("is true only for an id Codex reports as known that has no name", () => {
    expect(isUnnamedPlanType("future_plan")).toBe(true);
    expect(isUnnamedPlanType("unknown")).toBe(false);
    expect(isUnnamedPlanType("plus")).toBe(false);
  });
});
