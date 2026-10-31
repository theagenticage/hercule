import { describe, expect, it } from "vitest";
import { readRecentModels, rememberRecentModel } from "./recent-models";

const HOME = "http://127.0.0.1:4937";
const WORK = "http://10.0.0.2:4937";

describe("the Recent list", () => {
  it("is empty for a controller with nothing stored", () => {
    expect(readRecentModels(HOME)).toEqual([]);
  });

  it("puts the latest pick first and keeps three", () => {
    for (const model of ["a", "b", "c", "d"]) {
      rememberRecentModel(HOME, { providerAccountId: "claude", model });
    }
    rememberRecentModel(HOME, { providerAccountId: "claude", model: "c" });
    expect(readRecentModels(HOME).map((each) => each.model)).toEqual(["c", "d", "b"]);
  });

  it("keeps each controller's list apart", () => {
    rememberRecentModel(HOME, { providerAccountId: "claude", model: "opus" });
    expect(readRecentModels(WORK)).toEqual([]);
  });

  it("starts again from an unreadable stored list", () => {
    localStorage.setItem(`recent-models:${HOME}`, "not json");
    rememberRecentModel(HOME, { providerAccountId: "claude", model: "opus" });
    expect(readRecentModels(HOME)).toEqual([{ providerAccountId: "claude", model: "opus" }]);
  });
});
