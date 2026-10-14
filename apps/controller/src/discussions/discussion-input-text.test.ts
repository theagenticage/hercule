/** Tests the text a Discussion Input is built with. */
import { describe, expect, it } from "vitest";
import { countCharacters } from "@hercule/contract";
import {
  buildDiscussionInputText,
  describeDiscussionInputRefusal,
  MAX_DISCUSSION_INPUT_LENGTH,
  type DiscussionEntry,
  type DiscussionInputContent,
} from "./discussion-input-text";

const ME = "01a13a99-0000-7000-8000-00000000aaaa";
const OTHER = "01a13a99-0000-7000-8000-00000000bbbb";
const THIRD = "01a13a99-0000-7000-8000-00000000cccc";
const D1 = "01a13a99-0000-7000-8000-0000000000d1";
const D2 = "01a13a99-0000-7000-8000-0000000000d2";
const P1 = "01a13a99-0000-7000-8000-0000000000a1";
const P2 = "01a13a99-0000-7000-8000-0000000000a2";

/** Builds an entry that shares exactly these files, with the sessions they list. */
const entry = (discussionId: string, files: DiscussionEntry["files"]): DiscussionEntry => ({
  discussionId,
  repository: "github.com/acme/app",
  files,
  fileCount: files.length,
  otherSessionIds: [...new Set(files.flatMap((file) => file.sessionIds))],
});

/** Builds the content of a Discussion Input in which every session can be told unless listed. */
const content = (
  parts: Partial<DiscussionInputContent> & { readonly notTold?: ReadonlyArray<string> },
): DiscussionInputContent => ({
  entries: parts.entries ?? [],
  entryCount: parts.entryCount ?? parts.entries?.length ?? 0,
  newPosts: parts.newPosts ?? [],
  newPostCount: parts.newPostCount ?? parts.newPosts?.length ?? 0,
  sessionsNotTold: new Set(parts.notTold ?? []),
});

const buildText = (parts: Parameters<typeof content>[0]) =>
  buildDiscussionInputText(content(parts), ME).text;

/** Returns `count` session ids, each ending in its index. */
const mintSessionIds = (count: number) =>
  Array.from({ length: count }, (_, index) => `01a13a99-0000-7000-8000-00000000000${index}`);

