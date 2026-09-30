/**
 * Tests `pickProjectHue`, the rule every app uses to give a project its
 * identity hue from its position in the project list, with the web app's two
 * tones and the desktop app's three Bureau tints. `pickProjectTone`'s own
 * tests sit with the project picker's, in `projects.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { pickProjectHue, pickProjectTone } from "./tone";
import { buildProject } from "./workspaces.testing";

const PROJECTS = ["webshop", "payments-api", "ops", "billing", "search"].map((name) =>
  buildProject(`p-${name}`, name),
);

const BUREAU_TINTS = ["webshop", "payments", "ops"] as const;

describe("pickProjectHue", () => {
  it("counts the project's position round a palette of three", () => {
    expect(PROJECTS.map((each) => pickProjectHue(each.id, PROJECTS, BUREAU_TINTS))).toEqual([
      "webshop",
      "payments",
      "ops",
      "webshop",
      "payments",
    ]);
  });

  it("gives the web app's two tones alternately, as pickProjectTone does", () => {
    const tones = PROJECTS.map((each) => pickProjectTone(each.id, PROJECTS));

    expect(tones).toEqual(["hercule", "ops", "hercule", "ops", "hercule"]);
    expect(PROJECTS.map((each) => pickProjectHue(each.id, PROJECTS, ["hercule", "ops"]))).toEqual(
      tones,
    );
  });

  it("follows the project list, so two projects shown next to each other in another order can share a hue", () => {
    // The sidebar orders projects by their latest thread, not by the project
    // list, so "billing" can sit right above "webshop". Each keeps the hue its
    // position in the project list gives it, and the two match.
    const sidebarOrder = [PROJECTS[3]!, PROJECTS[0]!];

    expect(sidebarOrder.map((each) => pickProjectHue(each.id, PROJECTS, BUREAU_TINTS))).toEqual([
      "webshop",
      "webshop",
    ]);
  });

  it("returns the first entry for a project that is not in the list", () => {
    expect(pickProjectHue("p-gone", PROJECTS, BUREAU_TINTS)).toBe("webshop");
  });
});
