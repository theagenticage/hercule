/** Tests how Discussion mentions merge and the text a Discussion Input is built with. */
import { describe, expect, it } from "vitest";
import { countCharacters } from "@hercule/contract";
import {
  buildDiscussionInputText,
  describeDiscussionInputRefusal,
  MAX_DISCUSSION_INPUT_LENGTH,
  mergeDiscussionMentions,
  NO_DISCUSSION_MENTIONS,
  type DiscussionEntry,
  type DiscussionMentions,
} from "./discussion-input";

const ME = "01a13a99-0000-7000-8000-00000000aaaa";
const OTHER = "01a13a99-0000-7000-8000-00000000bbbb";
const THIRD = "01a13a99-0000-7000-8000-00000000cccc";
const D1 = "01a13a99-0000-7000-8000-0000000000d1";
const D2 = "01a13a99-0000-7000-8000-0000000000d2";
const P1 = "01a13a99-0000-7000-8000-0000000000a1";
const P2 = "01a13a99-0000-7000-8000-0000000000a2";

const entry = (discussionId: string, files: DiscussionEntry["files"]): DiscussionEntry => ({
  discussionId,
  repository: "github.com/acme/app",
  files,
});

describe("merging Discussion mentions", () => {
  it("keeps every entry, joining the files of one Discussion by path and their sessions by id", () => {
    const older: DiscussionMentions = {
      entries: [entry(D1, [{ path: "a.ts", sessions: [{ sessionId: OTHER, canBeTold: true }] }])],
      newPosts: [],
    };
    const newer: DiscussionMentions = {
      entries: [
        entry(D1, [
          { path: "a.ts", sessions: [{ sessionId: THIRD, canBeTold: true }] },
          { path: "b.ts", sessions: [{ sessionId: OTHER, canBeTold: true }] },
        ]),
        entry(D2, [{ path: "c.ts", sessions: [{ sessionId: OTHER, canBeTold: false }] }]),
      ],
      newPosts: [],
    };
    expect(mergeDiscussionMentions(older, newer).entries).toEqual([
      entry(D1, [
        {
          path: "a.ts",
          sessions: [
            { sessionId: OTHER, canBeTold: true },
            { sessionId: THIRD, canBeTold: true },
          ],
        },
        { path: "b.ts", sessions: [{ sessionId: OTHER, canBeTold: true }] },
      ]),
      entry(D2, [{ path: "c.ts", sessions: [{ sessionId: OTHER, canBeTold: false }] }]),
    ]);
  });

  it("takes whether a session can be told from the newer mention", () => {
    const buildMention = (canBeTold: boolean): DiscussionMentions => ({
      entries: [entry(D1, [{ path: "a.ts", sessions: [{ sessionId: OTHER, canBeTold }] }])],
      newPosts: [],
    });
    expect(mergeDiscussionMentions(buildMention(true), buildMention(false))).toEqual(
      buildMention(false),
    );
  });

  it("keeps the earliest first Post of each Discussion, whichever record holds it", () => {
    const early = { entries: [], newPosts: [{ discussionId: D1, firstPostId: P1 }] };
    const late = { entries: [], newPosts: [{ discussionId: D1, firstPostId: P2 }] };
    expect(mergeDiscussionMentions(early, late).newPosts).toEqual([
      { discussionId: D1, firstPostId: P1 },
    ]);
    expect(mergeDiscussionMentions(late, early).newPosts).toEqual([
      { discussionId: D1, firstPostId: P1 },
    ]);
  });

  it("drops a new-Posts mention of a Discussion it has an entry for", () => {
    const joined: DiscussionMentions = {
      entries: [entry(D1, [{ path: "a.ts", sessions: [{ sessionId: OTHER, canBeTold: true }] }])],
      newPosts: [
        { discussionId: D1, firstPostId: P1 },
        { discussionId: D2, firstPostId: P2 },
      ],
    };
    expect(mergeDiscussionMentions(NO_DISCUSSION_MENTIONS, joined).newPosts).toEqual([
      { discussionId: D2, firstPostId: P2 },
    ]);
    expect(
      mergeDiscussionMentions(joined, {
        entries: [],
        newPosts: [{ discussionId: D1, firstPostId: P2 }],
      }).newPosts,
    ).toEqual([{ discussionId: D2, firstPostId: P2 }]);
  });
});

