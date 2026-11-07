/** Tests the words about an External Entity that Work and the Inbox share. */
import { describe, expect, it } from "vitest";
import { formatTargetDate, readEntityPluginId } from "./entity-words";

describe("readEntityPluginId", () => {
  it.each([
    ["acme/ticket", "acme"],
    ["quayside/purchase-order", "quayside"],
    ["unqualified", "unqualified"],
  ])("reads %s as plugin %s", (kind, pluginId) => {
    expect(readEntityPluginId(kind)).toBe(pluginId);
  });
});

describe("formatTargetDate", () => {
  it.each([
    ["2026-11-14T00:00:00.000Z", "14 Nov"],
    ["2026-03-05T23:59:00.000Z", "5 Mar"],
  ])("writes %s as %s, whatever the zone of the machine", (at, words) => {
    expect(formatTargetDate(at)).toBe(words);
  });
});
