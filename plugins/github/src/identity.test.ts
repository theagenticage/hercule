/** Tests how the feeds tell the user's own accounts and mentions apart from everyone else's. */
import { describe, expect, it } from "vitest";
import { findMention, isUserAccount } from "./identity";
import { TEST_IDENTITY } from "./testing";

describe("isUserAccount", () => {
  it("compares the numeric id when GitHub sends one, so a renamed login still matches", () => {
    expect(isUserAccount(TEST_IDENTITY, { login: "new-name", id: 583231 })).toBe(true);
    expect(isUserAccount(TEST_IDENTITY, { login: "octocat", id: 1 })).toBe(false);
  });

  it("compares the login, ignoring case, when there is no id", () => {
    expect(isUserAccount(TEST_IDENTITY, { login: "OctoCat" })).toBe(true);
    expect(isUserAccount(TEST_IDENTITY, { login: "mona" })).toBe(false);
  });

  it("never takes a deleted account for the user", () => {
    expect(isUserAccount(TEST_IDENTITY, null)).toBe(false);
  });
});

describe("findMention", () => {
  it("finds @login as a whole word, ignoring case, and returns where the @ is", () => {
    expect(findMention("@octocat please look", "octocat")).toBe(0);
    expect(findMention("Thanks, @OctoCat.", "octocat")).toBe(8);
    expect(findMention("cc (@octocat)", "octocat")).toBe(4);
  });

  it("ignores a longer login, an email address, a team and a double @", () => {
    expect(findMention("@octocatz look", "octocat")).toBe(-1);
    expect(findMention("@octocat-bot look", "octocat")).toBe(-1);
    expect(findMention("mail x@octocat.com", "octocat")).toBe(-1);
    expect(findMention("@octocat/reviewers look", "octocat")).toBe(-1);
    expect(findMention("@@octocat", "octocat")).toBe(-1);
  });

  it("reads a login with pattern characters literally", () => {
    expect(findMention("@a.b", "a.b")).toBe(0);
    expect(findMention("@axb", "a.b")).toBe(-1);
  });
});
