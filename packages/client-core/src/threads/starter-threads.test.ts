import { describe, expect, it } from "vitest";
import { chooseStarterThreads, describeNoPlannedWork } from "./starter-threads";

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

describe("describeNoPlannedWork", () => {
  it("points at the Inbox once there is a GitHub Connection", () => {
    expect(describeNoPlannedWork(true)).toBe(
      "Nothing planned yet. What needs work on GitHub shows on the Inbox.",
    );
  });

  it("says to connect GitHub when there is no GitHub Connection", () => {
    expect(describeNoPlannedWork(false)).toBe(
      "Nothing planned yet. Connect GitHub, and what needs work there shows on the Inbox.",
    );
  });
});
