/**
 * Tests Settings > Skills: the list with the built-in skill first, the empty
 * library, a skill's page, Delete, Import from a folder through each of its
 * steps, Upload new version, and updates: the badges, Check now, Update,
 * What it changes and Update all. Each test counts the reads it sends: the
 * section reads again on its own writes and on the `skill` topic's pushes,
 * and never on a timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { notifyManager } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { Skill, SkillApplyUpdatesInput, SkillDetail, SkillRevision } from "@hercule/contract";
import type {
  SkillArchiveBuildOutcome,
  SkillFoldersPickOutcome,
} from "../../../../../../ipc/contract";
import { forgetLastSettingsSection } from "../../../../../app/last-settings-section";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  holdAnswer,
  refuseConnection,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Answer,
  type Call,
  type Handler,
} from "../../../../../app/testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

// The sidebar's thread list draws only the rows that fit its height.
beforeEach(() => {
  stubElementSize(272, 800);
});

afterEach(forgetLastSettingsSection);

const LIST_PATH = "/settings/skills";

const buildSkill = (over: Partial<Skill> & Pick<Skill, "name">): Skill => ({
  source: { kind: "upload" },
  currentRevisionHash: "a".repeat(64),
  currentApprovalEffects: null,
  currentFileCount: 2,
  currentSizeBytes: 6656,
  availableRevisionHash: null,
  availableApprovalEffects: null,
  proposedCount: 0,
  lastCheckedAt: null,
  checkError: null,
  createdAt: "2026-09-28T10:15:00.000Z",
  createdBy: "user",
  updatedAt: "2026-09-28T10:15:00.000Z",
  updatedBy: "user",
  ...over,
});

const buildRevision = (over: Partial<SkillRevision> & Pick<SkillRevision, "revisionHash">) => ({
  origin: "import" as const,
  fileCount: 2,
  sizeBytes: 6656,
  description: "Grills you about a plan until it holds.",
  createdAt: "2026-09-28T10:15:00.000Z",
  createdBy: "user" as const,
  appliedAt: "2026-09-28T10:15:00.000Z",
  appliedBy: "user" as const,
  includesThirdPartyContent: false,
  ...over,
});

const GRILLING = buildSkill({
  name: "grilling",
  source: { kind: "github", repo: "mattpocock/skills", path: "skills/grilling", branch: null },
  currentRevisionHash: "c".repeat(64),
  currentApprovalEffects: { allowedTools: "Bash(git:*) Read", hooks: "{}" },
});
const TEACH = buildSkill({ name: "teach", currentFileCount: 1, currentSizeBytes: 812 });

const GRILLING_DETAIL: SkillDetail = {
  skill: GRILLING,
  files: [
    { path: "SKILL.md", mode: "644", sizeBytes: 2150 },
    { path: "scripts/run.sh", mode: "755", sizeBytes: 4506 },
  ],
  skillMd: [
    "---",
    "name: grilling",
    "description: Grills you about a plan until it holds.",
    "---",
    "## Steps",
    "",
    "Read [the reference](reference.md), then [the docs](https://example.com/docs).",
  ].join("\n"),
  history: [
    buildRevision({ revisionHash: "c".repeat(64), appliedAt: "2026-09-29T10:15:00.000Z" }),
    buildRevision({
      revisionHash: "d".repeat(64),
      description: "An older description.",
      appliedAt: "2026-09-28T10:15:00.000Z",
    }),
  ],
  availableRevision: null,
  proposedRevisions: [],
};

/** Returns the bytes main hands over as `name`'s archive in these tests. */
const buildArchive = (name: string): SkillArchiveBuildOutcome => ({
  _tag: "Archive",
  // Built from char codes rather than with TextEncoder, whose array comes from
  // Node's realm and fails the client's `instanceof Uint8Array` under jsdom.
  archive: Uint8Array.from(`tar of ${name}`, (char) => char.charCodeAt(0)),
});

/** Returns the `Picked` answer for `~/.agents/skills` holding `skills`. */
const buildPicked = (
  skills: Extract<SkillFoldersPickOutcome, { _tag: "Picked" }>["skills"],
  lockFileProblem: string | null = null,
): SkillFoldersPickOutcome => ({
  _tag: "Picked",
  displayPath: "~/.agents/skills",
  lockFileProblem,
  skills,
});

interface OpenOptions {
  readonly handlers?: Readonly<Record<string, Handler>>;
  readonly skills?: ReadonlyArray<Skill>;
  readonly pickSkillFolders?: () => Promise<SkillFoldersPickOutcome>;
  readonly buildSkillArchive?: (name: string) => Promise<SkillArchiveBuildOutcome>;
}