describe("the text of a Discussion Input", () => {
  it("writes one entry as spec 19 shows it", () => {
    const text = buildDiscussionInputText(
      {
        entries: [
          entry(D1, [
            {
              path: "src/app.ts",
              sessions: [
                { sessionId: OTHER, canBeTold: false },
                { sessionId: THIRD, canBeTold: true },
              ],
            },
          ]),
        ],
        newPosts: [],
      },
      ME,
    );
    expect(text).toBe(
      "Another session edited files you edited in github.com/acme/app:\n" +
        "- `src/app.ts`, with session 0000bbbb (not told), session 0000cccc\n\n" +
        "Nothing is blocked; this is a heads-up so you do not undo each other's work. " +
        `Read discussion ${D1} with \`hercule discussion read ${D1}\`, then post there who changes what: ` +
        `\`echo "<your plan>" | hercule discussion post ${D1}\`.`,
    );
  });

  it("says so when no other session of an entry can be told", () => {
    const text = buildDiscussionInputText(
      {
        entries: [
          entry(D1, [{ path: "a.ts", sessions: [{ sessionId: OTHER, canBeTold: false }] }]),
        ],
        newPosts: [],
      },
      ME,
    );
    expect(text).toContain(
      "- `a.ts`, with session 0000bbbb (not told)\n" +
        "None of them can be told now. Post your plan in the discussion; their users read it.\n\n",
    );
  });

  it("writes the new-Posts line after the entries, each entry its own paragraph", () => {
    const text = buildDiscussionInputText(
      {
        entries: [
          entry(D1, [{ path: "a.ts", sessions: [{ sessionId: OTHER, canBeTold: true }] }]),
          entry(D2, [{ path: "b.ts", sessions: [{ sessionId: OTHER, canBeTold: true }] }]),
        ],
        newPosts: [
          { discussionId: P1, firstPostId: P1 },
          { discussionId: P2, firstPostId: P2 },
        ],
      },
      ME,
    );
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
    expect(
      buildDiscussionInputText(
        { entries: [], newPosts: [{ discussionId: D1, firstPostId: P1 }] },
        ME,
      ),
    ).toBe(
      `New posts in discussion ${D1}. Read them with \`hercule discussion read ${D1} --from ${P1}\`.`,
    );
  });

  it("cuts a long path to 200 characters, keeping its end", () => {
    const path = `${"x".repeat(300)}/end.ts`;
    const text = buildDiscussionInputText(
      {
        entries: [entry(D1, [{ path, sessions: [{ sessionId: OTHER, canBeTold: true }] }])],
        newPosts: [],
      },
      ME,
    );
    const shown = /`(\.\.\.[^`]*)`/.exec(text)?.[1];
    expect(shown).toBeDefined();
    expect(countCharacters(shown!)).toBe(200);
    expect(shown!.endsWith("/end.ts")).toBe(true);
  });

  it("counts a path's length in characters, not UTF-16 units", () => {
    const path = "\u{1F600}".repeat(200);
    const text = buildDiscussionInputText(
      {
        entries: [entry(D1, [{ path, sessions: [{ sessionId: OTHER, canBeTold: true }] }])],
        newPosts: [],
      },
      ME,
    );
    expect(text).toContain(`\`${path}\``);
  });

  it("names at most 5 files per entry and 5 sessions per file, and counts the rest", () => {
    const sessions = Array.from({ length: 7 }, (_, index) => ({
      sessionId: `01a13a99-0000-7000-8000-00000000000${index}`,
      canBeTold: true,
    }));
    const files = Array.from({ length: 8 }, (_, index) => ({ path: `f${index}.ts`, sessions }));
    const text = buildDiscussionInputText({ entries: [entry(D1, files)], newPosts: [] }, ME);
    expect(text.match(/^- `/gm)).toHaveLength(5);
    expect(text).not.toContain("`f5.ts`");
    expect(text).toContain(", session 00000004, and 2 more sessions\n");
    expect(text).toContain(`and 3 more files; see \`hercule discussion read ${D1}\``);
  });

  it("names at most 10 Discussions with new Posts, and counts the rest", () => {
    const newPosts = Array.from({ length: 13 }, (_, index) => ({
      discussionId: `01a13a99-0000-7000-8000-0000000000${String(index).padStart(2, "0")}`,
      firstPostId: P1,
    }));
    const text = buildDiscussionInputText({ entries: [], newPosts }, ME);
    expect(text.match(/hercule discussion read /g)).toHaveLength(10);
    expect(text).toContain(
      `\nand 3 more discussions: run \`hercule discussion list --session ${ME}\`.`,
    );
  });

  it("fits in 8,000 characters at every bound's largest, counting the entries it leaves out", () => {
    const sessions = Array.from({ length: 9 }, (_, index) => ({
      sessionId: `01a13a99-0000-7000-8000-00000000000${index}`,
      canBeTold: false,
    }));
    const files = Array.from({ length: 9 }, (_, index) => ({
      path: `${index}${"p".repeat(400)}`,
      sessions,
    }));
    const entries = Array.from({ length: 9 }, (_, index) => ({
      discussionId: `01a13a99-0000-7000-8000-00000000000${index}`,
      repository: "r".repeat(512),
      files,
    }));
    const newPosts = Array.from({ length: 20 }, (_, index) => ({
      discussionId: `01a13a99-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
      firstPostId: P1,
    }));
    const text = buildDiscussionInputText({ entries, newPosts }, ME);
    expect(countCharacters(text)).toBeLessThanOrEqual(MAX_DISCUSSION_INPUT_LENGTH);
    const listed = text.match(/^Another session edited/gm)?.length ?? 0;
    expect(listed).toBeGreaterThanOrEqual(1);
    expect(text).toContain(
      `and ${entries.length - listed} more discussions: run \`hercule discussion list --session ${ME}\`.`,
    );
    expect(text).toContain("and 10 more discussions");
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
