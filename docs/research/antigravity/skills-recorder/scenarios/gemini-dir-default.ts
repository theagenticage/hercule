// Which folder agy uses when it gets no --gemini-dir and no --app-data-dir.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { AGY_BINARY, runScenario, sleep } from "../driver.ts";

await runScenario("gemini-dir-default", "agy acp started with neither --gemini-dir nor --app-data-dir, with a fake HOME, answers initialize, fails authenticate (nothing is signed in there), and the listing of the fake HOME afterwards shows which folder it keeps its files in; the defaults of both flags are in the note", async (run) => {
  const cwd = join(run.work, "cwd");
  run.mkdir("work", "cwd");
  const help = spawnSync(AGY_BINARY, ["acp", "--help"], { env: { ...process.env, HOME: run.fakeHome, TMPDIR: run.tmp }, encoding: "utf8" });
  run.note.agyAcpHelpLinesWithDefaults = `${help.stdout}${help.stderr}`.split("\n").filter((l) => /gemini[-_]dir|app[-_]data[-_]dir/.test(l)).map((l) => l.trim());
  const done = run.watch({ fakeHome: run.fakeHome, cwd, TMPDIR: run.tmp });
  const agy = run.start({ cwd, geminiDir: false, dropXdg: true });
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("no answer to authenticate within 40 s"), 40_000));
  const answered = await Promise.race([agy.initializeAndAuthenticate().then((r) => ({ initializeError: r.init.error ?? null, agentVersion: r.init.result?.agentInfo?.version, authenticateError: r.auth.error ?? null, authenticateResult: r.auth.result ?? null })), timeout]);
  run.observed.answers = answered;
  await sleep(1500);
  await agy.close();
  done();
  // agy unpacks its built-in skills and plugins on first start: keep their folder in the listing, drop their files.
  const after = run.observed.after as Record<string, string[]>;
  const unpacked = after.fakeHome!.filter((p) => p.includes("/builtin/") && !p.endsWith("/builtin/"));
  after.fakeHome = [...after.fakeHome!.filter((p) => !unpacked.includes(p)), `(${unpacked.length} files and folders below .gemini/antigravity-cli/builtin/ not listed)`];
  console.log(JSON.stringify(answered));
});
