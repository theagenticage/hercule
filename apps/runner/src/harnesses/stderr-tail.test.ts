/**
 * Tests for the last lines kept from a harness's stderr, on an in-memory pipe
 * the test writes to and closes.
 */
import { describe, expect, it } from "vitest";
import { keepStderrTail } from "./stderr-tail";
import { createLines, waitUntil } from "./testing";

describe("the last lines of stderr", () => {
  it("keeps only the last five lines, oldest first, and skips blank ones", async () => {
    const pipe = createLines();
    const tail = keepStderrTail(pipe.iterable);

    for (const line of ["", "1", "2", "3", "4", "5", "6", "7", "   "]) pipe.push(line);
    pipe.end();
    await tail.ended;

    expect(tail.lastLines()).toEqual(["3", "4", "5", "6", "7"]);
  });

  it("shows lines while the pipe is open, keeps a line from elsewhere in order, and ends only with the pipe", async () => {
    const pipe = createLines();
    const tail = keepStderrTail(pipe.iterable);
    let ended = false;
    void tail.ended.then(() => void (ended = true));

    try {
      pipe.push("a");
      pipe.push("b");
      await waitUntil("kept two lines", () => tail.lastLines().length === 2);
      tail.appendLine("warning");
      pipe.push("c");
      pipe.push("d");
      pipe.push("e");
      await waitUntil("kept the later lines", () => tail.lastLines().length === 5);
      expect(tail.lastLines()).toEqual(["b", "warning", "c", "d", "e"]);
      // Nothing has closed the pipe, so a reader of `ended` must still be waiting.
      expect(ended).toBe(false);
    } finally {
      pipe.end();
    }
    await tail.ended;
    expect(ended).toBe(true);
  });

  it("keeps each line as `formatLine` returns it, and a line from elsewhere as it is", async () => {
    const pipe = createLines();
    const tail = keepStderrTail(pipe.iterable, (line) => line.trim().slice(0, 3));

    pipe.push("  abcdef  ");
    pipe.end();
    await tail.ended;
    tail.appendLine("  as is  ");

    expect(tail.lastLines()).toEqual(["abc", "  as is  "]);
  });

  it("resolves when the pipe fails, and keeps the lines read before", async () => {
    const pipe = createLines();
    const tail = keepStderrTail(pipe.iterable);

    pipe.push("before the failure");
    pipe.fail(new Error("the pipe broke"));
    await tail.ended;

    expect(tail.lastLines()).toEqual(["before the failure"]);
  });
});