describe("the text of a Discussion Input", () => {
  it("writes one entry as spec 19 shows it", () => {
    const text = buildText({
      entries: [entry(D1, [{ path: "src/app.ts", sessionIds: [OTHER, THIRD] }])],
      notTold: [OTHER],
    });
    expect(text).toBe(
      "Another session edited files you edited in github.com/acme/app:\n" +
        "- `src/app.ts`, with session 0000bbbb (not told), session 0000cccc\n\n" +
        "Nothing is blocked; this is a heads-up so you do not undo each other's work. " +
        `Read discussion ${D1} with \`hercule discussion read ${D1}\`, then post there who changes what: ` +
        `\`echo "<your plan>" | hercule discussion post ${D1}\`.`,
    );
  });

  it("says so when no other session of an entry can be told", () => {
    const text = buildText({
      entries: [entry(D1, [{ path: "a.ts", sessionIds: [OTHER] }])],
      notTold: [OTHER],
    });
    expect(text).toContain(
      "- `a.ts`, with session 0000bbbb (not told)\n" +
        "None of them can be told now. Post your plan in the discussion; their users read it.\n\n",
    );
  });

  it("writes the new-Posts line after the entries, each entry its own paragraph", () => {
    const text = buildText({
      entries: [
        entry(D1, [{ path: "a.ts", sessionIds: [OTHER] }]),
        entry(D2, [{ path: "b.ts", sessionIds: [OTHER] }]),
      ],
      newPosts: [
        { discussionId: P1, firstPostId: P1 },
        { discussionId: P2, firstPostId: P2 },
      ],
    });
    const paragraphs = text.split("\n\n");
    expect(paragraphs).toHaveLength(5);
    expect(paragraphs[0]).toContain("`a.ts`");
    expect(paragraphs[2]).toContain("`b.ts`");
    expect(paragraphs[4]).toBe(
      `New posts in discussions ${P1}, ${P2}. Read them with ` +
        `\`hercule discussion read ${P1} --from ${P1}\` and \`hercule discussion read ${P2} --from ${P2}\`.`,
    );
  });

  it("names one Discussion with new Posts in the singular", () => {
    expect(buildText({ newPosts: [{ discussionId: D1, firstPostId: P1 }] })).toBe(
      `New posts in discussion ${D1}. Read them with \`hercule discussion read ${D1} --from ${P1}\`.`,
    );
  });

  it("cuts a long path to 200 characters, keeping its end", () => {
    const path = `${"x".repeat(300)}/end.ts`;
    const text = buildText({ entries: [entry(D1, [{ path, sessionIds: [OTHER] }])] });
    const shown = /`(\.\.\.[^`]*)`/.exec(text)?.[1];
    expect(shown).toBeDefined();
    expect(countCharacters(shown!)).toBe(200);
    expect(shown!.endsWith("/end.ts")).toBe(true);
  });

  it("counts a path's length in characters, not UTF-16 units", () => {
    const path = "\u{1F600}".repeat(200);
    const text = buildText({ entries: [entry(D1, [{ path, sessionIds: [OTHER] }])] });
    expect(text).toContain(`\`${path}\``);
  });

  it("names at most 5 files per entry and 5 sessions per file, and counts the rest", () => {
    const sessionIds = mintSessionIds(7);
    const files = Array.from({ length: 8 }, (_, index) => ({ path: `f${index}.ts`, sessionIds }));
    const text = buildText({ entries: [entry(D1, files)] });
    expect(text.match(/^- `/gm)).toHaveLength(5);
    expect(text).not.toContain("`f5.ts`");
    expect(text).toContain(", session 00000004, and 2 more sessions\n");
    expect(text).toContain(`and 3 more files; see \`hercule discussion read ${D1}\``);
  });

  it("names at most 10 Discussions with new Posts, counts the rest, and returns the named ones", () => {
    const newPosts = Array.from({ length: 13 }, (_, index) => ({
      discussionId: `01a13a99-0000-7000-8000-0000000000${String(index).padStart(2, "0")}`,
      firstPostId: P1,
    }));
    const built = buildDiscussionInputText(content({ newPosts }), ME);
    expect(built.text.match(/hercule discussion read /g)).toHaveLength(10);
    expect(built.text).toContain(
      `\nand 3 more discussions: run \`hercule discussion list --session ${ME}\`.`,
    );
    expect(built.namedNewPosts).toEqual(newPosts.slice(0, 10));
  });

  it("fits in 8,000 characters at every bound's largest, counting the entries it leaves out", () => {
    const sessionIds = mintSessionIds(9);
    const files = Array.from({ length: 9 }, (_, index) => ({
      path: `${index}${"p".repeat(400)}`,
      sessionIds,
    }));
    const entries = Array.from({ length: 9 }, (_, index) => ({
      ...entry(`01a13a99-0000-7000-8000-00000000000${index}`, files),
      repository: "r".repeat(512),
    }));
    const newPosts = Array.from({ length: 20 }, (_, index) => ({
      discussionId: `01a13a99-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
      firstPostId: P1,
    }));
    const built = buildDiscussionInputText(content({ entries, newPosts, notTold: sessionIds }), ME);
    expect(countCharacters(built.text)).toBeLessThanOrEqual(MAX_DISCUSSION_INPUT_LENGTH);
    const listed = built.text.match(/^Another session edited/gm)?.length ?? 0;
    expect(listed).toBeGreaterThanOrEqual(1);
    expect(listed).toBeLessThan(5);
    expect(built.namedEntries).toEqual(entries.slice(0, listed));
    expect(built.text).toContain(
      `and ${entries.length - listed} more discussions: run \`hercule discussion list --session ${ME}\`.`,
    );
    expect(built.text).toContain("and 10 more discussions");
  });
});

describe("the text of a Discussion Input read only in part", () => {
  it("counts what it leaves out from the counts it is given, not from the lists", () => {
    const text = buildText({
      entries: [{ ...entry(D1, [{ path: "a.ts", sessionIds: [OTHER] }]), fileCount: 500 }],
      entryCount: 50,
      newPosts: [{ discussionId: P1, firstPostId: P1 }],
      newPostCount: 40,
    });
    expect(text).toContain(`and 499 more files; see \`hercule discussion read ${D1}\``);
    expect(text).toContain("and 49 more discussions: run");
    expect(text).toContain("and 39 more discussions: run");
  });

  it("says no one can be told only when that holds for every other session, named or not", () => {
    const shared = entry(D1, [{ path: "a.ts", sessionIds: [OTHER] }]);
    const withUnnamed = { ...shared, otherSessionIds: [OTHER, THIRD] };
    const none = "None of them can be told now.";
    expect(buildText({ entries: [withUnnamed], notTold: [OTHER] })).not.toContain(none);
    expect(buildText({ entries: [withUnnamed], notTold: [OTHER, THIRD] })).toContain(none);
  });
});

describe("the reason a session was not told", () => {
  it("gives the phrases a system Post uses", () => {
    expect(describeDiscussionInputRefusal("not_running")).toBe("it is not running");
    expect(describeDiscussionInputRefusal("done")).toBe("it is marked done");
    expect(describeDiscussionInputRefusal("conversation")).toBe(
      "it is an assistant's conversation",
    );
    expect(describeDiscussionInputRefusal("lacks_grants")).toBe("it lacks the discussion grants");
  });
});
