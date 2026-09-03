import { describe, expect, it } from "vitest";
import { route } from "./index";

describe("route", () => {
  it("sends serve to the controller", () => {
    expect(route(["serve", "--home", "/tmp/h"])).toEqual({
      role: "controller",
      args: ["--home", "/tmp/h"],
    });
  });

  it("sends runner to the runner", () => {
    expect(route(["runner", "--local"])).toEqual({ role: "runner", args: ["--local"] });
  });

  it("sends everything else to the CLI", () => {
    expect(route(["task", "list"])).toEqual({ role: "cli", args: ["task", "list"] });
    expect(route([])).toEqual({ role: "cli", args: [] });
  });
});
