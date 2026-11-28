/** Tests the pane's "where it stands" and the quiet line under it. */
import { describe, expect, it } from "vitest";
import { buildSummary } from "./cards.testing";
import { describeSummaryStanding } from "./summary-standing";

const NOW = new Date("2026-11-07T12:12:00.000Z");
const ON = { unavailableReason: null };
const OFF = { unavailableReason: "Text generation is off." };
const WRITTEN_12_MIN_AGO = "2026-11-07T12:00:00.000Z";

describe("where a Task stands", () => {
  it.each([
    [
      "a fresh summary",
      buildSummary("Three designs", {
        standing: "Dana prefers B.",
        generatedAt: WRITTEN_12_MIN_AGO,
      }),
      ON,
      { standing: "Dana prefers B.", note: "Written 12 minutes ago", linksToTextGeneration: false },
    ],
    [
      "a stale summary",
      buildSummary("Three designs", {
        standing: "Dana prefers B.",
        generatedAt: WRITTEN_12_MIN_AGO,
        stale: true,
      }),
      ON,
      {
        standing: "Dana prefers B.",
        note: "Written 12 minutes ago · newer work since",
        linksToTextGeneration: false,
      },
    ],
    [
      "a summary written less than a minute ago",
      buildSummary("x", { standing: "s", generatedAt: "2026-11-07T12:11:30.000Z" }),
      ON,
      { standing: "s", note: "Written just now", linksToTextGeneration: false },
    ],
    [
      "a summary with no standing text",
      buildSummary("x", { standing: " ", generatedAt: WRITTEN_12_MIN_AGO }),
      ON,
      { standing: null, note: "Written 12 minutes ago", linksToTextGeneration: false },
    ],
    [
      "a fresh summary while Text Generation is off",
      buildSummary("x", { standing: "s", generatedAt: WRITTEN_12_MIN_AGO }),
      OFF,
      { standing: "s", note: "Written 12 minutes ago", linksToTextGeneration: false },
    ],
    [
      "a stale summary while Text Generation is off",
      buildSummary("x", { standing: "s", generatedAt: WRITTEN_12_MIN_AGO, stale: true }),
      OFF,
      {
        standing: "s",
        note: "Written 12 minutes ago · newer work since · summaries are off",
        linksToTextGeneration: true,
      },
    ],
    [
      "no summary yet",
      undefined,
      ON,
      { standing: null, note: "Writing a summary", linksToTextGeneration: false },
    ],
    [
      "no summary while Text Generation is off or unavailable",
      undefined,
      OFF,
      { standing: null, note: "Summaries are off", linksToTextGeneration: true },
    ],
  ])("describes %s", (_, summary, textGeneration, expected) => {
    expect(describeSummaryStanding(summary, NOW, textGeneration)).toEqual(expected);
  });
});
