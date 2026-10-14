/**
 * Tests what Discussions tell a session: nothing without `discussion.read`,
 * and only commands the CLI has.
 */
import { describe, expect, it } from "vitest";
import { ALL_GRANTS, CLI } from "@hercule/contract";
import { describeDiscussionsToSession } from "./session-description";

describe("describeDiscussionsToSession", () => {
  it("tells a session without discussion.read nothing", () => {
    expect(
      describeDiscussionsToSession(new Set(["discussion.write", "wiki.read"])),
    ).toBeUndefined();
  });

  it("names only commands the CLI has", () => {
    const commands = new Set<string>(
      Object.values(CLI).flatMap((row) => ("command" in row ? [row.command] : [])),
    );
    const text = describeDiscussionsToSession(new Set(ALL_GRANTS))!.text;
    const named = [...text.matchAll(/`hercule (\S+) (\S+)/g)].map(
      (found) => `${found[1]} ${found[2]}`,
    );

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((command) => !commands.has(command))).toEqual([]);
  });
});
