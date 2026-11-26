// Shared by skills-walk-up and skills-walk-up-boundary: an additional directory inside a git repository.
import { join } from "node:path";
import { MARKER_PROMPT, READ_PROMPT, hookJson, markerLine, names, runScenario, testSkills } from "../driver.ts";

export const runWalkUp = (name: string, withGitFile: boolean, shows: string) =>
  runScenario(name, shows, async (run) => {
    // The repository P: a skill, AGENTS.md and a live hook. S lies three folders below it.
    run.gitInit("work", "P");
    run.placeSkill("work", "P/.agents/skills", "h1293-parent", "PARENTSK");
    run.place("work", "P/AGENTS.md", markerLine("MARKER-PARENTAGENTS"));
    run.place("work", "P/.agents/hooks.json", hookJson(join(run.work, "P/HOOK-RAN")));
    const S = join(run.work, "P/a/b/S");
    run.placeSkill("work", "P/a/b/S/.agents/skills", "h1293-inner", "INNERSK");
    run.place("work", "P/a/b/S/AGENTS.md", markerLine("MARKER-SAGENTS"));
    run.place("work", "P/a/b/S/.agents/hooks.json", hookJson(join(S, "HOOK-RAN")));
    if (withGitFile) run.place("work", "P/a/b/S/.git", "");
    // The working folder is outside P.
    const cwd = join(run.work, "cwd");
    run.place("work", "cwd/notes.txt", "hello notes\n");
    const done = run.watch({ cwd, P: join(run.work, "P"), fakeHome: run.fakeHome, TMPDIR: run.tmp });
    const agy = run.start({ cwd });
    const session = await agy.newSession({ cwd, additionalDirectories: [S] });
    run.observed.skillsListed = names(testSkills(session.commands));
    await run.ask(agy, session.sessionId, MARKER_PROMPT, 60_000);
    await run.ask(agy, session.sessionId, READ_PROMPT(join(cwd, "notes.txt")));
    run.observed.hookFileOfRepositoryP = run.readText(join(run.work, "P/HOOK-RAN"));
    run.observed.hookFileOfS = run.readText(join(S, "HOOK-RAN"));
    await agy.close();
    done();
  });
