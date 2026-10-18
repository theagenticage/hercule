import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  buildSkillArchive,
  computeSkillRevisionHash,
  MAX_SKILL_BYTES,
  readSkillArchive,
  type SkillArchiveEntry,
} from "@hercule/protocol";
import { checkSkillContent, type CheckedSkillContent } from "./content";

const utf8 = new TextEncoder();

const file = (path: string, text: string, mode = 0o644): SkillArchiveEntry => ({
  path,
  kind: "file",
  mode,
  content: utf8.encode(text),
});

const skillMd = (frontmatter: string, body = "Body.\n"): SkillArchiveEntry =>
  file("SKILL.md", `---\n${frontmatter}\n---\n${body}`);

const TEACH_MD = skillMd("name: teach\ndescription: Teaches.");

/** Runs the check and returns the content, failing the test when it is refused. */
const check = (
  name: string,
  entries: ReadonlyArray<SkillArchiveEntry>,
): Promise<CheckedSkillContent> => Effect.runPromise(checkSkillContent(name, entries));

/** Runs the check and returns the issues it was refused with, failing the test when it passes. */
const refuse = async (
  name: string,
  entries: ReadonlyArray<SkillArchiveEntry>,
): Promise<ReadonlyArray<string>> =>
  (await Effect.runPromise(Effect.flip(checkSkillContent(name, entries)))).issues;

