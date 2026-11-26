// Records whether agy's sandbox lets commands reach the network, in each mode.
// Usage: bun scenarios/sandbox.ts <home> <outDir> [default|accept-edits|full]
import { runScenario, openSession, prompt, summarize, autoPermission, setMode, FULL_ACCESS } from "../agy-session.ts";
const mode = process.argv[4] ?? "full";
const PROMPT =
  "Run each of these four commands as its own command, do not set BypassSandbox yourself, and report each output exactly: " +
  "`curl -sS -m 5 -o /dev/null -w '%{http_code}' http://controller.example:4937/api/v1/` ; " +
  "`curl -sS -m 5 -o /dev/null -w '%{http_code}' https://api.github.com` ; " +
  "`git ls-remote https://github.com/octocat/Hello-World HEAD` ; " +
  "`echo $SSH_CONNECTION`";
await runScenario(`sandbox-${mode}`, {}, { extraFlags: mode === "full" ? FULL_ACCESS : [] }, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  if (mode === "accept-edits") await setMode(agy, sessionId, "accept-edits");
  autoPermission(agy);
  const r = await prompt(agy, sessionId, PROMPT);
  return summarize(`sandbox-${mode}`, r);
});
