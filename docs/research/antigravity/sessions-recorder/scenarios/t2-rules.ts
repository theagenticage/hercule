import { writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { setup, cleanup, handle, startAgy, openSession, prompt, freshWork, HOME, OUT, toolNames } from "./trust-lib.ts";
const [where, kind] = process.argv.slice(2); // where: config|settings ; kind: allow|allowall
const tmp = setup();
const cfg = `${HOME}/config/config.json`, set = `${HOME}/antigravity-acp/settings.json`;
const orig = readFileSync(cfg, "utf8");
const rules = kind === "allowall" ? ["command(*)", "command(echo hi)", "command(echo*)"] : ["command(echo hi)"];
const perm = { permissions: kind === "deny" ? { deny: ["command(echo)"] } : { allow: rules } };
if (where === "config") writeFileSync(cfg, JSON.stringify({ ...JSON.parse(orig), ...perm }, null, 2)); else writeFileSync(set, JSON.stringify(perm));
const cwd = freshWork("t2");
const agy = startAgy({ home: HOME, cwd, out: `${OUT}/t2-${where}-${kind}.jsonl` });
try {
  const perms = handle(agy);
  const { sessionId } = await openSession(agy, { cwd });
  const r = await prompt(agy, sessionId, "Run the command `echo hi` and reply done.");
  console.log(where, kind, r.result?.stopReason, "perms:", perms, "tools:", toolNames(agy));
} finally { await agy.close(); writeFileSync(cfg, orig); rmSync(set, { force: true }); cleanup(tmp); }
