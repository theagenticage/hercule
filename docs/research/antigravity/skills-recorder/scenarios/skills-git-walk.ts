// The walk from the working folder up to the git root: skills, AGENTS.md, GEMINI.md and rules.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MARKER_PROMPT, READ_PROMPT, hookJson, markerLine, names, runScenario, testSkills } from "../driver.ts";

await runScenario("skills-git-walk", "in a git repository agy loads .agents/skills and .agent/skills of the working folder and of every folder up to the git root, and the AGENTS.md, GEMINI.md and always_on rules of the git root above a sub folder; their .agents/hooks.json hooks run (a hook creates a file when it runs); the walk does not go down (working folder = repository root does not load a sub folder's skills); outside a git repository only the working folder counts, a plain parent folder's skills and AGENTS.md do not", async (run) => {
  const rule = (tag: string) => `---\ntrigger: always_on\n---\n${markerLine(tag)}`;
  // A repository: root, sub, sub/deep, each with a skill; instructions at the root and in sub.
  run.gitInit("work", "repo");
  run.placeSkill("work", "repo/.agents/skills", "h1293-groot", "GROOT");
  run.placeSkill("work", "repo/.agent/skills", "h1293-groot2", "GROOT2");
  run.placeSkill("work", "repo/sub/.agents/skills", "h1293-gsub", "GSUB");
  run.placeSkill("work", "repo/sub/deep/.agents/skills", "h1293-gdeep", "GDEEP");
  run.place("work", "repo/AGENTS.md", markerLine("MARKER-ROOTAGENTS"));
  run.place("work", "repo/GEMINI.md", markerLine("MARKER-ROOTGEMINI"));
  run.place("work", "repo/.agents/rules/r.md", rule("MARKER-ROOTRULE"));
  run.place("work", "repo/sub/AGENTS.md", markerLine("MARKER-SUBAGENTS"));
  // A plain folder tree with no git repository: a parent folder with a skill and AGENTS.md, a child folder with a skill.
  run.placeSkill("work", "plain/.agents/skills", "h1293-pparent", "PPARENT");
  run.place("work", "plain/AGENTS.md", markerLine("MARKER-PLAINPARENTAGENTS"));
  run.placeSkill("work", "plain/child/.agents/skills", "h1293-pchild", "PCHILD");
  run.place("work", "plain/child/AGENTS.md", markerLine("MARKER-PLAINCHILDAGENTS"));

  // Hooks at the root, in the deepest folder, in the plain parent and in the plain child: each creates its own marker file.
  const hooks: Record<string, string> = { "repo/.agents/hooks.json": "repo/HOOK-RAN-ROOT", "repo/sub/deep/.agents/hooks.json": "repo/sub/deep/HOOK-RAN-DEEP",
    "plain/.agents/hooks.json": "plain/HOOK-RAN-PARENT", "plain/child/.agents/hooks.json": "plain/child/HOOK-RAN-CHILD" };
  for (const [file, marker] of Object.entries(hooks)) run.place("work", file, hookJson(join(run.work, marker)));
  run.place("work", "repo/sub/deep/notes.txt", "hello notes\n");
  run.place("work", "plain/child/notes.txt", "hello notes\n");
  const deep = join(run.work, "repo/sub/deep");
  const root = join(run.work, "repo");
  const child = join(run.work, "plain/child");
  const done = run.watch({ repo: root, plain: join(run.work, "plain"), fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const results: Record<string, unknown> = {};
  for (const [label, cwd, ask] of [["workingFolderInSubFolderOfRepo", deep, true], ["workingFolderInPlainChild", child, true], ["workingFolderIsRepoRoot", root, false]] as const) {
    const agy = run.start({ cwd });
    const session = await agy.newSession({ cwd });
    const listed = names(testSkills(session.commands));
    results[label] = { cwd: cwd.replace(run.work, "<work>"), skillsListed: listed };
    console.log(label, listed.join());
    if (ask) {
      await run.ask(agy, session.sessionId, MARKER_PROMPT, 60_000, { label });
      await run.ask(agy, session.sessionId, READ_PROMPT(join(cwd, "notes.txt")), 90_000, { label });
      (results[label] as Record<string, unknown>).hookMarkerFilesAfterReadingAFile = Object.fromEntries(Object.values(hooks).map((m) => [m, run.readText(join(run.work, m)) !== null]));
      // Each process gets a fresh start: the next process must not see this process's marker files.
      for (const m of Object.values(hooks)) rmSync(join(run.work, m), { force: true });
    }
    await agy.close();
  }
  done();
  run.observed.sessions = results;
});
