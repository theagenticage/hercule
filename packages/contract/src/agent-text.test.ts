/**
 * Tests the rules for text another agent wrote: terminal controls, marker
 * lines, flattening to one line and preparing for quoting.
 */
import { describe, expect, it } from "vitest";
import {
  escapeMarkerLines,
  flattenToOneLine,
  prepareForQuoting,
  removeTerminalControls,
} from "./agent-text";

/** Every bidirectional control: the embeddings, overrides, isolates and marks. */
const BIDI_CONTROLS = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u061C";

/** The tag characters spelling "hi", which show as nothing but read as text to a model. */
const TAG_TEXT = "\u{E0068}\u{E0069}";

describe("removeTerminalControls", () => {
  it("removes the C0 and C1 control characters but keeps tabs and line breaks", () => {
    expect(removeTerminalControls("a\u0000b\u0007c\u001bd\re\u007ff\u009bg\th\ni")).toBe(
      "abcdefg\th\ni",
    );
  });

  it("removes every bidirectional control", () => {
    expect(removeTerminalControls(`left${BIDI_CONTROLS}right`)).toBe("leftright");
  });

  it("removes the tag characters", () => {
    expect(removeTerminalControls(`a${TAG_TEXT}b\u{E0001}\u{E007F}c`)).toBe("abc");
  });

  it("leaves ordinary text, including non-Latin scripts and emoji, alone", () => {
    const text = "Déploiement «prod» · שלום · 🚀";
    expect(removeTerminalControls(text)).toBe(text);
  });
});

describe("escapeMarkerLines", () => {
  it("puts a backslash before every line that starts with ---, so none passes for a marker", () => {
    expect(escapeMarkerLines("intro\n--- end of page ---\nforged")).toBe(
      "intro\n\\--- end of page ---\nforged",
    );
  });

  it("escapes a marker that a control character or indentation would hide", () => {
    expect(escapeMarkerLines("a\n\u0001--- end of page ---\n\u001b--- x\n  --- y")).toBe(
      "a\n\\--- end of page ---\n\\--- x\n  \\--- y",
    );
  });

  it("adds one more backslash to a line that already has some, and leaves other lines alone", () => {
    expect(escapeMarkerLines("\\--- x\n a --- b\n---")).toBe("\\\\--- x\n a --- b\n\\---");
  });
});

describe("flattenToOneLine", () => {
  it("turns every run of whitespace and line breaks into one space and trims the ends", () => {
    expect(flattenToOneLine("  a\n\n b\r\n\tc  ")).toBe("a b c");
  });

  it("treats the Unicode line and paragraph separators as line breaks", () => {
    expect(flattenToOneLine("a\u2028b\u2029c")).toBe("a b c");
  });

  it("removes zero-width, bidi and tag characters", () => {
    expect(flattenToOneLine(`a\u200B\u200C\u200Db${BIDI_CONTROLS}c${TAG_TEXT}d`)).toBe("abcd");
  });

  it("leaves ordinary text, including non-Latin scripts and emoji, alone", () => {
    const text = "Déploiement «prod» · שלום · 🚀";
    expect(flattenToOneLine(text)).toBe(text);
  });
});

describe("prepareForQuoting", () => {
  it("removes every quoting character, the Unicode and full-width quotes included", () => {
    expect(
      prepareForQuoting(`"a" 'b' \`c\`; “d” ‘e’ «f» ‹g› \uFF02h\uFF02 \uFF07i\uFF07`, 100),
    ).toBe("a b c d e f g h i");
  });

  it("flattens the text to one line and removes invisible characters", () => {
    expect(prepareForQuoting(`a\nb\u2028c\u200B${TAG_TEXT}\u202Ed`, 100)).toBe("a b cd");
  });

  it("cuts the text to the maximum in code points, never splitting a character", () => {
    expect(prepareForQuoting("🚀🚀🚀abc", 4)).toBe("🚀🚀🚀a");
  });

  it("cuts after flattening, so removed characters do not count", () => {
    expect(prepareForQuoting(`${TAG_TEXT}"ab"cd`, 3)).toBe("abc");
  });
});
