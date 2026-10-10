import type { Block } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { formatBlocksAsText, UNKNOWN_BLOCK_TEXT } from "./signal-blocks";

const MARTA = { name: "Marta", handle: "marta" };

describe("formatBlocksAsText", () => {
  it("returns an empty string for a signal with no blocks", () => {
    expect(formatBlocksAsText([])).toBe("");
  });

  it("returns a text block's markdown unchanged", () => {
    expect(formatBlocksAsText([{ type: "text", markdown: "**Release 4.2**\n\n- notes" }])).toBe(
      "**Release 4.2**\n\n- notes",
    );
  });

  it("puts an empty line between two blocks, in the producer's order", () => {
    expect(
      formatBlocksAsText([
        { type: "text", markdown: "first" },
        { type: "text", markdown: "second" },
      ]),
    ).toBe("first\n\nsecond");
  });

  it("prints each message with its author and time, and says how many earlier messages were left out", () => {
    const text = formatBlocksAsText([
      {
        type: "messages",
        omitted: 3,
        messages: [
          { author: MARTA, at: "2026-10-10T09:12:00.000Z", text: "Can you review?" },
          { author: { name: "Ada" }, at: "2026-10-10T09:30:00.000Z", text: "On it.\nSoon." },
        ],
      },
    ]);

    expect(text.split("\n")).toEqual([
      "3 earlier messages left out",
      "Marta (marta) · 2026-10-10T09:12:00.000Z",
      "Can you review?",
      "",
      "Ada · 2026-10-10T09:30:00.000Z",
      "On it.",
      "Soon.",
    ]);
  });

  it("prints a review comment's place, a mention, a cut text and the message's link", () => {
    const text = formatBlocksAsText([
      {
        type: "messages",
        omitted: 0,
        messages: [
          {
            author: MARTA,
            at: "2026-10-10T09:12:00.000Z",
            text: "This loop never ends",
            truncated: true,
            mentionsYou: true,
            location: { path: "src/cart.ts", line: 42 },
            url: "https://github.com/acme/webshop/pull/1296#discussion_r1",
          },
          {
            author: MARTA,
            at: "2026-10-10T09:13:00.000Z",
            text: "And this file",
            location: { path: "src/order.ts" },
          },
        ],
      },
    ]);

    expect(text.split("\n")).toEqual([
      "Marta (marta) · 2026-10-10T09:12:00.000Z · src/cart.ts:42 · mentions you",
      "This loop never ends",
      "(the message is cut short here)",
      "https://github.com/acme/webshop/pull/1296#discussion_r1",
      "",
      "Marta (marta) · 2026-10-10T09:13:00.000Z · src/order.ts",
      "And this file",
    ]);
  });

  it("prints a mail's recipients and attachments, and leaves out an empty cc", () => {
    const mail = (cc: ReadonlyArray<{ name: string }>): Block => ({
      type: "messages",
      omitted: 0,
      messages: [
        {
          author: { name: "Marta", handle: "marta@example.com" },
          at: "2026-10-10T09:12:00.000Z",
          text: "Please sign the lease.",
          recipients: { to: [{ name: "You" }], cc },
          attachments: [{ name: "lease.pdf" }, { name: "terms.pdf" }],
        },
      ],
    });

    expect(formatBlocksAsText([mail([{ name: "Ada" }])]).split("\n")).toEqual([
      "Marta (marta@example.com) · 2026-10-10T09:12:00.000Z",
      "to: You",
      "cc: Ada",
      "Please sign the lease.",
      "attachments: lease.pdf, terms.pdf",
    ]);
    expect(formatBlocksAsText([mail([])])).not.toContain("cc:");
  });

  it("prints a change's branches and totals, with its commits and checks when it has them", () => {
    expect(
      formatBlocksAsText([
        { type: "change", from: "fix/cart", to: "main", files: 1, additions: 12, deletions: 3 },
      ]).split("\n"),
    ).toEqual(["fix/cart -> main", "1 file, +12 -3"]);

    expect(
      formatBlocksAsText([
        {
          type: "change",
          from: "fix/cart",
          to: "main",
          files: 4,
          additions: 120,
          deletions: 30,
          commits: 3,
          checks: { passed: 12, failed: 1, pending: 2 },
        },
      ]).split("\n"),
    ).toEqual([
      "fix/cart -> main",
      "4 files, +120 -30, 3 commits",
      "checks: 12 passed, 1 failed, 2 pending",
    ]);
  });

  it("prints each failed or pending check with its link and indented log, then the passed and left-out counts", () => {
    const text = formatBlocksAsText([
      {
        type: "checks",
        rows: [
          {
            name: "e2e",
            state: "failed",
            url: "https://ci.example.com/run/7",
            log: "expected 2\nreceived 3",
          },
          { name: "lint", state: "pending" },
        ],
        passed: 12,
        omitted: 2,
      },
    ]);

    expect(text.split("\n")).toEqual([
      "failed  e2e  https://ci.example.com/run/7",
      "    expected 2",
      "    received 3",
      "pending  lint",
      "12 passed, 2 more failed or pending left out",
    ]);
  });

  it("prints only the passed count when every check passed", () => {
    expect(formatBlocksAsText([{ type: "checks", rows: [], passed: 9, omitted: 0 }])).toBe(
      "9 passed",
    );
  });

  it("prints one line for a block of a type it does not know, and keeps the blocks around it", () => {
    expect(
      formatBlocksAsText([
        { type: "text", markdown: "before" },
        { type: "when" },
        { type: "text", markdown: "after" },
      ]),
    ).toBe(`before\n\n${UNKNOWN_BLOCK_TEXT}\n\nafter`);
    expect(UNKNOWN_BLOCK_TEXT).toBe("This part can't be shown here.");
  });
});
