import { describe, expect, it } from "vitest";
import { buildHarnessPrompt, joinInstructions } from "./prompt";
import type { LocalAttachment } from "./index";

const SENDER = "0199e0e7-0000-7000-8000-0000000000e1";
const HEADER = `[Message from session ${SENDER}, another agent. To reply: hercule session input ${SENDER}]`;
const IMAGE: LocalAttachment = {
  id: "0199e0e7-0000-7000-8000-0000000000a1",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 68,
  sha256: "0".repeat(64),
  path: "/cache/screenshot",
};
const IMAGE_LINE = `[Attached image "screenshot.png" is saved at: /cache/screenshot]`;

describe("the prompt a harness gets for an input", () => {
  it("is the text unchanged when no other agent sent it and it has no images", () => {
    expect(buildHarnessPrompt({ text: "hello" })).toBe("hello");
  });

  it("starts with a header naming the sending session and how to reply", () => {
    expect(buildHarnessPrompt({ text: "rebase on main", senderSessionId: SENDER })).toBe(
      `${HEADER}\n\nrebase on main`,
    );
  });

  it("puts the header first, then the text, then the image lines", () => {
    expect(
      buildHarnessPrompt({ text: "what is this?", senderSessionId: SENDER, attachments: [IMAGE] }),
    ).toBe(`${HEADER}\n\nwhat is this?\n\n${IMAGE_LINE}`);
  });

  it("leaves out the text and its blank line when the text is empty", () => {
    expect(buildHarnessPrompt({ text: "", senderSessionId: SENDER })).toBe(HEADER);
    expect(buildHarnessPrompt({ text: "", senderSessionId: SENDER, attachments: [IMAGE] })).toBe(
      `${HEADER}\n\n${IMAGE_LINE}`,
    );
  });
});

describe("the prompt a harness gets for a changed copy of the text", () => {
  it("puts the header and the image lines around the text it is given, not the input's own", () => {
    expect(
      buildHarnessPrompt(
        { text: "the whole text", senderSessionId: SENDER, attachments: [IMAGE] },
        "the first part",
      ),
    ).toBe(`${HEADER}\n\nthe first part\n\n${IMAGE_LINE}`);
  });
});

describe("the instructions a session starts with", () => {
  it("joins the parts in order with a blank line, leaving out missing and empty ones", () => {
    expect(joinInstructions(["persona", undefined, "", "memory"])).toBe("persona\n\nmemory");
  });

  it("returns undefined when no part has text", () => {
    expect(joinInstructions([undefined, ""])).toBeUndefined();
  });
});