/** Opens the app at `path`, with `skills` in the library, and `handlers` on top. */
const openAt = async (path: string, options: OpenOptions = {}) => {
  const { handlers = {}, skills = [GRILLING, TEACH], ...bridge } = options;
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/skills": { body: { items: skills } },
    "GET /api/v1/skills/grilling": { body: GRILLING_DETAIL },
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer", ...bridge });
  const app = await renderApp(fake, { path });
  // The reads the controller's first push on each topic causes, the `skill`
  // topic's among them, are not the test's own.
  await app.live.waitForFirstPushes();
  return { calls, fake, ...app };
};

const openList = async (options: OpenOptions = {}) => {
  const app = await openAt(LIST_PATH, options);
  await screen.findByRole("heading", { level: 1, name: "Skills" });
  return app;
};

const openGrilling = async (options: OpenOptions = {}) => {
  const app = await openAt(`${LIST_PATH}/grilling`, options);
  await screen.findByRole("heading", { level: 1, name: "grilling" });
  return app;
};

/** Counts the reads of the list among `calls`. */
const countListReads = (calls: readonly Call[]): number =>
  calls.filter((call) => call.method === "GET" && call.path === "/api/v1/skills").length;

/** Returns the imports among `calls`, each as its query and its archive's text. */
const listImports = (calls: readonly Call[]) =>
  calls
    .filter((call) => call.method === "POST" && call.path === "/api/v1/skills/import")
    .map((call) => ({
      query: Object.fromEntries(new URLSearchParams(call.search)),
      archive: call.body,
    }));

/** Returns an import's answer for `name`: `result`, with the skill as now stored. */
const answerImport = (name: string, result: "created" | "revised" | "unchanged"): Answer => ({
  body: { result, skill: buildSkill({ name }) },
});

/** Returns the handler of `skill.import` that answers each name from `answers`. */
const answerImports =
  (answers: Readonly<Record<string, (call: Call) => Answer>>) =>
  (call: Call): Answer => {
    const name = new URLSearchParams(call.search).get("name")!;
    return answers[name]!(call);
  };

