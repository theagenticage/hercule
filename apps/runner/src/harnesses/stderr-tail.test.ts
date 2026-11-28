/**
 * Tests for the last lines kept from a harness's stderr, on an in-memory pipe
 * the test writes to and closes.
 */
import { describe, expect, it } from "vitest";
import { STDERR_TAIL_LINES, keepStderrTail } from "./stderr-tail";
import { createLines } from "./testing";

describe("the last lines of stderr", () => {
  it("keeps only the last lines, oldest first, and skips blank ones", async () => {
    const pipe = createLines();
    const tail = keepStderrTail(pipe.iterable);

    pipe.push("");
    for (let line = 1; line <= STDERR_TAIL_LINES + 2; line += 1) pipe.push(`line ${line}`);
    pipe.push("   ");
    pipe.end();
    await tail.ended;

    expect(tail.lastLines()).toEqual(["line 3", "line 4", "line 5", "line 6", "line 7"]);
  });

  it("gives the lines read so far while the pipe is still open", async () => {
    const pipe = createLines();
    const tail = keepStderrTail(pipe.iterable);

    pipe.push("first");
    // The pipe is not closed, so `ended` never resolves: wait on the line itself.
    while (tail.lastLines().length === 0) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(tail.lastLines()).toEqual(["first"]);
    pipe.end();
  });

  it("resolves when the pipe fails, and keeps the lines read before", async () => {
    const pipe = createLines();
    const tail = keepStderrTail(pipe.iterable);

    pipe.push("before the failure");
    pipe.fail(new Error("the pipe broke"));
    await tail.ended;

    expect(tail.lastLines()).toEqual(["before the failure"]);
  });

  it("counts a remembered line toward the same limit", async () => {
    const pipe = createLines();
    const tail = keepStderrTail(pipe.iterable);

    for (let line = 1; line <= STDERR_TAIL_LINES; line += 1) pipe.push(`stderr ${line}`);
    pipe.end();
    await tail.ended;
    tail.remember("a warning");

    expect(tail.lastLines()).toEqual(["stderr 2", "stderr 3", "stderr 4", "stderr 5", "a warning"]);
  });
});
