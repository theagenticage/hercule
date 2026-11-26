import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("basic-allow", { "notes.txt": "Shopping list: milk, eggs.\n" }, {}, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  autoPermission(agy, "allow_once");
  const r = await prompt(agy, sessionId, "Do these four things in order: 1) read notes.txt, 2) edit notes.txt to add the line 'bread' at the end, 3) create a file hello.txt containing the text hello, 4) run the command `ls`. Then say DONE.");
  return summarize("basic-allow", r);
});
