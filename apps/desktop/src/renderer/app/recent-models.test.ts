import { describe, expect, it } from "vitest";
import {
  readLastOpenProfileId,
  readRecentModels,
  rememberOpenProfile,
  rememberRecentModel,
} from "./recent-models";

const HOME = "http://127.0.0.1:4937";
const WORK = "http://10.0.0.2:4937";
const CLAUDE_CODE = "claude-code/claude-code";

describe("the Recent list", () => {
  it("is empty for a controller with nothing stored", () => {
    expect(readRecentModels(HOME)).toEqual([]);
  });

  it("returns the same list while nothing was stored, and a new one after a pick or an outside change", () => {
    rememberRecentModel(HOME, { providerAccountId: "claude", harnessId: CLAUDE_CODE, model: "a" });
    const first = readRecentModels(HOME);
    expect(readRecentModels(HOME)).toBe(first);

    rememberRecentModel(HOME, { providerAccountId: "claude", harnessId: CLAUDE_CODE, model: "b" });
    const second = readRecentModels(HOME);
    expect(second).not.toBe(first);
    expect(second.map((each) => each.model)).toEqual(["b", "a"]);

    localStorage.setItem(`recent-models:${HOME}`, "[]");
    expect(readRecentModels(HOME)).toEqual([]);
  });

  it("keeps each controller's list apart", () => {
    rememberRecentModel(HOME, {
      providerAccountId: "claude",
      harnessId: CLAUDE_CODE,
      model: "opus",
    });
    expect(readRecentModels(WORK)).toEqual([]);
  });
});

describe("the profile opened last", () => {
  it("is null for a controller with nothing stored", () => {
    expect(readLastOpenProfileId(HOME)).toBeNull();
  });

  it("is the profile opened last, kept apart for each controller", () => {
    rememberOpenProfile(HOME, "profile-work");
    rememberOpenProfile(HOME, "profile-home");
    expect(readLastOpenProfileId(HOME)).toBe("profile-home");
    expect(readLastOpenProfileId(WORK)).toBeNull();
  });
});
