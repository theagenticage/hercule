import { describe, expect, it } from "vitest";
import { splitCodeSpans } from "./code-spans";

describe("splitCodeSpans", () => {
  it("returns a message without backticks as one text part", () => {
    expect(splitCodeSpans("API Error: Connection error.")).toEqual([
      { kind: "text", text: "API Error: Connection error." },
    ]);
  });

  it("returns the command a message ends with as a code part", () => {
    expect(
      splitCodeSpans(
        "Codex is not logged in. Sign in with: `hercule provider-account sign-in 7b41 --runner 01a1`",
      ),
    ).toEqual([
      { kind: "text", text: "Codex is not logged in. Sign in with: " },
      { kind: "code", text: "hercule provider-account sign-in 7b41 --runner 01a1" },
    ]);
  });

  it("finds several code parts, with text between and after them", () => {
    expect(splitCodeSpans("Could not load `review` or `deploy`. Retry.")).toEqual([
      { kind: "text", text: "Could not load " },
      { kind: "code", text: "review" },
      { kind: "text", text: " or " },
      { kind: "code", text: "deploy" },
      { kind: "text", text: ". Retry." },
    ]);
  });

  it("keeps a backtick with no partner in the text", () => {
    expect(splitCodeSpans("Run `hercule runner list")).toEqual([
      { kind: "text", text: "Run `hercule runner list" },
    ]);
  });

  it("keeps an empty pair of backticks in the text", () => {
    expect(splitCodeSpans("Nothing between `` here")).toEqual([
      { kind: "text", text: "Nothing between `` here" },
    ]);
  });

  it("keeps an empty pair in the text and still finds the code part after it", () => {
    expect(splitCodeSpans("a `` b `cmd` c")).toEqual([
      { kind: "text", text: "a `` b " },
      { kind: "code", text: "cmd" },
      { kind: "text", text: " c" },
    ]);
  });

  it("closes a run of several backticks only with a run of the same length", () => {
    expect(splitCodeSpans("Run ``echo `date` `` now")).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "echo `date` " },
      { kind: "text", text: " now" },
    ]);
  });

  it("returns no parts for an empty message", () => {
    expect(splitCodeSpans("")).toEqual([]);
  });
});
