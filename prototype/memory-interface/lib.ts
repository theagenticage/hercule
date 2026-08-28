// PROTOTYPE (ticket #31) - shared memory-store helpers for the stub CLI and the harness. Throwaway.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";

export const CAPS = { core: 4000, topic: 12000, topics: 24 };
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function topicsDir(dir: string) { return join(dir, "topics"); }
export function journalDir(dir: string) { return join(dir, "journal"); }

export function listTopics(dir: string): string[] {
  const d = topicsDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
}

export function docPath(dir: string, name: string) {
  return name === "core" ? join(dir, "core.md") : join(topicsDir(dir), `${name}.md`);
}

export function readDoc(dir: string, name: string): string | null {
  const p = docPath(dir, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function gistOf(content: string): string {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const g = lines.find((l) => l.startsWith(">"));
  return g ? g.replace(/^>\s*/, "") : "(no gist line)";
}

export function buildIndex(dir: string): string {
  const names = listTopics(dir);
  if (names.length === 0) return "(no topics yet)";
  return names
    .map((n) => {
      const c = readDoc(dir, n)!;
      const full = c.length >= CAPS.topic * 0.95 ? ", FULL" : "";
      return `- ${n} (${(c.length / 1000).toFixed(1)}k chars${full}): ${gistOf(c)}`;
    })
    .join("\n");
}

export function capFor(name: string) { return name === "core" ? CAPS.core : CAPS.topic; }

export function checkWrite(dir: string, name: string, content: string): string | null {
  if (name !== "core" && !NAME_RE.test(name)) return `invalid topic name "${name}": use lowercase letters, digits and hyphens`;
  const cap = capFor(name);
  if (content.length > cap) return `${name} would be ${content.length} chars; cap is ${cap}. Consolidate: merge or drop entries, then write again.`;
  if (name !== "core" && !existsSync(docPath(dir, name)) && listTopics(dir).length >= CAPS.topics) return `topic cap reached (${CAPS.topics}). Merge into an existing topic or delete one first.`;
  return null;
}

export function unlockAll(dir: string) {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) unlockAll(p); else chmodSync(p, 0o644);
  }
}

export function lockAll(dir: string) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) lockAll(p); else chmodSync(p, 0o444);
  }
  chmodSync(dir, 0o555);
}

export function writeIndexFile(dir: string) {
  writeFileSync(join(dir, "INDEX.md"), `# Memory index (generated, do not edit)\n\n${buildIndex(dir)}\n`);
}

export function writeDoc(dir: string, name: string, content: string, locked: boolean) {
  if (locked) unlockAll(dir);
  mkdirSync(topicsDir(dir), { recursive: true });
  writeFileSync(docPath(dir, name), content.endsWith("\n") ? content : content + "\n");
  writeIndexFile(dir);
  if (locked) lockAll(dir);
}

export function deleteDoc(dir: string, name: string, locked: boolean) {
  if (locked) unlockAll(dir);
  unlinkSync(docPath(dir, name));
  writeIndexFile(dir);
  if (locked) lockAll(dir);
}

export function today() { return new Date().toISOString().slice(0, 10); }

export function journalAppend(dir: string, content: string, locked: boolean) {
  if (locked) unlockAll(dir);
  mkdirSync(journalDir(dir), { recursive: true });
  const stamp = new Date().toISOString().slice(11, 16);
  appendFileSync(join(journalDir(dir), `${today()}.md`), `\n## ${stamp}\n${content.trim()}\n`);
  if (locked) lockAll(dir);
}

export function journalFiles(dir: string): { file: string; mtime: number }[] {
  const d = journalDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".md")).sort().map((f) => ({ file: join(d, f), mtime: statSync(join(d, f)).mtimeMs }));
}

export function journalText(dir: string): string {
  return journalFiles(dir).map((f) => `--- ${f.file.split("/").pop()}\n${readFileSync(f.file, "utf8")}`).join("\n");
}

export function journalUnread(dir: string): string {
  const cur = join(journalDir(dir), ".cursor");
  const since = existsSync(cur) ? Number(readFileSync(cur, "utf8")) : 0;
  const out = journalFiles(dir).filter((f) => f.mtime > since).map((f) => `--- ${f.file.split("/").pop()}\n${readFileSync(f.file, "utf8")}`);
  return out.length ? out.join("\n") : "(no unread journal entries)";
}

export function journalMarkRead(dir: string, locked: boolean) {
  if (locked) unlockAll(dir);
  mkdirSync(journalDir(dir), { recursive: true });
  writeFileSync(join(journalDir(dir), ".cursor"), String(Date.now()));
  if (locked) lockAll(dir);
}

export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const core = readDoc(dir, "core");
  if (core !== null) out.core = core;
  for (const n of listTopics(dir)) out[`topics/${n}`] = readDoc(dir, n)!;
  for (const f of journalFiles(dir)) out[`journal/${f.file.split("/").pop()}`] = readFileSync(f.file, "utf8");
  return out;
}

export function searchMemory(dir: string, query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: string[] = [];
  for (const [name, text] of Object.entries(snapshot(dir))) {
    text.split("\n").forEach((line, i) => {
      const l = line.toLowerCase();
      if (words.every((w) => l.includes(w))) hits.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits.length ? hits.slice(0, 40).join("\n") : "(no matches)";
}