describe("Settings > Skills, the list", () => {
  it("draws the lead, the banner, the built-in skill, then one row per skill", async () => {
    const { calls } = await openList();

    expect(screen.getByText(/A skill is a folder of instructions/)).toBeTruthy();
    expect(screen.getByText("Codex and pi Threads don't use the library yet.")).toBeTruthy();
    const table = screen.getByRole("region", { name: "Skills" });
    const rows = [...table.querySelectorAll(".skill-row")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "herculeBuilt in",
      "grillingGitHub: mattpocock/skills2 files · 6.5 KiB",
      "teachUploaded1 file · 812 B",
    ]);
    // The built-in skill has no page.
    expect(rows[0]!.tagName).toBe("DIV");
    expect(within(table).getAllByRole("link")).toHaveLength(2);
    // Once on open, and once more on the `skill` topic's first push, which
    // says that any skill may have changed before the subscription.
    expect(countListReads(calls)).toBe(2);
  });

  it("shows the empty block under the built-in row while the library is empty", async () => {
    const { fake } = await openList({ skills: [] });

    expect(screen.getByText("No skills yet")).toBeTruthy();
    expect(screen.getByText("~/.agents/skills")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Import from a folder" });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1]!);

    // The fake folder dialog is cancelled, which does nothing.
    expect(fake.skillArchiveBuilds).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens a skill's page from its row", async () => {
    const { router } = await openList();

    await userEvent.click(screen.getByRole("link", { name: /grilling/ }));

    expect(await screen.findByRole("heading", { level: 1, name: "grilling" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`${LIST_PATH}/grilling`);
  });
});

describe("Settings > Skills, a skill's page", () => {
  it("draws the lead, the warnings, SKILL.md without frontmatter, the files and the History", async () => {
    const { calls } = await openGrilling();

    expect(screen.getByText("Grills you about a plan until it holds.")).toBeTruthy();
    expect(screen.getByText("mattpocock/skills · skills/grilling")).toBeTruthy();
    expect(screen.getAllByText("2 files · 6.5 KiB").length).toBeGreaterThan(0);
    const warning = screen.getByText(/Lets tools run without asking:/);
    expect([...warning.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      "Bash(git:*)",
      "Read",
    ]);
    expect(screen.getByText("Has hooks, which run without asking")).toBeTruthy();

    expect(screen.queryByText(/name: grilling/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Steps" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "the reference" })).toBeNull();
    expect(screen.getByText(/^Read the reference, then/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "the docs" })).toBeTruthy();

    const files = [...document.querySelectorAll(".skill-file")].map((row) => row.textContent);
    expect(files).toEqual(["SKILL.md2.1 KiB", "scripts/run.shExecutable4.4 KiB"]);

    const history = [...document.querySelectorAll(".skill-rev")];
    expect(history).toHaveLength(2);
    expect(history[0]!.textContent).toMatch(/Importedapplied by you, 29 Sep 10:15Currentccccccc$/);
    expect(history[1]!.textContent).toMatch(/Importedapplied by you, 28 Sep 10:15ddddddd$/);
    // Once on open, and once more on the `skill` topic's first push.
    expect(
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/skills/grilling"),
    ).toHaveLength(2);
  });

  it("goes back to the list for a name that names no skill", async () => {
    const { router } = await openAt(`${LIST_PATH}/gone`);

    expect(await screen.findByRole("heading", { level: 1, name: "Skills" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(LIST_PATH);
  });
});

describe("Settings > Skills, Delete", () => {
  it("asks first, deletes, and goes to the list, which no longer has the skill", async () => {
    let skills = [GRILLING, TEACH];
    const { calls, router } = await openGrilling({
      handlers: {
        "GET /api/v1/skills": () => ({ body: { items: skills } }),
        "DELETE /api/v1/skills/grilling": () => {
          skills = [TEACH];
          return { body: {} };
        },
      },
    });

    // The library does not reach Threads yet, so neither line speaks of them.
    expect(screen.getByText("Deletes it and all its revisions.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete skill" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete grilling?" });
    expect([...dialog.querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "This deletes grilling and all its revisions. This cannot be undone.",
    ]);
    // A stray Enter must not delete.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    const readsBefore = countListReads(calls);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Skills" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(LIST_PATH);
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /grilling/ })).toBeNull();
    });
    expect(countListReads(calls)).toBe(readsBefore + 1);
  });

  it("keeps a refusal in the confirmation", async () => {
    await openGrilling({
      handlers: {
        "DELETE /api/v1/skills/grilling": {
          status: 404,
          body: buildErrorBody("not_found", "No skill is named grilling."),
        },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Delete skill" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete grilling?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Could not delete: No skill is named grilling.",
    );
    expect(screen.getByRole("dialog", { name: "Delete grilling?" })).toBeTruthy();
  });
});

describe("Settings > Skills, Import from a folder", () => {
  it("shows why the folder could not be read under the header", async () => {
    await openList({
      pickSkillFolders: () =>
        Promise.resolve({ _tag: "Unreadable", reason: "~/secret cannot be read." }),
    });

    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));

    expect((await screen.findByRole("alert")).textContent).toBe("~/secret cannot be read.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a folder with no skill, and only Done", async () => {
    await openList({ pickSkillFolders: () => Promise.resolve(buildPicked([])) });

    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));

    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });
    expect(dialog.textContent).toContain(
      "No skills in ~/.agents/skills. A skill is a folder that holds a SKILL.md.",
    );
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Done"]);
  });

  it("imports the checked skills one at a time, with their sources, and ends on a summary", async () => {
    const { calls, fake } = await openList({
      pickSkillFolders: () =>
        Promise.resolve(
          buildPicked(
            [
              { name: "grilling", source: { repo: "mattpocock/skills", path: "skills/grilling" } },
              { name: "notes", source: null },
              { name: "teach", source: null },
            ],
            "The lock file ~/.agents/.skill-lock.json is not valid JSON.",
          ),
        ),
      buildSkillArchive: (name) => Promise.resolve(buildArchive(name)),
      handlers: {
        "POST /api/v1/skills/import": answerImports({
          grilling: () => answerImport("grilling", "revised"),
          teach: () => answerImport("teach", "unchanged"),
        }),
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });
    expect(within(dialog).getByText("3 skills")).toBeTruthy();
    expect(
      within(dialog).getByText("The lock file ~/.agents/.skill-lock.json is not valid JSON."),
    ).toBeTruthy();
    expect([...dialog.querySelectorAll(".skill-import-row")].map((row) => row.textContent)).toEqual(
      ["grillingGitHub: mattpocock/skills", "notesUploaded", "teachUploaded"],
    );
    expect(
      within(dialog)
        .getAllByRole("checkbox")
        .every((box) => (box as HTMLInputElement).checked),
    ).toBe(true);
    await userEvent.click(within(dialog).getAllByRole("checkbox")[1]!);
    expect(within(dialog).getByText("2 of 3 selected")).toBeTruthy();
    const readsBefore = countListReads(calls);

    await userEvent.click(within(dialog).getByRole("button", { name: "Import 2" }));

    expect(await within(dialog).findByText("Imported 1, 1 unchanged, 0 refused")).toBeTruthy();
    expect(fake.skillArchiveBuilds).toEqual(["grilling", "teach"]);
    expect(listImports(calls)).toEqual([
      {
        query: {
          name: "grilling",
          sourceRepo: "mattpocock/skills",
          sourcePath: "skills/grilling",
        },
        archive: "tar of grilling",
      },
      { query: { name: "teach" }, archive: "tar of teach" },
    ]);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Done" }));
    expect(countListReads(calls)).toBe(readsBefore + 1);
  });

  it("builds the next archive only once the controller has answered the last import", async () => {
    const held = holdAnswer();
    const { calls, fake } = await openList({
      pickSkillFolders: () =>
        Promise.resolve(
          buildPicked([
            { name: "grilling", source: null },
            { name: "teach", source: null },
          ]),
        ),
      buildSkillArchive: (name) => Promise.resolve(buildArchive(name)),
      handlers: {
        "POST /api/v1/skills/import": (call) =>
          new URLSearchParams(call.search).get("name") === "grilling"
            ? held.handler()
            : answerImport("teach", "created"),
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Import 2" }));

    expect(await within(dialog).findByText("Importing 1 of 2")).toBeTruthy();
    await waitFor(() => {
      expect(listImports(calls)).toHaveLength(1);
    });
    expect(fake.skillArchiveBuilds).toEqual(["grilling"]);
    held.answer(answerImport("grilling", "created"));

    expect(await within(dialog).findByText("Imported 2, 0 unchanged, 0 refused")).toBeTruthy();
    expect(fake.skillArchiveBuilds).toEqual(["grilling", "teach"]);
  });

  it("starts one pass for two clicks that land before the import shows as running", async () => {
    const { calls, fake } = await openList({
      pickSkillFolders: () => Promise.resolve(buildPicked([{ name: "grilling", source: null }])),
      buildSkillArchive: (name) => Promise.resolve(buildArchive(name)),
      handlers: { "POST /api/v1/skills/import": () => answerImport("grilling", "created") },
    });
    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });
    const importButton = within(dialog).getByRole("button", { name: "Import 1" });

    // Query reports the mutation as pending on a later task. Holding its
    // notifications keeps the Import button drawn for the second click.
    const notifications: Array<() => void> = [];
    notifyManager.setScheduler((notify) => {
      notifications.push(notify);
    });
    try {
      fireEvent.click(importButton);
      fireEvent.click(importButton);
    } finally {
      notifyManager.setScheduler((notify) => setTimeout(notify, 0));
    }
    act(() => {
      for (const notify of notifications) notify();
    });

    expect(await within(dialog).findByText("Imported 1, 0 unchanged, 0 refused")).toBeTruthy();
    expect(fake.skillArchiveBuilds).toEqual(["grilling"]);
    expect(listImports(calls)).toHaveLength(1);
  });

  it("marks each refused skill under its row, sends none of main's refusals, and goes on", async () => {
    const { calls } = await openList({
      pickSkillFolders: () =>
        Promise.resolve(
          buildPicked([
            { name: "big", source: null },
            { name: "broken", source: null },
            { name: "link", source: null },
            { name: "teach", source: null },
          ]),
        ),
      buildSkillArchive: (name) =>
        Promise.resolve(
          name === "big"
            ? { _tag: "TooLarge" }
            : name === "link"
              ? { _tag: "Unreadable", reason: "link/out points outside the skill." }
              : buildArchive(name),
        ),
      handlers: {
        "POST /api/v1/skills/import": answerImports({
          broken: () => ({
            status: 400,
            body: buildErrorBody("validation", "`SKILL.md` has no `description`."),
          }),
          teach: () => answerImport("teach", "created"),
        }),
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Import 4" }));

    expect(await within(dialog).findByText("Imported 1, 0 unchanged, 3 refused")).toBeTruthy();
    expect(listImports(calls).map(({ query }) => query.name)).toEqual(["broken", "teach"]);
    const refused = [...dialog.querySelectorAll(".skill-import-row.is-refused")];
    expect(refused.map((row) => row.textContent)).toEqual([
      "bigbig is over 10 MiB, the most a skill can hold.",
      "brokenSKILL.md has no description.",
      "linklink/out points outside the skill.",
    ]);
    expect(refused[1]!.querySelectorAll("code")).toHaveLength(2);
  });

  it("asks about skills that exist with other content, and resends the confirmed ones with replace", async () => {
    const { calls, fake } = await openList({
      pickSkillFolders: () =>
        Promise.resolve(
          buildPicked([
            { name: "grilling", source: { repo: "mattpocock/skills", path: "skills/grilling" } },
            { name: "notes", source: null },
            { name: "teach", source: null },
          ]),
        ),
      buildSkillArchive: (name) => Promise.resolve(buildArchive(name)),
      handlers: {
        "POST /api/v1/skills/import": (call) => {
          const query = new URLSearchParams(call.search);
          const name = query.get("name")!;
          if (name === "notes") return answerImport("notes", "created");
          if (query.get("replace") === "true") return answerImport(name, "revised");
          return {
            status: 409,
            body: buildErrorBody("conflict", `${name} exists with other content.`),
          };
        },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Import 3" }));

    await within(dialog).findByRole("button", { name: "Import as new revisions" });
    expect([...dialog.querySelectorAll(".skill-import-row")].map((row) => row.textContent)).toEqual(
      ["grilling exists with different content.", "teach exists with different content."],
    );
    const readsBefore = countListReads(calls);
    // Leave teach as it is.
    await userEvent.click(within(dialog).getAllByRole("checkbox")[1]!);
    await userEvent.click(within(dialog).getByRole("button", { name: "Import as new revisions" }));

    expect(
      await within(dialog).findByText("Imported 2, 0 unchanged, 0 refused, 1 skipped"),
    ).toBeTruthy();
    expect(fake.skillArchiveBuilds).toEqual(["grilling", "notes", "teach", "grilling"]);
    expect(listImports(calls).at(-1)).toEqual({
      query: {
        name: "grilling",
        replace: "true",
        sourceRepo: "mattpocock/skills",
        sourcePath: "skills/grilling",
      },
      archive: "tar of grilling",
    });
    expect(countListReads(calls)).toBe(readsBefore + 1);
  });

  it("leaves every conflicting skill as it is on Skip", async () => {
    const { calls } = await openList({
      pickSkillFolders: () => Promise.resolve(buildPicked([{ name: "grilling", source: null }])),
      buildSkillArchive: (name) => Promise.resolve(buildArchive(name)),
      handlers: {
        "POST /api/v1/skills/import": {
          status: 409,
          body: buildErrorBody("conflict", "grilling exists with other content."),
        },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Import 1" }));

    await userEvent.click(await within(dialog).findByRole("button", { name: "Skip" }));

    expect(within(dialog).getByText("Imported 0, 0 unchanged, 0 refused, 1 skipped")).toBeTruthy();
    expect(listImports(calls)).toHaveLength(1);
  });

  it("keeps every conflict's row while the confirmed ones import again", async () => {
    const held = holdAnswer();
    const { calls } = await openList({
      pickSkillFolders: () =>
        Promise.resolve(
          buildPicked([
            { name: "grilling", source: null },
            { name: "teach", source: null },
          ]),
        ),
      buildSkillArchive: (name) => Promise.resolve(buildArchive(name)),
      handlers: {
        "POST /api/v1/skills/import": (call) => {
          const query = new URLSearchParams(call.search);
          const name = query.get("name")!;
          if (query.get("replace") !== "true")
            return { status: 409, body: buildErrorBody("conflict", `${name} differs.`) };
          return name === "teach" ? held.handler() : answerImport(name, "revised");
        },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Import 2" }));
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Import as new revisions" }),
    );

    // grilling has been imported again and teach is on its way: both rows stay.
    expect(await within(dialog).findByText("Importing 2 of 2")).toBeTruthy();
    await waitFor(() => {
      expect(listImports(calls)).toHaveLength(4);
    });
    expect([...dialog.querySelectorAll(".skill-import-row")].map((row) => row.textContent)).toEqual(
      ["grilling exists with different content.", "teach exists with different content."],
    );
    held.answer(answerImport("teach", "revised"));

    expect(await within(dialog).findByText("Imported 2, 0 unchanged, 0 refused")).toBeTruthy();
  });

  it.each([
    {
      stop: "a controller that cannot be reached",
      answer: refuseConnection,
      line: /^The import stopped at teach: cannot reach /,
    },
    {
      stop: "a refused credential",
      answer: (): Answer => ({
        status: 403,
        body: {
          error: {
            code: "forbidden",
            message: "You lack skill.write.",
            details: { grant: "skill.write" },
          },
        },
      }),
      line: /^The import stopped at teach: You lack skill\.write\.$/,
    },
  ])("stops at $stop, keeps the rows before it, and shows the error once", async (example) => {
    const { calls, fake } = await openList({
      pickSkillFolders: () =>
        Promise.resolve(
          buildPicked([
            { name: "broken", source: null },
            { name: "teach", source: null },
            { name: "triage", source: null },
          ]),
        ),
      buildSkillArchive: (name) => Promise.resolve(buildArchive(name)),
      handlers: {
        "POST /api/v1/skills/import": answerImports({
          broken: () => ({
            status: 400,
            body: buildErrorBody("validation", "`SKILL.md` has no `description`."),
          }),
          teach: example.answer,
          triage: () => answerImport("triage", "created"),
        }),
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });
    const readsBefore = countListReads(calls);

    await userEvent.click(within(dialog).getByRole("button", { name: "Import 3" }));

    expect((await within(dialog).findByRole("alert")).textContent).toMatch(example.line);
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
    expect(fake.skillArchiveBuilds).toEqual(["broken", "teach"]);
    expect(listImports(calls).map(({ query }) => query.name)).toEqual(["broken", "teach"]);
    expect([...dialog.querySelectorAll(".skill-import-row")].map((row) => row.textContent)).toEqual(
      ["brokenSKILL.md has no description.", "teachUploaded", "triageUploaded"],
    );
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(countListReads(calls)).toBe(readsBefore + 1);
    });
  });

  it("stops where main refuses to build an archive, and shows why", async () => {
    const { calls } = await openList({
      pickSkillFolders: () => Promise.resolve(buildPicked([{ name: "teach", source: null }])),
      buildSkillArchive: () => Promise.reject(new Error("A build is already running.")),
    });
    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Import 1" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "The import stopped at teach: A build is already running.",
    );
    expect(listImports(calls)).toEqual([]);
  });

  it("stops after the skill being sent when the dialog closes, and reads the list again", async () => {
    const held = holdAnswer();
    const { calls, fake } = await openList({
      pickSkillFolders: () =>
        Promise.resolve(
          buildPicked([
            { name: "grilling", source: null },
            { name: "teach", source: null },
          ]),
        ),
      buildSkillArchive: (name) => Promise.resolve(buildArchive(name)),
      handlers: { "POST /api/v1/skills/import": held.handler },
    });
    await userEvent.click(screen.getByRole("button", { name: "Import from a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Import from ~/.agents/skills" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Import 2" }));
    await waitFor(() => {
      expect(listImports(calls)).toHaveLength(1);
    });
    const readsBefore = countListReads(calls);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    held.answer(answerImport("grilling", "created"));

    await waitFor(() => {
      expect(countListReads(calls)).toBe(readsBefore + 1);
    });
    expect(fake.skillArchiveBuilds).toEqual(["grilling"]);
    expect(listImports(calls)).toHaveLength(1);
  });
});

describe("Settings > Skills, Upload new version", () => {
  it("refuses a folder that holds another skill, and uploads nothing", async () => {
    const { fake } = await openGrilling({
      pickSkillFolders: () => Promise.resolve(buildPicked([{ name: "teaching", source: null }])),
    });

    await userEvent.click(screen.getByRole("button", { name: "Upload new version" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The folder holds teaching, not grilling.",
    );
    expect(fake.skillArchiveBuilds).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks first for a skill from GitHub, then sends it with replace and no source", async () => {
    const { calls } = await openGrilling({
      pickSkillFolders: () => Promise.resolve(buildPicked([{ name: "grilling", source: null }])),
      buildSkillArchive: (name) => Promise.resolve(buildArchive(name)),
      handlers: { "POST /api/v1/skills/import": answerImport("grilling", "revised") },
    });
    const readsBefore = calls.filter((call) => call.path === "/api/v1/skills/grilling").length;

    await userEvent.click(screen.getByRole("button", { name: "Upload new version" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Upload a new version of grilling?",
    });
    expect(dialog.textContent).toContain(
      'grilling comes from GitHub: mattpocock/skills. After the upload its source is "Uploaded", so Hercule stops checking it for updates.',
    );
    expect(listImports(calls)).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Upload" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(listImports(calls)).toEqual([
      { query: { name: "grilling", replace: "true" }, archive: "tar of grilling" },
    ]);
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/v1/skills/grilling")).toHaveLength(
        readsBefore + 1,
      );
    });
  });

  it("uploads an uploaded skill without asking, and says when nothing changed", async () => {
    const teach: SkillDetail = {
      ...GRILLING_DETAIL,
      skill: TEACH,
      history: [buildRevision({ revisionHash: TEACH.currentRevisionHash! })],
    };
    const { calls } = await openAt(`${LIST_PATH}/teach`, {
      pickSkillFolders: () => Promise.resolve(buildPicked([{ name: "teach", source: null }])),
      buildSkillArchive: (name) => Promise.resolve(buildArchive(name)),
      handlers: {
        "GET /api/v1/skills/teach": { body: teach },
        "POST /api/v1/skills/import": answerImport("teach", "unchanged"),
      },
    });
    await screen.findByRole("heading", { level: 1, name: "teach" });

    await userEvent.click(screen.getByRole("button", { name: "Upload new version" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "No new revision: these files are the current revision.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(listImports(calls)).toEqual([
      { query: { name: "teach", replace: "true" }, archive: "tar of teach" },
    ]);
  });

  it("shows main's refusal under the header", async () => {
    const teach: SkillDetail = { ...GRILLING_DETAIL, skill: TEACH };
    const { calls } = await openAt(`${LIST_PATH}/teach`, {
      pickSkillFolders: () => Promise.resolve(buildPicked([{ name: "teach", source: null }])),
      buildSkillArchive: () => Promise.resolve({ _tag: "TooLarge" }),
      handlers: { "GET /api/v1/skills/teach": { body: teach } },
    });
    await screen.findByRole("heading", { level: 1, name: "teach" });

    await userEvent.click(screen.getByRole("button", { name: "Upload new version" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Not uploaded: teach is over 10 MiB, the most a skill can hold.",
    );
    expect(listImports(calls)).toEqual([]);
  });
});

describe("Settings > Skills, updates", () => {
  const UPDATE = "e".repeat(64);
  const NEWER = "f".repeat(64);
  const GITHUB = {
    kind: "github",
    repo: "mattpocock/skills",
    path: "skills/x",
    branch: null,
  } as const;
  // The update keeps grilling's hooks, so it may change approvals although
  // its approval effects are the current revision's.
  const GRILLING_UPDATED: Skill = {
    ...GRILLING,
    availableRevisionHash: UPDATE,
    availableApprovalEffects: GRILLING.currentApprovalEffects,
  };
  const REVIEW = buildSkill({ name: "code-review", source: GITHUB, availableRevisionHash: UPDATE });
  const FAILED = buildSkill({
    name: "triage",
    source: GITHUB,
    checkError: "GitHub has no folder `skills/x` in mattpocock/skills.",
  });

  const DIFF_PATH = `/api/v1/skills/grilling/revisions/${UPDATE}/diff`;
  const GRILLING_DIFF = {
    approvalEffects: { allowedTools: "Bash(git:*) Read", hooks: "{}" },
    files: [
      {
        path: "SKILL.md",
        change: "modified",
        mode: "644",
        patch: "@@ -1,2 +1,2 @@\n ## Steps\n-Ask once.\n+Ask until it holds.\n",
        patchOmitted: null,
      },
      { path: "big.md", change: "added", mode: "644", patch: null, patchOmitted: "tooLarge" },
      { path: "logo.png", change: "added", mode: "644", patch: null, patchOmitted: "binary" },
      { path: "scripts/run.sh", change: "modeChanged", mode: "755", patch: "", patchOmitted: null },
    ],
  };

  /** Opens grilling's page with an update waiting, and `handlers` on top. */
  const openUpdatedGrilling = (handlers: Readonly<Record<string, Handler>> = {}) =>
    openGrilling({
      skills: [GRILLING_UPDATED],
      handlers: {
        "GET /api/v1/skills/grilling": {
          body: { ...GRILLING_DETAIL, skill: GRILLING_UPDATED },
        },
        [`GET ${DIFF_PATH}`]: { body: GRILLING_DIFF },
        ...handlers,
      },
    });

  const countReads = (calls: readonly Call[], path: string): number =>
    calls.filter((call) => call.method === "GET" && call.path === path).length;

  it("badges each update by whether it may change approvals, and a failed check with its error", async () => {
    await openList({ skills: [REVIEW, GRILLING_UPDATED, FAILED, TEACH] });

    const rows = [...document.querySelectorAll<HTMLElement>("a.skill-row")];
    const badges = rows.map((row) =>
      [...row.querySelectorAll(".skill-badges > *")].map((badge) => badge.textContent),
    );
    expect(badges).toEqual([
      ["Update available"],
      ["Update may change approvals"],
      ["Check failed"],
      [],
    ]);
    expect(screen.getByText("Check failed").title).toBe(FAILED.checkError);
    expect(rows.map((row) => row.classList.contains("is-fail"))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    const header = document.querySelector(".bar-actions")!;
    expect([...header.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Check now",
      "Update all 2",
      "Import from a folder",
    ]);
  });

  it("checks every GitHub skill on Check now, and reads the list again", async () => {
    const { calls } = await openList({
      handlers: { "POST /api/v1/skills/check": { body: {} } },
    });
    const readsBefore = countListReads(calls);

    await userEvent.click(screen.getByRole("button", { name: "Check now" }));

    await waitFor(() => {
      expect(countListReads(calls)).toBe(readsBefore + 1);
    });
    const checks = calls.filter((call) => call.path === "/api/v1/skills/check");
    expect(checks.map((call) => call.body)).toEqual([{}]);
  });

  it("offers no Check now while no skill comes from GitHub", async () => {
    await openList({ skills: [TEACH] });

    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Update all/ })).toBeNull();
  });

  it("shows when the skill was checked, checks it on Check now, and shows a failed check", async () => {
    const checked = {
      ...GRILLING,
      lastCheckedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000).toISOString(),
      checkError: "GitHub answered 403: rate limited.",
    };
    const { calls } = await openGrilling({
      skills: [checked],
      handlers: {
        "GET /api/v1/skills/grilling": { body: { ...GRILLING_DETAIL, skill: checked } },
        "POST /api/v1/skills/check": { body: {} },
      },
    });

    const header = document.querySelector(".bar-actions")!;
    expect(header.textContent).toBe("Checked 2 hours agoCheck nowUpload new version");
    expect(screen.getByText(/^Last check failed:/).textContent).toBe(
      "Last check failed: GitHub answered 403: rate limited.",
    );

    await userEvent.click(screen.getByRole("button", { name: "Check now" }));

    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/v1/skills/check")).toHaveLength(1);
    });
    expect(calls.find((call) => call.path === "/api/v1/skills/check")!.body).toEqual({
      name: "grilling",
    });
  });

  it("shows what the update changes, read once, then applies it on Update", async () => {
    const applyPath = `/api/v1/skills/grilling/revisions/${UPDATE}/apply`;
    const { calls } = await openUpdatedGrilling({
      [`POST ${applyPath}`]: { body: GRILLING },
    });

    expect(
      screen.getByText(
        "Update available from mattpocock/skills. Nothing changes until you update.",
      ),
    ).toBeTruthy();
    const section = screen.getByRole("heading", { name: "What it changes" }).parentElement!;
    const warning = within(section).getByText(/^After the update, lets tools run without asking:/);
    expect([...warning.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      "Bash(git:*)",
      "Read",
    ]);
    expect(
      within(section).getByText("After the update, has hooks, which run without asking"),
    ).toBeTruthy();
    expect(section.querySelector(".skill-changes-head")!.textContent).toBe("4 changed files+1-1");
    expect(
      [...section.querySelectorAll(".skill-changes-row")].map((row) => row.textContent),
    ).toEqual([
      "SKILL.mdModified+1-1",
      "big.mdAddedToo large to show",
      "logo.pngAddedBinary file",
      "scripts/run.shNow executable",
    ]);
    expect(
      [...section.querySelectorAll(".skill-patch > span")].map((line) => [
        line.className,
        line.textContent,
      ]),
    ).toEqual([
      ["is-hunk", "@@ -1,2 +1,2 @@\n"],
      ["", " ## Steps\n"],
      ["is-removed", "-Ask once.\n"],
      ["is-added", "+Ask until it holds.\n"],
    ]);
    const readsBefore = countReads(calls, "/api/v1/skills/grilling");

    await userEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(countReads(calls, "/api/v1/skills/grilling")).toBe(readsBefore + 1);
    });
    expect(calls.filter((call) => call.path === applyPath)).toHaveLength(1);
    // The diff of one revision never changes, so nothing reads it again.
    expect(countReads(calls, DIFF_PATH)).toBe(1);
  });

  it("reads the page again when a push names the skill", async () => {
    const { calls, live } = await openUpdatedGrilling();
    const readsBefore = countReads(calls, "/api/v1/skills/grilling");

    act(() => {
      live.pushInvalidation("skill", ["grilling"]);
    });

    await waitFor(() => {
      expect(countReads(calls, "/api/v1/skills/grilling")).toBe(readsBefore + 1);
    });
    expect(countReads(calls, DIFF_PATH)).toBe(1);
  });

  it("confirms Update all with the approval warnings, and sends exactly the updates it showed", async () => {
    const { calls } = await openList({
      skills: [REVIEW, GRILLING_UPDATED],
      handlers: { "POST /api/v1/skills/apply-updates": { body: { items: [] } } },
    });

    await userEvent.click(screen.getByRole("button", { name: "Update all 2" }));
    const dialog = await screen.findByRole("dialog", { name: "Update 2 skills?" });
    expect(dialog.textContent).toContain(
      "code-review and grilling take the revision GitHub has now.",
    );
    expect(within(dialog).getByText("One update may change approvals:")).toBeTruthy();
    expect(
      [...dialog.querySelectorAll(".skill-approvals li")].map((item) => item.textContent),
    ).toEqual([
      "grillingLets tools run without asking: Bash(git:*)ReadHas hooks, which run without asking",
    ]);

    await userEvent.click(within(dialog).getByRole("button", { name: "Update all" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    const sent = calls.filter((call) => call.path === "/api/v1/skills/apply-updates");
    expect(sent.map((call) => call.body)).toEqual([
      {
        updates: [
          { name: "code-review", revisionHash: UPDATE },
          { name: "grilling", revisionHash: UPDATE },
        ],
      },
    ]);
  });

  it("keeps a conflict in the confirmation, shows the newer update, and sends it on confirming again", async () => {
    const message =
      "`code-review` has a newer update than the one you confirmed. Read the updates again and confirm.";
    // A check finds the newer update just before the first confirmation lands.
    let checkedAgain = false;
    const newer = { ...REVIEW, availableRevisionHash: NEWER };
    const { calls } = await openList({
      handlers: {
        "GET /api/v1/skills": () => ({ body: { items: [checkedAgain ? newer : REVIEW] } }),
        "POST /api/v1/skills/apply-updates": (call) => {
          const [update] = (call.body as SkillApplyUpdatesInput).updates;
          if (update?.revisionHash === NEWER) return { body: { items: [] } };
          checkedAgain = true;
          return { status: 409, body: buildErrorBody("conflict", message) };
        },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Update all 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Update 1 skill?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Update all" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "code-review has a newer update than the one you confirmed. Read the updates again and confirm.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Update all" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    const sent = calls.filter((call) => call.path === "/api/v1/skills/apply-updates");
    expect(sent.map((call) => call.body)).toEqual([
      { updates: [{ name: "code-review", revisionHash: UPDATE }] },
      { updates: [{ name: "code-review", revisionHash: NEWER }] },
    ]);
  });
});
