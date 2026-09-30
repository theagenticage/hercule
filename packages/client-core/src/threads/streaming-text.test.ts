/**
 * Tests `splitStreamingText`, which splits the text of an open message into
 * its finished paragraphs and the paragraph being written.
 */
import { describe, expect, it } from "vitest";
import { splitStreamingText } from "./streaming-text";

describe("splitStreamingText", () => {
  it("leaves a text with no blank line wholly open", () => {
    expect(splitStreamingText("The configu")).toEqual({ settled: "", open: "The configu" });
  });

  it("splits after the last blank line", () => {
    expect(splitStreamingText("One.\n\nTwo.\n\nThe configu")).toEqual({
      settled: "One.\n\nTwo.\n\n",
      open: "The configu",
    });
  });

  it("settles everything when the text ends with a blank line", () => {
    expect(splitStreamingText("One.\n\n")).toEqual({ settled: "One.\n\n", open: "" });
  });

  it("counts a line of spaces as blank", () => {
    expect(splitStreamingText("One.\n  \nTwo")).toEqual({ settled: "One.\n  \n", open: "Two" });
  });

  it("keeps a code block being written whole in the open part", () => {
    expect(splitStreamingText("Run:\n\n```sh\nmake\n\nmake te")).toEqual({
      settled: "Run:\n\n",
      open: "```sh\nmake\n\nmake te",
    });
  });

  it("splits after a closed code block", () => {
    expect(splitStreamingText("```sh\nmake\n\n```\n\nThen")).toEqual({
      settled: "```sh\nmake\n\n```\n\n",
      open: "Then",
    });
  });

  it("closes a fence only with a bare marker of the same character, at least as long", () => {
    const text = "````md\n```\n\n~~~~\n\n```ts\n\n````\n\nDone";
    expect(splitStreamingText(text)).toEqual({ settled: text.slice(0, -4), open: "Done" });
  });

  it("does not treat a fence still being typed on the last line as closed", () => {
    expect(splitStreamingText("```\ncode\n\n``")).toEqual({ settled: "", open: "```\ncode\n\n``" });
  });

  it("continues the scan after an earlier settled part", () => {
    expect(splitStreamingText("One.\n\nTwo.\n\nThree", "One.\n\n")).toEqual({
      settled: "One.\n\nTwo.\n\n",
      open: "Three",
    });
  });

  it("keeps the earlier settled part when no paragraph has finished since", () => {
    expect(splitStreamingText("One.\n\nTw", "One.\n\n")).toEqual({
      settled: "One.\n\n",
      open: "Tw",
    });
  });

  it("starts again from the beginning when the text no longer starts with the earlier settled part", () => {
    expect(splitStreamingText("One.\n\nTw", "One.\n\nTwo.\n\n")).toEqual({
      settled: "One.\n\n",
      open: "Tw",
    });
  });
});
