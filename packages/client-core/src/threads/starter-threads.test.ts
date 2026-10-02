import { describe, expect, it } from "vitest";
import { chooseStarterThreads } from "./starter-threads";

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
      "Make a presentation",
      "Research a question",
      "Write a plan",
    ]);
  });
});
