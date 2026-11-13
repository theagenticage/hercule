/** Tests the start-thread dialog's words: starters, the reason behind the project, the prompt and the draft key. */
import { MAX_PROMPT_LENGTH } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildInboxAsk, buildInboxThing } from "./cards.testing";
import {
  buildThingsDraftKey,
  buildThingsPromptText,
  describePickReason,
  describeProjectChoice,
  hasProjectPick,
  joinReasonText,
  writeStarterMessage,
  type ProjectChoice,
} from "./thread-start";

const one = buildInboxThing("1", { identifier: "#6244", title: "Checkout fails" });
const two = buildInboxThing("2", { asks: [buildInboxAsk("a", "Mei")] });
const names = { projectName: "webshop", repositoryName: "storefront-web" };
const matched = (extra: object = {}): ProjectChoice => ({
  kind: "inferred",
  match: {
    kind: "matched",
    projectId: "p",
    resourceId: "r",
    thing: { id: "1", identifier: "#6244" },
    ...extra,
  },
});
const words = (choice: ProjectChoice, n = names) =>
  joinReasonText(describeProjectChoice(choice, n));

describe("writeStarterMessage", () => {
  it("says this for one thing and these N for several", () => {
    expect(writeStarterMessage("investigate", [one])).toMatch(/^Look into this and tell me/);
    expect(writeStarterMessage("investigate", [one, two])).toMatch(
      /^Look into these 2 and tell me/,
    );
    expect(writeStarterMessage("fix", [one, two])).toMatch(/^Fix these 2 and open a pull request/);
    expect(writeStarterMessage("summarise", [one])).toMatch(/^Summarise where this stands:/);
    expect(writeStarterMessage("summarise", [one, two])).toMatch(/^Summarise where these 2 stand:/);
  });

  it("names the first asker in a reply, and none when no ask has a person", () => {
    expect(writeStarterMessage("reply", [one, two])).toMatch(/^Draft a reply to Mei\. /);
    expect(writeStarterMessage("reply", [one])).toMatch(/^Draft a reply\. /);
  });

  it("writes nothing for your own words", () => {
    expect(writeStarterMessage("own", [one])).toBe("");
  });
});

describe("describeProjectChoice", () => {
  it("bolds the project and cites the thing's own repository", () => {
    const parts = describeProjectChoice(matched(), names);
    expect(parts[0]).toEqual({ text: "webshop", strong: true });
    expect(joinReasonText(parts)).toBe(
      "webshop because #6244 is in storefront-web, one of webshop’s repositories. Its profile comes with it.",
    );
  });

  it("cites the link when the repository belongs to a linked thing", () => {
    expect(
      words(
        matched({
          thing: { id: "1", identifier: "SHOP-142" },
          via: { id: "9", identifier: "#6244" },
        }),
      ),
    ).toBe(
      "webshop because SHOP-142 is linked to #6244, in storefront-web, one of webshop’s repositories. Its profile comes with it.",
    );
  });

  it("names a thing by its quoted title, else by It", () => {
    expect(words(matched({ thing: { id: "1", title: "Checkout fails" } }))).toContain(
      "because “Checkout fails” is in",
    );
    expect(words(matched({ thing: { id: "1" } }))).toContain("because It is in");
  });

  it("says what a choice means", () => {
    expect(words({ kind: "chosen", projectId: "p" })).toBe(
      "webshop, which you chose. Its profile comes with it.",
    );
    expect(words({ kind: "none-chosen" })).toBe(
      "No project: the agent works without code or a checkout, with your own profile, and asks before it edits anything.",
    );
  });

  it("says why nothing is picked, for no match, an ambiguous one, and no reply", () => {
    expect(words({ kind: "inferred", match: { kind: "none" } })).toBe(
      "Nothing here points at a repository, so no project is picked. Choose one, or start it without code.",
    );
    expect(words({ kind: "inferred", match: { kind: "ambiguous" } })).toBe(
      "These point at more than one project, so none is picked. Choose one, or start it without code.",
    );
    expect(words({ kind: "unpicked" })).toContain("Nothing here points at a repository");
  });

  it("counts a match and a choice as a pick, and nothing else, and No project is not one", () => {
    expect(hasProjectPick(matched())).toBe(true);
    expect(hasProjectPick({ kind: "chosen", projectId: "p" })).toBe(true);
    expect(hasProjectPick({ kind: "none-chosen" })).toBe(false);
    expect(hasProjectPick({ kind: "unpicked" })).toBe(false);
  });
});

describe("describePickReason", () => {
  const labels = { ...names, accessLabel: "Ask before edits", profileLabel: "Opus 5.5 · High" };

  it("explains each pick of a matched project", () => {
    const reason = (pick: Parameters<typeof describePickReason>[0]) =>
      describePickReason(pick, matched(), labels);
    expect(reason("project")).toBe(
      "Picked because #6244 is in storefront-web, one of webshop’s repositories.",
    );
    expect(reason("access")).toContain("A project does not set it");
    expect(reason("profile")).toBe("Opus 5.5 · High is webshop’s profile.");
  });

  it("says a chosen project was chosen", () => {
    expect(describePickReason("project", { kind: "chosen", projectId: "p" }, labels)).toBe(
      "You chose it.",
    );
  });

  it("explains No project, and waiting for a project", () => {
    expect(describePickReason("profile", { kind: "none-chosen" }, labels)).toContain(
      "Your own profile",
    );
    expect(describePickReason("access", { kind: "unpicked" }, labels)).toBe(
      "Comes from the project you choose.",
    );
    expect(
      describePickReason("project", { kind: "inferred", match: { kind: "ambiguous" } }, labels),
    ).toBe("These point at more than one project.");
  });
});

describe("buildThingsPromptText", () => {
  it("puts the message, a line per thing and how to read them", () => {
    expect(buildThingsPromptText("Look into these 2.", [one, two])).toEqual({
      kind: "text",
      text: [
        "Look into these 2.",
        "",
        "- #6244 Checkout fails (1)",
        "- ACME-2 Ticket 2 (2)",
        "",
        "Read any of them in full with `hercule entity read <id>`.",
      ].join("\n"),
    });
  });

  it("refuses, rather than cuts, a prompt past the limit", () => {
    const result = buildThingsPromptText("x".repeat(MAX_PROMPT_LENGTH), [one]);
    expect(result.kind).toBe("too-long");
    expect(result.kind === "too-long" && result.reason).toContain("Shorten the message");
  });
});

describe("buildThingsDraftKey", () => {
  it("is the same for any order and differs for other sets", () => {
    expect(buildThingsDraftKey(["b", "a"])).toBe(buildThingsDraftKey(["a", "b"]));
    expect(buildThingsDraftKey(["a"])).not.toBe(buildThingsDraftKey(["a", "b"]));
  });
});
