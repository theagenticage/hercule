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
const PI = "pi/pi";

describe("the Recent list", () => {
  it("is empty for a controller with nothing stored", () => {
    expect(readRecentModels(HOME)).toEqual([]);
  });

  it("puts the latest pick first and keeps the last 24", () => {
    for (let index = 0; index < 26; index += 1) {
      rememberRecentModel(HOME, {
        providerAccountId: "claude",
        harnessId: CLAUDE_CODE,
        model: `m-${String(index)}`,
      });
    }
    rememberRecentModel(HOME, {
      providerAccountId: "claude",
      harnessId: CLAUDE_CODE,
      model: "m-5",
    });
    const models = readRecentModels(HOME).map((each) => each.model);
    expect(models).toHaveLength(24);
    expect(models.slice(0, 3)).toEqual(["m-5", "m-25", "m-24"]);
  });

  it("keeps one model picked in two harnesses as two entries", () => {
    rememberRecentModel(HOME, { providerAccountId: "zai", harnessId: PI, model: "glm" });
    rememberRecentModel(HOME, { providerAccountId: "zai", harnessId: CLAUDE_CODE, model: "glm" });
    expect(readRecentModels(HOME).map((each) => each.harnessId)).toEqual([CLAUDE_CODE, PI]);
  });

  it("keeps each controller's list apart", () => {
    rememberRecentModel(HOME, {
      providerAccountId: "claude",
      harnessId: CLAUDE_CODE,
      model: "opus",
    });
    expect(readRecentModels(WORK)).toEqual([]);
  });

  it("keeps the list a release before Provider Accounts stored under the key instanceId", () => {
    localStorage.setItem(
      `recent-models:${HOME}`,
      JSON.stringify([{ instanceId: "claude", harnessId: CLAUDE_CODE, model: "a" }]),
    );
    rememberRecentModel(HOME, { providerAccountId: "claude", harnessId: CLAUDE_CODE, model: "b" });
    expect(readRecentModels(HOME)).toEqual([
      { providerAccountId: "claude", harnessId: CLAUDE_CODE, model: "b" },
      { providerAccountId: "claude", harnessId: CLAUDE_CODE, model: "a" },
    ]);
  });

  it("drops an entry stored before entries named a harness", () => {
    localStorage.setItem(
      `recent-models:${HOME}`,
      JSON.stringify([{ providerAccountId: "claude", model: "a" }]),
    );
    expect(readRecentModels(HOME)).toEqual([]);
  });

  it("starts again from an unreadable stored list", () => {
    localStorage.setItem(`recent-models:${HOME}`, "not json");
    rememberRecentModel(HOME, {
      providerAccountId: "claude",
      harnessId: CLAUDE_CODE,
      model: "opus",
    });
    expect(readRecentModels(HOME)).toEqual([
      { providerAccountId: "claude", harnessId: CLAUDE_CODE, model: "opus" },
    ]);
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
