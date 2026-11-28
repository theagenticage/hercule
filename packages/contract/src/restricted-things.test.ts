import { describe, expect, it } from "vitest";
import { describeLostAccess, describeRestrictedThing } from "./restricted-things";

describe("describeRestrictedThing", () => {
  it.each([
    ["Error", "Sentry", "A Sentry error you cannot open"],
    ["Task", "Asana", "An Asana task you cannot open"],
    ["PR", "GitHub", "A GitHub PR you cannot open"],
    ["Project", undefined, "A project you cannot open"],
    ["Issue", undefined, "An issue you cannot open"],
    ["PR", undefined, "A PR you cannot open"],
    ["", undefined, "A record you cannot open"],
    [null, undefined, "A record you cannot open"],
    ["", "Sentry", "A Sentry record you cannot open"],
  ])("words noun %j of plugin %j as %j", (noun, pluginName, words) => {
    expect(describeRestrictedThing(noun, pluginName)).toBe(words);
  });
});

describe("describeLostAccess", () => {
  it("says the facts are the last known ones when a thing lost access", () => {
    expect(describeLostAccess("inaccessible")).toBe("Last known state - you can no longer open it");
    expect(describeLostAccess("deleted")).toBe("Last known state - deleted at the source");
  });

  it("says nothing for a thing that can be read, or when access is not given", () => {
    expect(describeLostAccess("ok")).toBeUndefined();
    expect(describeLostAccess(undefined)).toBeUndefined();
  });
});
