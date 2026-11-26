// Whether an edit in the session skills folder is asked for, in default and accept-edits.
import { join } from "node:path";
import { runScenario } from "../driver.ts";

await runScenario("skills-writes", "an edit of a file in the session skills folder S, in the working folder, and outside both, in the modes default and accept-edits: which permission requests came (all rejected) and what each file holds afterwards; every case is its own session", async (run) => {
  const cwd = join(run.work, "cwd");
  const S = run.stageSessionSkills("S", { lib: [["h1293-lib", "LIBSK"]], gitFile: true });
  // Every case edits a file of its own, so no case sees the edit of another.
  const targets: Record<string, Record<string, [file: string, text: string]>> = {};
  for (const mode of ["accept-edits", "default"]) {
    const tag = mode.toUpperCase();
    run.place("work", `S/skills/h1293-lib/edit-${mode}.txt`, `S-${tag}-LINE\n`);
    run.place("work", `cwd/edit-${mode}.txt`, `CWD-${tag}-LINE\n`);
    run.place("work", `outside/edit-${mode}.txt`, `OUTSIDE-${tag}-LINE\n`);
    targets[mode] = {
      inSessionSkillsFolder: [join(S, `skills/h1293-lib/edit-${mode}.txt`), `S-${tag}-LINE`],
      inWorkingFolder: [join(cwd, `edit-${mode}.txt`), `CWD-${tag}-LINE`],
      outsideBoth: [join(run.work, `outside/edit-${mode}.txt`), `OUTSIDE-${tag}-LINE`],
    };
  }
  const done = run.watch({ cwd, S, outside: join(run.work, "outside"), fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const agy = run.start({ cwd });
  const cases: Record<string, unknown> = {};
  for (const mode of ["accept-edits", "default"]) {
    for (const [label, [file, oldText]] of Object.entries(targets[mode]!)) {
      const before = run.readText(file);
      const session = await agy.newSession({ cwd, additionalDirectories: [S], mode });
      const r = await run.ask(agy, session.sessionId, `Use your file edit tool, not a shell command, to replace the text ${oldText} in the file ${file} with ${oldText}-EDITED-${mode}. Then reply done.`, 75_000, { mode, target: label });
      cases[`${mode}/${label}`] = { mode, file: file.replace(run.work, "<work>"), contentBefore: before, contentAfter: run.readText(file), permissionRequests: r.permissionRequests, reply: r.text };
    }
  }
  await agy.close();
  done();
  run.observed.cases = cases;
});