describe("checkSkillContent", () => {
  it("passes the spec's worked example and gives its revision hash", async () => {
    const entries = [
      file("scripts/hi.sh", "echo hi\n", 0o755),
      file("SKILL.md", "---\nname: demo\ndescription: Says hi.\n---\nRun scripts/hi.sh.\n"),
      { path: "scripts", kind: "directory", mode: 0o755, content: new Uint8Array() } as const,
    ];
    const checked = await check("demo", entries);
    expect(checked.revisionHash).toBe(
      "e72ed80069b9b0cf3e19a4972f35e5daf05df98ed98d4e8ee131a26e6b3f711e",
    );
    expect(checked.revisionHash).toBe(
      await Effect.runPromise(computeSkillRevisionHash(checked.files)),
    );
    expect(checked.files.map(({ path, mode }) => ({ path, mode }))).toEqual([
      { path: "SKILL.md", mode: "644" },
      { path: "scripts/hi.sh", mode: "755" },
    ]);
    expect(checked.sizeBytes).toBe(entries[0]!.content.byteLength + entries[1]!.content.byteLength);
    expect(checked.description).toBe("Says hi.");
    expect(checked.approvalEffects).toEqual({ allowedTools: null, hooks: null });
  });

  describe("approvalEffects", () => {
    it("keeps `allowed-tools` written as a string", async () => {
      const checked = await check("teach", [
        skillMd("name: teach\ndescription: Teaches.\nallowed-tools: Bash(git:*) Read"),
      ]);
      expect(checked.approvalEffects.allowedTools).toBe("Bash(git:*) Read");
    });

    it("joins `allowed-tools` written as a list", async () => {
      const checked = await check("teach", [
        skillMd("name: teach\ndescription: Teaches.\nallowed-tools:\n  - Bash\n  - Read"),
      ]);
      expect(checked.approvalEffects.allowedTools).toBe("Bash, Read");
    });

    it("gives `hooks` as JSON with every object's keys sorted and no spaces", async () => {
      const checked = await check("teach", [
        skillMd(
          [
            "name: teach",
            "description: Teaches.",
            "hooks:",
            "  PreToolUse:",
            "    - matcher: Bash",
            "      hooks:",
            "        - type: command",
            "          command: ./check.sh",
            "  B: 1",
          ].join("\n"),
        ),
      ]);
      expect(checked.approvalEffects.hooks).toBe(
        '{"B":1,"PreToolUse":[{"hooks":[{"command":"./check.sh","type":"command"}],"matcher":"Bash"}]}',
      );
    });

    it("treats a field with an empty value as absent", async () => {
      const checked = await check("teach", [
        skillMd("name: teach\ndescription: Teaches.\nallowed-tools:\nhooks:"),
      ]);
      expect(checked.approvalEffects).toEqual({ allowedTools: null, hooks: null });
    });
  });

  it.each<[rule: string, name: string, entries: ReadonlyArray<SkillArchiveEntry>, issue: string]>([
    [
      "SKILL.md at the root",
      "teach",
      [file("docs/SKILL.md", "---\nname: teach\ndescription: x\n---\n")],
      "`teach` has no `SKILL.md` at its root. Add one, with a `name` and a `description` in its frontmatter.",
    ],
    [
      "frontmatter present",
      "teach",
      [file("SKILL.md", "# Teach\n")],
      "`teach/SKILL.md` has no YAML frontmatter. Start it with a `---` line, then `name` and `description`, then another `---` line.",
    ],
    [
      "SKILL.md is UTF-8",
      "teach",
      [{ path: "SKILL.md", kind: "file", mode: 0o644, content: new Uint8Array([0xff, 0xfe]) }],
      "`teach/SKILL.md` is not valid UTF-8 text. Save it as UTF-8.",
    ],
    [
      "frontmatter parses as YAML",
      "teach",
      [skillMd('name: teach\ndescription: "Teaches.')],
      '`teach/SKILL.md` has frontmatter that is not valid YAML at line 3: Missing closing "quote. Fix the YAML between the `---` lines.',
    ],
    [
      "frontmatter parses as YAML, with control characters escaped in the parser's message",
      "teach",
      [skillMd('name: teach\ndescription: "\\\u001b"')],
      "`teach/SKILL.md` has frontmatter that is not valid YAML at line 3: Invalid escape sequence \\\\u001b. Fix the YAML between the `---` lines.",
    ],
    [
      "frontmatter is a mapping",
      "teach",
      [skillMd("- name: teach")],
      "`teach/SKILL.md` has frontmatter that is not a YAML mapping. Write it as `key: value` lines.",
    ],
    [
      "no key twice",
      "teach",
      [skillMd("name: teach\ndescription: Teaches.\nallowed-tools: Read\nallowed-tools: Bash")],
      "`teach/SKILL.md` has `allowed-tools` twice in its frontmatter. Each key may appear once.",
    ],
    [
      "no key twice inside hooks",
      "teach",
      [skillMd("name: teach\ndescription: Teaches.\nhooks:\n  Stop: a\n  Stop: b")],
      "`teach/SKILL.md` has `Stop` twice in its frontmatter. Each key may appear once.",
    ],
    [
      "a `name`",
      "teach",
      [skillMd("description: Teaches.")],
      "`teach/SKILL.md` has no `name`. Add `name: teach` to its frontmatter.",
    ],
    [
      "`name` equal to the skill's name",
      "teach",
      [skillMd("name: teaching\ndescription: Teaches.")],
      "`teach/SKILL.md` has `name: teaching`. A skill's name must match its folder name; rename the folder or the name.",
    ],
    [
      "a `description`",
      "teach",
      [skillMd("name: teach")],
      "`teach/SKILL.md` has no `description`. Add one to its frontmatter: the agent reads it to decide when to use the skill.",
    ],
    [
      "a `description` with something other than whitespace",
      "teach",
      [skillMd('name: teach\ndescription: "   "')],
      "`teach/SKILL.md` has no `description`. Add one to its frontmatter: the agent reads it to decide when to use the skill.",
    ],
    [
      "a `description` that is text",
      "teach",
      [skillMd("name: teach\ndescription:\n  - a")],
      "`teach/SKILL.md` has a `description` that is not text. Write it as one line of text: the agent reads it to decide when to use the skill.",
    ],
    [
      "SKILL.md at most 1 MiB",
      "teach",
      [skillMd("name: teach\ndescription: Teaches.", "x".repeat(1.35 * 1024 * 1024))],
      "`teach/SKILL.md` is 1.4 MiB. A `SKILL.md` may be at most 1 MiB; move long material into files beside it.",
    ],
    [
      "the built-in skill's name",
      "hercule",
      [skillMd("name: hercule\ndescription: Mine.")],
      "`hercule` is the built-in skill's name. Rename the folder and the `name` in its `SKILL.md`.",
    ],
    [
      "the name pattern",
      "Teach_Me",
      [skillMd("name: Teach_Me\ndescription: Teaches.")],
      "`Teach_Me` is not a valid skill name. A name is at most 64 characters of lowercase letters, digits and single hyphens between them; rename the folder and the `name` in its `SKILL.md`.",
    ],
    [
      "no symbolic link",
      "teach",
      [TEACH_MD, { path: "notes", kind: "symlink", mode: 0o777, content: new Uint8Array() }],
      "`teach/notes` is a symbolic link. A skill archive holds only files and folders; read the folder with `hercule skill import` or the desktop app, which put a link's target in the archive when the target is inside the skill's folder.",
    ],
    [
      "no other kind of entry",
      "teach",
      [TEACH_MD, { path: "pipe", kind: "other", mode: 0o644, content: new Uint8Array() }],
      "`teach/pipe` is neither a file nor a folder. A skill archive holds only files and folders; remove it from the skill.",
    ],
    [
      "mode 644 or 755",
      "teach",
      [TEACH_MD, file("run.sh", "", 0o700)],
      "`teach/run.sh` has mode `700`. A file's mode must be `644` or `755`.",
    ],
    [
      "at most 1,000 files",
      "teach",
      [TEACH_MD, ...Array.from({ length: 1203 }, (_, index) => file(`f${String(index)}`, ""))],
      "`teach` has 1,204 files. A skill holds at most 1,000; remove the files it does not need.",
    ],
    [
      "no `..` segment",
      "teach",
      [TEACH_MD, file("../x", "")],
      "`teach/../x` is not a path inside the skill. Paths must stay inside the skill's folder.",
    ],
    [
      "no leading `/`",
      "teach",
      [TEACH_MD, file("/etc/x", "")],
      "`teach//etc/x` is not a path inside the skill. Paths must stay inside the skill's folder.",
    ],
    [
      "no empty segment",
      "teach",
      [TEACH_MD, file("a//b", "")],
      "`teach/a//b` is not a path inside the skill. Paths must stay inside the skill's folder.",
    ],
    [
      "no `.` segment",
      "teach",
      [TEACH_MD, file("./a", "")],
      "`teach/./a` is not a path inside the skill. Paths must stay inside the skill's folder.",
    ],
    [
      "no control character",
      "teach",
      [TEACH_MD, file("a\u0007b", "")],
      "`teach/a\\u0007b` has a control character in its path. Rename it without one.",
    ],
    [
      "no path twice",
      "teach",
      [TEACH_MD, file("a.md", ""), file("a.md", "")],
      "`teach/a.md` appears twice in the archive. Each path may appear once.",
    ],
    [
      "no two paths that differ only in case",
      "teach",
      [TEACH_MD, file("Notes.md", ""), file("notes.md", "")],
      "`teach/Notes.md` and `teach/notes.md` differ only in case. Rename one of them.",
    ],
    [
      "no two paths that differ only in Unicode normalization",
      "teach",
      [TEACH_MD, file("café.md", ""), file("café.md", "")],
      "`teach/café.md` and `teach/café.md` name one file on a disk that ignores case, such as macOS's. Rename one of them.",
    ],
    [
      "no file that is a folder of another file",
      "teach",
      [TEACH_MD, file("docs", ""), file("Docs/intro.md", "")],
      "`teach/docs` is a file, and `teach/Docs/intro.md` needs it to be a folder. Rename one of them.",
    ],
    [
      "one spelling per folder",
      "teach",
      [TEACH_MD, file("Docs/a.md", ""), file("docs/b.md", "")],
      "`teach/Docs/a.md` and `teach/docs/b.md` spell one folder two ways. Use one spelling.",
    ],
    [
      "a path that fits a ustar header",
      "teach",
      [TEACH_MD, file(`${"r".repeat(160)}/${"n".repeat(20)}`, "")],
      `\`teach/${"r".repeat(160)}/${"n".repeat(20)}\` is too long for a tar archive. Shorten its folder names or its file name.`,
    ],
  ])("refuses content that breaks the rule: %s", async (_rule, name, entries, issue) => {
    expect(await refuse(name, entries)).toEqual([issue]);
  });

  it.each([
    ["an unresolved alias", "name: teach\ndescription: *nope", "alias", 3],
    [
      "an alias bomb",
      "name: teach\ndescription: Teaches.\na: &a [x, x, x]\nb: &b [*a, *a, *a]\nc: [*b, *b, *b]",
      "anchor",
      4,
    ],
    [
      "hooks that refer to themselves",
      "name: teach\ndescription: Teaches.\nhooks: &x [*x]",
      "anchor",
      4,
    ],
    [
      "a key written as an alias, which could repeat a key unseen",
      "&k name: teach\ndescription: Teaches.\n? *k\n: other",
      "anchor",
      2,
    ],
    [
      "a `!!set`",
      "name: teach\ndescription: Teaches.\nallowed-tools: !!set {Bash, Read}",
      "tag",
      4,
    ],
    ["a `!!binary`", "name: teach\ndescription: !!binary VGVhY2hlcy4=", "tag", 3],
    ["an explicit `!!str`", "name: !!str teach\ndescription: Teaches.", "tag", 2],
  ])("refuses frontmatter with %s", async (_case, frontmatter, kind, line) => {
    expect(await refuse("teach", [skillMd(frontmatter)])).toEqual([
      `\`teach/SKILL.md\` uses a YAML ${kind} at line ${String(line)}. Write each value out in full: anchors, aliases and tags are not allowed in a skill's frontmatter.`,
    ]);
  });

  it("refuses frontmatter with a key that is a list", async () => {
    expect(
      await refuse("teach", [skillMd("name: teach\ndescription: Teaches.\n? [a]\n: b")]),
    ).toEqual([
      "`teach/SKILL.md` has a key that is not text at line 4. Write every key in its frontmatter as plain text.",
    ]);
  });

  it("counts a number key and the same key quoted as one key", async () => {
    expect(
      await refuse("teach", [skillMd('name: teach\ndescription: Teaches.\n1: a\n"1": b')]),
    ).toEqual(["`teach/SKILL.md` has `1` twice in its frontmatter. Each key may appear once."]);
  });

  it("refuses a second `SKILL.md` spelled with a long s", async () => {
    expect(await refuse("teach", [TEACH_MD, file("\u017fKILL.md", "")])).toEqual([
      "`teach/SKILL.md` and `teach/\u017fKILL.md` name one file on a disk that ignores case, such as macOS's. Rename one of them.",
    ]);
  });

  it.each([
    ["a\u03c3.md", "a\u03c2.md"],
    ["stra\u00dfe.md", "STRASSE.md"],
    ["\ufb00.md", "ff.md"],
    ["notes.md", "\ufeffnotes.md"],
    ["notes.md", "no\u200btes.md"],
  ])("refuses `%s` and `%s`, which a disk that ignores case may hold as one file", async (a, b) => {
    expect(await refuse("teach", [TEACH_MD, file(a, ""), file(b, "")])).toEqual([
      `\`teach/${a}\` and \`teach/${b}\` name one file on a disk that ignores case, such as macOS's. Rename one of them.`,
    ]);
  });

  it("does not check the paths of content with more files than the cap", async () => {
    expect(
      await refuse("teach", [
        TEACH_MD,
        ...Array.from({ length: 1001 }, (_, index) => file(`a/${String(index)}`, "")),
        file("A/x", ""),
      ]),
    ).toEqual([
      "`teach` has 1,003 files. A skill holds at most 1,000; remove the files it does not need.",
    ]);
  });

  it("accepts a long path that splits into a ustar prefix and name", async () => {
    const path = `${"r".repeat(150)}/${"n".repeat(90)}`;
    expect((await check("teach", [TEACH_MD, file(path, "")])).files.map((f) => f.path)).toContain(
      path,
    );
  });

  it("reports one folder spelled two ways once, not once per file below it", async () => {
    expect(
      await refuse("teach", [
        TEACH_MD,
        file("Docs/a.md", ""),
        file("docs/b.md", ""),
        file("docs/c.md", ""),
      ]),
    ).toEqual([
      "`teach/Docs/a.md` and `teach/docs/b.md` spell one folder two ways. Use one spelling.",
    ]);
  });

  it("lists every broken rule at once", async () => {
    expect(
      await refuse("teach", [
        skillMd("name: teaching\nallowed-tools: Read\nallowed-tools: Bash"),
        file("run.sh", "", 0o700),
        file("../x", ""),
        { path: "notes", kind: "symlink", mode: 0o777, content: new Uint8Array() },
      ]),
    ).toEqual([
      "`teach/SKILL.md` has `allowed-tools` twice in its frontmatter. Each key may appear once.",
      "`teach/SKILL.md` has `name: teaching`. A skill's name must match its folder name; rename the folder or the name.",
      "`teach/SKILL.md` has no `description`. Add one to its frontmatter: the agent reads it to decide when to use the skill.",
      "`teach/notes` is a symbolic link. A skill archive holds only files and folders; read the folder with `hercule skill import` or the desktop app, which put a link's target in the archive when the target is inside the skill's folder.",
      "`teach/run.sh` has mode `700`. A file's mode must be `644` or `755`.",
      "`teach/../x` is not a path inside the skill. Paths must stay inside the skill's folder.",
    ]);
  });

  it("reads the frontmatter of a SKILL.md that is too large, so its issues are listed too", async () => {
    expect(
      await refuse("teach", [
        skillMd("name: teaching\ndescription: x", "x".repeat(1.95 * 1024 * 1024)),
      ]),
    ).toEqual([
      "`teach/SKILL.md` has `name: teaching`. A skill's name must match its folder name; rename the folder or the name.",
      "`teach/SKILL.md` is 2.0 MiB. A `SKILL.md` may be at most 1 MiB; move long material into files beside it.",
    ]);
  });

  describe("the 10 MiB cap on the archive as built", () => {
    /**
     * Returns the entries of an upload of a skill with a small `SKILL.md` and
     * a file of `dataBytes` bytes, sent without the two zero blocks that end
     * the archive, and the upload's length.
     */
    const readUploadWithoutEndBlocks = async (dataBytes: number) => {
      const built = await Effect.runPromise(
        buildSkillArchive([
          { path: "SKILL.md", mode: "644", content: TEACH_MD.content },
          { path: "data.bin", mode: "644", content: new Uint8Array(dataBytes) },
        ]),
      );
      const upload = built.subarray(0, built.byteLength - 1024);
      return {
        uploadBytes: upload.byteLength,
        entries: await Effect.runPromise(readSkillArchive(upload)),
      };
    };

    it("refuses an upload of exactly 10 MiB whose archive as built is larger", async () => {
      // The upload holds 1,536 bytes besides the data: a header and a block
      // for SKILL.md, and a header for data.bin. The archive as built adds
      // the 1,024 bytes of the two end blocks.
      const { uploadBytes, entries } = await readUploadWithoutEndBlocks(MAX_SKILL_BYTES - 1536);
      expect(uploadBytes).toBe(MAX_SKILL_BYTES);
      expect(await refuse("teach", entries)).toEqual([
        "`teach` is 10.1 MiB as a tar archive. A skill's archive may be at most 10 MiB; remove the files it does not need, or make them smaller.",
      ]);
    });

    it("passes a skill whose archive as built is exactly 10 MiB", async () => {
      const { entries } = await readUploadWithoutEndBlocks(MAX_SKILL_BYTES - 2560);
      await expect(check("teach", entries)).resolves.toMatchObject({ description: "Teaches." });
    });
  });
});
