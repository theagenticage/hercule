/**
 * Tests the terminal screen model with the byte sequences a text UI really
 * draws: cursor moves instead of spaces, repaints of single cells, and
 * hyperlinks.
 */
import { describe, expect, it } from "vitest";
import { TerminalScreen } from "./terminal-screen";

const screenOf = (columns: number, ...chunks: ReadonlyArray<string>): ReadonlyArray<string> => {
  const screen = new TerminalScreen(columns);
  for (const chunk of chunks) screen.feed(chunk);
  return screen.readLines();
};

describe("the terminal screen", () => {
  it("reads a cursor move to a column as the gap it leaves", () => {
    expect(screenOf(80, "Paste\u001b[7Gcode\u001b[12Ghere\r\r\n")).toEqual(["Paste code here", ""]);
  });

  it("reads a repaint of single cells as the text a person sees", () => {
    // The UI painted "Invalid xode" and later repainted only the cell that
    // changed, so the bytes alone never hold the word "code".
    expect(screenOf(80, "Invalid xode\r", "\u001b[9Gc")).toEqual(["Invalid code"]);
    // A repaint that skips the unchanged cells in between leaves them as they were.
    expect(screenOf(80, "full code was copied\r", "\u001b[1GF", "\u001b[15GC")).toEqual([
      "Full code was Copied",
    ]);
  });

  it("applies erase and the cursor moves of an in-place repaint", () => {
    const lines = screenOf(
      80,
      "spinner ✢\r\n",
      "\u001b[1A\r\u001b[2KDone\r\n",
      "\u001b[2K\u001b[1A\u001b[2Kagain\r\n",
    );
    expect(lines).toEqual(["again", ""]);
  });

  it("erases to the end of the line and to the end of the screen", () => {
    expect(screenOf(80, "abcdef\r\u001b[3C\u001b[K")).toEqual(["abc"]);
    expect(screenOf(80, "one\r\ntwo\r\nthree\u001b[2A\r\u001b[J")).toEqual(["", "", ""]);
  });

  it("ignores colours, modes, titles and hyperlink targets", () => {
    const url = "https://claude.com/oauth?code=true&state=abc";
    expect(
      screenOf(
        80,
        "\u001b[?25l\u001b[?2004h\u001b[33mhello\u001b[39m\u001b]0;title\u0007\r\n",
        `\u001b]8;id=1;${url}\u0007${url}\u001b]8;;\u0007`,
      ),
    ).toEqual(["hello", url]);
  });

  it("keeps an escape sequence that is cut between two chunks", () => {
    expect(screenOf(80, "a\u001b[", "5Gb", "\u001b]8;;http", "://x\u0007c")).toEqual(["a   bc"]);
  });

  it("joins a line that wrapped at the last column to the line it wrapped from", () => {
    expect(screenOf(10, "sk-ant-oat01-ABCDEFGH\r\nnext")).toEqual([
      "sk-ant-oat01-ABCDEFGH",
      "next",
    ]);
  });

  it("counts a character outside the basic plane as one cell", () => {
    expect(screenOf(5, "ab😀cd\r\nx")).toEqual(["ab😀cd", "x"]);
  });

  it("never moves above its first line or drops text it has not scrolled out", () => {
    expect(screenOf(80, "first\u001b[9A\rF")).toEqual(["First"]);
  });

  it("leaves out the line the cursor is still on when asked for the finished lines", () => {
    const screen = new TerminalScreen(80);
    screen.feed("done\r\nhttps://example.com/aut");
    expect(screen.readFinishedLines()).toEqual(["done"]);
    screen.feed("horize\r\n");
    expect(screen.readFinishedLines()).toEqual(["done", "https://example.com/authorize"]);
  });

  it("counts a wrapped line as unfinished until the cursor is below all of its rows", () => {
    const screen = new TerminalScreen(10);
    screen.feed("0123456789ABCDE");
    expect(screen.readFinishedLines()).toEqual([]);
    screen.feed("\r\n");
    expect(screen.readFinishedLines()).toEqual(["0123456789ABCDE"]);
  });

  it("cuts a huge cursor move to the screen instead of looping or allocating for it", () => {
    const started = Date.now();
    // Each of these asks for about a billion rows or cells before the cut.
    expect(screenOf(80, "a\u001b[999999999Bb\u001b[999999999Ac").length).toBeLessThanOrEqual(500);
    expect(screenOf(80, "\u001b[999999999Gx")).toEqual(["x"]);
    expect(screenOf(80, "\u001b[999999999Cx\u001b[999999999Dy")).toEqual(["y"]);
    const lines = screenOf(80, "\u001b[999999999Ex\u001b[999999999Fy");
    expect(lines[0]).toBe("y");
    expect(lines.at(-1)).toBe("x");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
