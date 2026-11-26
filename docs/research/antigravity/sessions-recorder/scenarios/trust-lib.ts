import { mkdtempSync, rmSync } from "node:fs";
import { startAgy, openSession, prompt, sleep, freshWork, select, type Agy } from "../agy-session.ts";
export const HOME = "/tmp/hercule-1282/homes/neon";
export const OUT = "/tmp/hercule-1282/rec4";
export const setup = () => { const tmp = mkdtempSync("/tmp/hercule-agy-"); process.env.TMPDIR = tmp; process.env.WORKROOT = "/var/tmp/hercule-1282-work"; return tmp; };
export const cleanup = (tmp: string) => rmSync(tmp, { recursive: true, force: true });
/** Answers permission requests with `kind`, counts them in perms. */
export const handle = (agy: Agy, kind = "allow_once") => {
  const perms: string[] = [];
  agy.onRequest((m) => {
    if (m.method === "session/request_permission") { perms.push(m.params.toolCall?.title ?? m.params.toolCall?.name ?? JSON.stringify(m.params.toolCall).slice(0, 80)); select(agy, m, kind); }
    else agy.respond(m.id, { action: "decline" });
  });
  return perms;
};
export const modeUpdates = (agy: Agy) => agy.messages.filter((m) => m.method === "session/update" && /mode/i.test(m.params?.update?.sessionUpdate ?? "")).map((m) => JSON.stringify(m.params.update));
export const toolNames = (agy: Agy) => [...new Set(agy.messages.filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "tool_call").map((m) => m.params.update.title ?? m.params.update.kind))];
export { startAgy, openSession, prompt, sleep, freshWork };
import { AGY_BINARY } from "../agy-session.ts";
/** startAgy, then writes the setup note as the first recording line. */
export const startNoted = (o: { cwd: string; out: string; extraFlags?: string[]; append?: boolean }, filesPlaced: string[] = []) => {
  const agy = startAgy({ home: HOME, ...o });
  agy.note({ argv: [AGY_BINARY, "acp", "--process-per-session", "--gemini-dir", HOME, "--app-data-dir", "antigravity-acp", "--log-file", `${HOME}/rec-log-*/agy.log`, ...(o.extraFlags ?? [])], TMPDIR: process.env.TMPDIR, cwd: o.cwd, filesPlaced } as any);
  return agy;
};
