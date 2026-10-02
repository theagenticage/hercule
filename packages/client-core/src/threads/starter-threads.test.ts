import { describe, expect, it } from "vitest";
import { chooseStarterThreads, describeEmptyIntake } from "./starter-threads";

describe("chooseStarterThreads", () => {
  it("offers code starters, named after the project, when it has a repository", () => {
    expect(chooseStarterThreads("webshop", true)).toEqual([
      { title: "Get to know it", message: "Walk me through how webshop is put together" },
      { title: "A first fix", message: "Find a failing or flaky test and fix it" },
      {
        title: "A small chore",
        message: "Bring the README up to date with how webshop runs today",
      },
    ]);
  });

  it("offers knowledge-work starters when the project has no repository", () => {
    expect(chooseStarterThreads("webshop", false).map((starter) => starter.title)).toEqual([
      "Something to present",
      "Something to find out",
      "Something to plan",
    ]);
  });
});

describe("describeEmptyIntake", () => {
  it("says Triage reads GitHub once there is a GitHub Connection, and names no time", () => {
    expect(describeEmptyIntake(true)).toBe(
      "Intake is empty for now. Triage reads GitHub and brings what needs work here.",
    );
  });

  it("says to connect GitHub when there is no GitHub Connection", () => {
    expect(describeEmptyIntake(false)).toBe(
      "Intake is empty for now. Connect GitHub, and Triage brings what needs work here.",
    );
  });
});
