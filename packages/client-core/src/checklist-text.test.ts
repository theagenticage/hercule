import { describe, expect, it } from "vitest";
import { readChecklist } from "./checklist-text";

describe("readChecklist", () => {
  it("reads a sentence, a numbered list and a link to a web address", () => {
    expect(
      readChecklist(
        "Hercule adds an app.\n\n1. Open [api.example/apps](https://api.example/apps).\n2. Paste it **here**.",
      ),
    ).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "Hercule adds an app." }] },
      {
        type: "list",
        start: 1,
        items: [
          [
            {
              type: "paragraph",
              children: [
                { type: "text", text: "Open " },
                {
                  type: "link",
                  href: "https://api.example/apps",
                  children: [{ type: "text", text: "api.example/apps" }],
                },
                { type: "text", text: "." },
              ],
            },
          ],
          [
            {
              type: "paragraph",
              children: [
                { type: "text", text: "Paste it " },
                { type: "strong", children: [{ type: "text", text: "here" }] },
                { type: "text", text: "." },
              ],
            },
          ],
        ],
      },
    ]);
  });

  it("keeps only the text of a link that is not an absolute web address", () => {
    for (const href of [
      "javascript:alert(1)",
      "mailto:a@b.example",
      "reference.md",
      "#top",
      "ftp://a.example/x",
    ]) {
      const [block] = readChecklist(`See [the page](${href}).`);
      const children = block?.type === "paragraph" ? block.children : [];
      expect(children.every((inline) => inline.type === "text")).toBe(true);
      expect(children.map((inline) => (inline.type === "text" ? inline.text : "")).join("")).toBe(
        "See the page.",
      );
    }
  });

  it("shows an image as its alternative text, so opening the form requests nothing", () => {
    expect(
      readChecklist("![the Generate Token button](https://tracker.example/pixel.png)"),
    ).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "the Generate Token button" }] },
    ]);
  });

  it("shows embedded HTML as the characters written, and draws no element from it", () => {
    const [block] = readChecklist(
      '<img src="https://tracker.example/p.png"> and <a href="https://a.example">x</a>',
    );
    expect(JSON.stringify(block)).not.toContain('"type":"link"');
    expect(JSON.stringify(block)).not.toContain('"type":"image"');
    expect(JSON.stringify(block)).toContain("<img src=");
  });

  it("reads a heading, a quote and a code block as plain paragraphs", () => {
    expect(readChecklist("# Steps\n\n> quoted\n\n```\nrun it\n```")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "Steps" }] },
      { type: "paragraph", children: [{ type: "text", text: "quoted" }] },
      { type: "paragraph", children: [{ type: "text", text: "run it" }] },
    ]);
  });

  it("returns text nested too deeply to parse as one paragraph of the text as written", () => {
    const text = `${"> ".repeat(500)}deep`;
    expect(readChecklist(text)).toEqual([
      { type: "paragraph", children: [{ type: "text", text }] },
    ]);
  });
});
