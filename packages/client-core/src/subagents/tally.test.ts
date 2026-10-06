/**
 * Tests `describeSubagentTally`, the tally pill's mark and count, and
 * `summarizeSubagents`, the Subagents surface's footer phrase.
 */
import { describe, expect, it } from "vitest";
import { describeSubagentTally, summarizeSubagents } from "./tally";
import { buildRequest, buildSubagent } from "./subagents.testing";

const RUNNING = [buildSubagent({ id: "a" }), buildSubagent({ id: "b" })];
const SETTLED = [
  buildSubagent({ id: "c", status: "completed" }),
  buildSubagent({ id: "d", status: "failed" }),
  buildSubagent({ id: "e", status: "stopped" }),
  buildSubagent({ id: "f", status: "completed" }),
];

describe("describeSubagentTally", () => {
  it("counts the running subagents out of all of them, with the working mark", () => {
    expect(describeSubagentTally([...RUNNING, ...SETTLED], [buildRequest("r-1")])).toEqual({
      mark: "working",
      count: "2 of 6 running",
    });
  });

  it("shows the waiting mark while a subagent's Request is open", () => {
    expect(describeSubagentTally(RUNNING, [buildRequest("r-1", "b")]).mark).toBe("waiting");
  });

  it("shows only how many there are, with the done mark, once none runs", () => {
    expect(describeSubagentTally(SETTLED, [])).toEqual({ mark: "done", count: "4" });
  });
});

describe("summarizeSubagents", () => {
  it("counts the running and the settled subagents", () => {
    expect(summarizeSubagents([...RUNNING, ...SETTLED])).toBe("2 running · 4 settled");
  });

  it("leaves a count of zero out", () => {
    expect(summarizeSubagents(RUNNING)).toBe("2 running");
    expect(summarizeSubagents(SETTLED)).toBe("4 settled");
    expect(summarizeSubagents([])).toBe("");
  });
});
