import { setup, cleanup, handle, startNoted, openSession, prompt, sleep, freshWork, OUT } from "./trust-lib.ts";
import { FULL_ACCESS } from "../agy-session.ts";
import { procs } from "./stop-lib.ts";
const tmp = setup(); const cwd = freshWork("t5");
const agy = startNoted({ cwd, out: `${OUT}/t5-stopped.jsonl`, extraFlags: FULL_ACCESS });
const log = (s: string) => { console.log(s); agy.note(s as any); };
const alive = (p: number) => { try { process.kill(p, 0); return !(require("node:fs").readFileSync(`/proc/${p}/stat`, "utf8").includes(") Z")); } catch { return false; } };
const mine = new Set<number>();
try {
  handle(agy);
  const { sessionId } = await openSession(agy, { cwd });
  const p = prompt(agy, sessionId, "Run the command `sleep 600` in the foreground (wait for it).");
  let saw = false;
  for (let i = 0; i < 60 && !saw; i++) { await sleep(1000); saw = procs(tmp, agy.pid).some((l) => l.includes("sleep 600")); }
  await sleep(1500);
  log("TMPDIR=" + tmp + " front=" + agy.pid + " sleep seen: " + saw);
  log("BEFORE:\n" + procs(tmp, agy.pid).join("\n"));
  for (const l of procs(tmp, agy.pid)) mine.add(+l.split(" ")[0]);
  process.kill(agy.pid, "kill" && "SIGSTOP");
  await sleep(500);
  const st = require("node:fs").readFileSync(`/proc/${agy.pid}/stat`, "utf8"); log("front state after SIGSTOP: " + st.slice(st.lastIndexOf(")") + 2, st.lastIndexOf(")") + 3));
  process.kill(agy.pid, "SIGTERM");
  const t0 = Date.now(); while (alive(agy.pid) && Date.now() - t0 < 2000) await sleep(50);
  log(`front alive after SIGTERM+2s: ${alive(agy.pid)}`);
  process.kill(agy.pid, "SIGKILL");
  await sleep(5000);
  log(`front alive after SIGKILL+5s: ${alive(agy.pid)}`);
  log("AFTER +5s (descendants + TMPDIR holders):\n" + procs(tmp, agy.pid).join("\n"));
  for (const l of procs(tmp, agy.pid)) { const pid = +l.split(" ")[0]; if (pid !== process.pid && pid !== agy.pid) { mine.add(pid); try { process.kill(pid, "SIGKILL"); } catch {} } }
  await sleep(1500);
  log("after cleanup, remaining: " + JSON.stringify(procs(tmp, agy.pid).filter((l) => !l.startsWith(process.pid + " "))));
} finally { await agy.close(); cleanup(tmp); }
process.exit(0);
