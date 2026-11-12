/** Tests how the pane draws each kind of block, the three new ones included, and a block it does not know. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Block } from "@hercule/contract";
import { InboxBlocks } from "./inbox-blocks";

const NOW = new Date("2026-11-12T12:00:00.000Z");

const draw = (blocks: ReadonlyArray<Block>) =>
  render(<InboxBlocks blocks={blocks} timezone="UTC" now={NOW} />);

describe("InboxBlocks", () => {
  it("draws nothing for no blocks", () => {
    expect(draw([]).container.textContent).toBe("");
  });

  it("draws one quiet line for a block of a type it does not know", () => {
    draw([{ type: "gauge" }]);
    expect(screen.getByText("This part can't be shown here.")).toBeTruthy();
  });

  it("draws fields as labels and values, under the block's title", () => {
    draw([
      {
        type: "fields",
        title: "Details",
        rows: [
          { label: "Author", value: "Mei" },
          { label: "Milestone", value: "v2" },
        ],
      },
    ]);
    expect(screen.getByRole("heading", { name: "Details" })).toBeTruthy();
    expect(screen.getByText("Author").tagName).toBe("DT");
    expect(screen.getByText("Mei").tagName).toBe("DD");
  });

  it("draws a trend as a line labelled with its caption and last value, and how long ago it began under it", () => {
    const { container } = draw([
      {
        type: "trend",
        caption: "Errors a day",
        points: [
          { at: "2026-10-29T10:00:00.000Z", value: 100 },
          { at: "2026-11-05T10:00:00.000Z", value: 400 },
          { at: "2026-11-12T10:00:00.000Z", value: 1284 },
        ],
      },
    ]);
    const line = screen.getByRole("img", { name: "Errors a day, 1,284 today" });
    expect(line.querySelectorAll("polyline")).toHaveLength(1);
    expect(container.querySelector(".bk-axis")?.textContent).toBe("14 days ago1,284 today");
  });

  it("draws code as plain text, and says when the source cut it", () => {
    const { container } = draw([
      { type: "code", title: "Log", text: "line one\n  line two", truncated: true },
    ]);
    expect(container.querySelector("pre")?.textContent).toBe("line one\n  line two");
    expect(screen.getByText("Cut short.")).toBeTruthy();
  });

  it("draws a message with its author's initial, and keeps a note for the ones left out after the first", () => {
    const { container } = draw([
      {
        type: "messages",
        omitted: 2,
        messages: [
          {
            author: { name: "Mei" },
            at: "2026-11-12T08:00:00.000Z",
            text: "Can you look?",
            mentionsYou: true,
          },
          { author: { name: "Tom" }, at: "2026-11-12T09:00:00.000Z", text: "Done." },
        ],
      },
    ]);
    expect(container.querySelector(".bk-av")?.textContent).toBe("M");
    const items = [...container.querySelectorAll("li")];
    expect(items.map((item) => item.className)).toEqual(["is-you", "bk-omitted", ""]);
    expect(items[1]?.textContent).toBe("and 2 more");
  });

  it("draws a change's branches and size, and the failed checks with their log", () => {
    const { container } = draw([
      { type: "change", from: "fix/retry", to: "main", files: 3, additions: 40, deletions: 2 },
      {
        type: "checks",
        passed: 11,
        omitted: 0,
        rows: [{ name: "build", state: "failed", log: "error: x" }],
      },
    ]);
    expect(container.querySelector(".bk-branch")?.textContent).toBe("fix/retrymain");
    expect(container.querySelector(".bk-diff")?.textContent).toBe("3 files+40−2");
    expect(container.querySelector(".bk-check pre")?.textContent).toBe("error: x");
    expect(screen.getByText("11 passed")).toBeTruthy();
  });
});
