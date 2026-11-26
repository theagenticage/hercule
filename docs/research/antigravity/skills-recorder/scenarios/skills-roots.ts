// Which roots load skills. One skill per root, read from available_commands_update; no prompt.
import { join } from "node:path";
import { names, runScenario, skillMd, testSkills } from "../driver.ts";

await runScenario("skills-roots", "which places agy lists skills from (and which skills it lists anyway: a folder whose SKILL.md names another skill, a link to a skill outside the workspace, a link out of the Harness Home that asks for permission when run): the Harness Home roots, the working folder's .agents/skills and .agent/skills, a plugin, config/skills.json and a project skills.json with an entry inside the workspace do load; the working folder's .gemini/skills and .claude/skills, a project skills.json entry outside the workspace, and every root under the fake HOME do not", async (run) => {
  const cwd = join(run.work, "cwd");
  const placed: Record<string, string> = {};
  const skill = (key: string, root: "home" | "work" | "fakehome", dir: string, marker: string) => {
    placed[`h1293-${key}`] = `${root}:${dir}`;
    run.placeSkill(root, dir, `h1293-${key}`, marker);
  };
  // The Harness Home roots.
  skill("hcfg", "home", "config/skills", "HCFG");
  skill("happ", "home", "antigravity-acp/skills", "HAPP");
  skill("hroot", "home", "skills", "HROOT");
  // A plugin in the Harness Home, and config/skills.json that points at a folder of skills.
  run.place("home", "config/plugins/h1293-plug/plugin.json", `{"name":"h1293-plug"}\n`);
  run.alsoRemoveFromHome("antigravity-acp/plugin_data/h1293-plug");
  skill("pskill", "home", "config/plugins/h1293-plug/skills", "PLUG");
  skill("cfgjson", "work", "listed-by-config-skills-json", "CFGJSON");
  run.place("home", "config/skills.json", JSON.stringify({ entries: [{ path: join(run.work, "listed-by-config-skills-json") }] }) + "\n");
  // The working folder.
  run.mkdir("work", "cwd");
  skill("cagents", "work", "cwd/.agents/skills", "CAGENTS");
  skill("cagent", "work", "cwd/.agent/skills", "CAGENT");
  skill("cgemini", "work", "cwd/.gemini/skills", "CGEMINI");
  skill("cclaude", "work", "cwd/.claude/skills", "CCLAUDE");
  // A project skills.json: one entry inside the workspace, one outside it.
  skill("pjin", "work", "cwd/inside-skills", "PJIN");
  skill("pjout", "work", "outside-skills", "PJOUT");
  run.place("work", "cwd/.agents/skills.json", JSON.stringify({ entries: [{ path: join(cwd, "inside-skills") }, { path: join(run.work, "outside-skills") }] }) + "\n");
  // Skills agy lists although the runner would skip them: the frontmatter name differs from the folder name,
  // and the folder is a link to a place outside the workspace.
  run.place("work", "cwd/.agents/skills/h1293-folder-a/SKILL.md", skillMd("h1293-renamed", "RENAMED"));
  run.place("work", "cwd/.agents/skills/h1293-folder-a/ref.txt", "REF-RENAMED\n");
  run.placeSkill("work", "outside-link-target", "h1293-linkout", "LINKOUT");
  run.link("work", "cwd/.agents/skills/h1293-linkout", join(run.work, "outside-link-target/h1293-linkout"));
  // The same kind of link, to a skill that lies elsewhere inside the workspace.
  run.placeSkill("work", "cwd/elsewhere", "h1293-linkin", "LINKIN");
  run.link("work", "cwd/.agents/skills/h1293-linkin", "../../elsewhere/h1293-linkin");
  for (const [n, where] of [["h1293-renamed", "work:cwd/.agents/skills/h1293-folder-a"], ["h1293-linkout", "work:cwd/.agents/skills (link to outside the workspace)"], ["h1293-linkin", "work:cwd/.agents/skills (link inside the workspace)"], ["h1293-hlink", "home:antigravity-acp/skills (link out of the home)"]] as const) placed[n] = where;
  // A link out of the Harness Home, to a skill outside it.
  run.placeSkill("work", "hlink-target", "h1293-hlink", "HLINK");
  run.link("home", "antigravity-acp/skills/h1293-hlink", join(run.work, "hlink-target/h1293-hlink"));
  // The fake HOME.
  skill("fgemini", "fakehome", ".gemini/skills", "FGEMINI");
  skill("fgemcfg", "fakehome", ".gemini/config/skills", "FGEMCFG");
  skill("fgemapp", "fakehome", ".gemini/antigravity-acp/skills", "FGEMAPP");
  skill("fagents", "fakehome", ".agents/skills", "FAGENTS");

  const done = run.watch({ cwd, fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const agy = run.start({ cwd });
  const session = await agy.newSession({ cwd });
  // A skill reached through a link out of the Harness Home: does running it ask for permission?
  await run.ask(agy, session.sessionId, "/h1293-hlink x", 60_000, { step: "skill behind a link out of the Harness Home" });
  await agy.close();
  const listed = names(testSkills(session.commands));
  done();
  run.observed.skillPlacedAt = placed;
  run.observed.skillsListed = listed;
  run.observed.skillsPlacedButNotListed = Object.keys(placed).filter((n) => !listed.includes(n));
  run.observed.commandUpdatesAfterSessionNew = session.commandUpdates;
  console.log("listed:", listed.join(", "));
  console.log("not listed:", (run.observed.skillsPlacedButNotListed as string[]).join(", "));
});
