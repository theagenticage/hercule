import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("search-list-fetch-delete", { "a.txt": "this has a needle in it\n", "b.txt": "nothing here\n", "c.txt": "another needle\n", "trash.txt": "delete me\n" }, { extraFlags: FULL_ACCESS }, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  autoPermission(agy);
  const r = await prompt(agy, sessionId, 'Do all of these: 1) find the files in this folder that contain the word "needle", 2) list the files in this folder, 3) fetch https://example.com and tell me its title, 4) delete the file trash.txt. Use your dedicated search, list, fetch and delete tools where you have them. Then say DONE.');
  return summarize("search-list-fetch-delete", r);
});
