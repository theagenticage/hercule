import { startAgy, openSession, prompt, autoPermission, sleep, FULL_ACCESS, freshWork, isUpdate } from "../agy-session.ts";
import { makeTmp, procs } from "./stop-lib.ts";
const [home, outDir, mode] = process.argv.slice(2); // mode: bg | fg | cancel
const tmp = makeTmp();
const cwd = freshWork("stop-" + mode);
const agy = startAgy({ home, cwd, out: `${outDir}/stop-${mode}.jsonl`, extraFlags: FULL_ACCESS });
const log = (s: string) => { console.log(s); agy.note(s); };
const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
log(`TMPDIR=${tmp} front=${agy.pid}`);
const { sessionId } = await openSession(agy, { cwd });
autoPermission(agy);
const cmd = mode === "fg" ? "Run the command `sleep 600` in the foreground (wait for it)." : "Run the command `sleep 600` in the background (do not wait for it), then reply STARTED.";
const p = prompt(agy, sessionId, cmd);
let sawSleep = false;
for (let i = 0; i < 60 && !sawSleep; i++) { await sleep(1000); sawSleep = procs(tmp, agy.pid).some((l) => l.includes("sleep 600")); }
await sleep(1500);
log("sleep seen: " + sawSleep);
if (mode === "bg" || mode === "cancel") { try { await Promise.race([p, sleep(40000)]); } catch {} }
log("BEFORE:\n" + procs(tmp, agy.pid).join("\n"));
if (mode === "cancel") {
  const r = await Promise.race([agy.request("session/cancel", { sessionId }).catch(() => null), sleep(1)]);
  agy.notify("session/cancel", { sessionId });
  const rep = await Promise.race([p, sleep(20000).then(() => "NO REPLY in 20s")]);
  log("prompt reply after cancel: " + JSON.stringify((rep as any)?.result ?? rep));
  await sleep(5000);
  log("AFTER cancel +5s:\n" + procs(tmp, agy.pid).join("\n"));
} else {
  agy.notify; process.kill(agy.pid, "SIGTERM");
  const t0 = Date.now(); while (alive(agy.pid) && Date.now() - t0 < 2000) await sleep(50);
  const exited = !alive(agy.pid) || (await Bun.file(`/proc/${agy.pid}/stat`).text().then(t => t.includes(") Z"), () => true));
  log(`front exited within 2s of SIGTERM: ${exited} (${Date.now() - t0} ms)`);
  log("AFTER SIGTERM+2s:\n" + procs(tmp, agy.pid).join("\n"));
  if (!exited) { process.kill(agy.pid, "SIGKILL"); log("sent SIGKILL"); }
  await sleep(5000);
  log("AFTER +5s:\n" + procs(tmp, agy.pid).join("\n"));
}
// cleanup own leftovers: sleep processes carrying our TMPDIR, by pid
for (const l of procs(tmp, agy.pid)) { const pid = +l.split(" ")[0]; if (pid !== process.pid && pid !== agy.pid) try { process.kill(pid, "SIGKILL"); } catch {} }
await agy.close();
process.exit(0);
