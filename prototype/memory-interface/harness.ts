// PROTOTYPE (ticket #31) - runs the memory-interface experiment: conditions x scenarios x runs on headless Claude Code. Throwaway.
//
//   bun harness.ts --conditions files,hybrid,cli --scenarios all --runs 3 --concurrency 3 [--journal 1] [--model claude-sonnet-5] [--out results/<name>]
//
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { buildIndex, lockAll, readDoc, snapshot, writeIndexFile, CAPS } from "./lib";
import { scenarios, type Checkpoint, type Op, type Response, type RunData, type Scenario } from "./scenarios";

const HERE = import.meta.dir;
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] ?? ""] : [])).filter((p) => p.length));
const MODEL = args.model || "claude-sonnet-5";
const JOURNAL = args.journal === "1";
const RUNS = Number(args.runs || 1);
const CONC = Number(args.concurrency || 3);
const CONDS = (args.conditions || "files,hybrid,cli").split(",");
const SCEN = args.scenarios && args.scenarios !== "all" ? scenarios.filter((s) => args.scenarios.split(",").includes(s.id)) : scenarios;
const OUT = resolve(HERE, args.out || `results/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}${JOURNAL ? "-journal" : ""}`);
mkdirSync(OUT, { recursive: true });

type Mode = "files" | "hybrid" | "cli";

const access: Record<Mode, string> = {
  files: `Memory is the \`memory/\` directory in your working directory: \`memory/core.md\`, \`memory/topics/<name>.md\`${JOURNAL ? ", `memory/journal/YYYY-MM-DD.md`" : ""}. Read, grep and edit these files with your normal file tools; that is the only way to read or write memory. \`memory/INDEX.md\` is generated, do not edit it. The \`hydra\` CLI offers \`hydra recall <query>\` for past transcripts only.`,
  hybrid: `Memory is materialized read-only in \`memory/\` (\`memory/core.md\`, \`memory/topics/<name>.md\`, \`memory/INDEX.md\`${JOURNAL ? ", `memory/journal/`" : ""}); read and grep it freely with your file tools. ALL WRITES go through the \`hydra\` CLI: \`hydra memory write <name>\` (whole document from stdin heredoc or --content), \`hydra memory append <name>\`, \`hydra memory delete <name>\`${JOURNAL ? ", `hydra memory journal`" : ""}. Run \`hydra memory --help\` for details. Never chmod or edit the files directly: such edits are discarded.`,
  cli: `Memory is reached only through the \`hydra\` CLI: \`hydra memory list\`, \`hydra memory read <name>\`, \`hydra memory search <words>\`, \`hydra memory write <name>\` (stdin heredoc or --content), \`hydra memory append <name>\`, \`hydra memory delete <name>\`${JOURNAL ? ", `hydra memory journal`" : ""}. Run \`hydra memory --help\` for details. There are no memory files on disk.`,
};

function systemPrompt(mode: Mode, dir: string) {
  return `# Assistant memory

You are Athena, Rogier's personal assistant running on Hydra. You have durable MEMORY across conversations: notes you maintain yourself. Sessions are short-lived; whatever is not in memory is forgotten when this session is retired. Raw transcripts of past sessions remain searchable with \`hydra recall <query>\`, but that is slow and lossy: memory is the source of truth.

Memory layout:
- core: one short document, always loaded (below). Who Rogier is, standing preferences, what is live right now. Max ${CAPS.core} chars.
- topics: named documents (lowercase-hyphen names), max ${CAPS.topic} chars each, max ${CAPS.topics} topics. Only the index (below) is loaded at start; read a topic when you need its detail. Line 1 is \`# <name>\`, line 2 is \`> <one-line gist>\`; the index shows the gist.${JOURNAL ? `
- journal: append-only dated notes. Cheap to write: jot durable observations there as you go, and a scheduled dream pass later curates journal entries into core and topics. Core and topics may still be edited directly when a fact clearly belongs there.` : ""}

When to record: durable facts, preferences, decisions, people and their roles, and changes to facts you already hold. Record them as soon as you learn them, in the same turn, without being asked; do not announce it unless asked. Do not record chit-chat or transient task state. When a fact changes, replace the old one; never keep old and new. When a document is near its cap, consolidate before adding. Prefer extending an existing topic over creating a near-duplicate.

## Core (loaded)
${readDoc(dir, "core") ?? "(empty)"}

## Topic index (loaded)
${buildIndex(dir)}

## How to access memory
${access[mode]}`;
}

const FLUSH = JOURNAL
  ? "[Hydra rotation] This session is being retired; a fresh session will continue with only memory. Append anything durable from this conversation that is not yet in memory to the journal (the dream pass curates it later). Write nothing if there is nothing durable. Reply DONE plus one line on what you journaled."
  : "[Hydra rotation] This session is being retired; a fresh session will continue with only memory. Record anything durable from this conversation that is not yet in memory (core or topics). Write nothing if there is nothing durable. Reply DONE plus one line on what you recorded.";

const DREAM = (mode: Mode) =>
  `[Hydra dream pass] You are running as a scheduled curation pass, no user present. Read the unread journal entries (${mode === "files" ? "files under memory/journal/ newer than the timestamp in memory/journal/.cursor, or `hydra memory journal-unread`" : "`hydra memory journal-unread`"}) and fold what is durable into core and topics: supersede outdated facts, merge, respect caps, drop what is transient. Then run \`hydra memory journal-mark-read\`. Reply DONE plus one line per change.`;

type TurnResult = { sessionId: string; text: string; tools: string[]; cost: number; error?: string };

async function claudeTurn(opts: { cwd: string; env: Record<string, string>; prompt: string; system: string; resume?: string; raw: string }): Promise<TurnResult> {
  const argv = ["claude", "-p", opts.prompt, "--output-format", "stream-json", "--verbose", "--model", MODEL, "--setting-sources", "project", "--dangerously-skip-permissions", "--max-turns", "40", "--append-system-prompt", opts.system];
  if (opts.resume) argv.push("--resume", opts.resume);
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: { ...process.env, ...opts.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 6 * 60 * 1000);
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  clearTimeout(timer);
  appendFileSync(opts.raw, out + (err ? `\n[stderr] ${err}\n` : ""));
  const res: TurnResult = { sessionId: opts.resume ?? "", text: "", tools: [], cost: 0 };
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "system" && m.subtype === "init") res.sessionId = m.session_id;
    if (m.type === "assistant") for (const c of m.message?.content ?? []) {
      if (c.type === "text") res.text += c.text;
      if (c.type === "tool_use") res.tools.push(`${c.name}(${JSON.stringify(c.input).slice(0, 120)})`);
    }
    if (m.type === "result") { res.cost = m.total_cost_usd ?? 0; if (m.is_error) res.error = m.result; if (m.session_id) res.sessionId = m.session_id; }
  }
  if (!res.text && !res.error) res.error = `no assistant text; stderr: ${err.slice(0, 300)}`;
  return res;
}

async function runChain(mode: Mode, sc: Scenario, run: number) {
  const tag = `${mode}${JOURNAL ? "+journal" : ""}/${sc.id}/run${run}`;
  const rdir = join(OUT, mode, sc.id, `run${run}`);
  const cwd = join(rdir, "cwd");
  const memDir = mode === "cli" ? join(rdir, "memory") : join(cwd, "memory");
  const transcripts = join(rdir, "transcripts");
  const opsLog = join(rdir, "ops.jsonl");
  const raw = join(rdir, "raw.jsonl");
  for (const d of [cwd, transcripts]) mkdirSync(d, { recursive: true });
  cpSync(join(HERE, "seed"), memDir, { recursive: true });
  sc.seed?.(memDir);
  if (JOURNAL) mkdirSync(join(memDir, "journal"), { recursive: true });
  if (mode !== "cli") writeIndexFile(memDir);
  if (mode === "hybrid") lockAll(memDir);
  const seed = snapshot(memDir);
  const env = { PATH: `${join(HERE, "bin")}:${process.env.PATH}`, HYDRA_MEMORY_DIR: memDir, HYDRA_MEMORY_MODE: mode, HYDRA_MEMORY_JOURNAL: JOURNAL ? "1" : "0", HYDRA_OPS_LOG: opsLog, HYDRA_TRANSCRIPTS_DIR: transcripts };
  const checkpoints: Checkpoint[] = [];
  const responses: Response[] = [];
  let cost = 0;
  const errors: string[] = [];
  const log: string[] = [`# ${tag}\n`];
  const check = (label: string) => checkpoints.push({ label, memory: snapshot(memDir) });

  for (let s = 0; s < sc.sessions.length; s++) {
    const sys = systemPrompt(mode, memDir);
    let sid: string | undefined;
    const lines: string[] = [];
    for (let t = 0; t < sc.sessions[s].length; t++) {
      const prompt = sc.sessions[s][t];
      const r = await claudeTurn({ cwd, env, prompt, system: sys, resume: sid, raw });
      sid = r.sessionId || sid;
      cost += r.cost;
      if (r.error) errors.push(`s${s + 1}t${t + 1}: ${r.error}`);
      responses.push({ session: s, turn: t, text: r.text, tools: r.tools });
      lines.push(`user: ${prompt}`, `assistant: ${r.text.replace(/\n/g, " ")}`);
      log.push(`## s${s + 1} t${t + 1}\n**user:** ${prompt}\n\n**tools:** ${r.tools.join("\n") || "(none)"}\n\n**assistant:** ${r.text}\n`);
      check(`s${s + 1}t${t + 1}`);
      console.log(`  ${tag} s${s + 1}t${t + 1} done ($${cost.toFixed(3)})`);
    }
    // rotation: flush turn on the dying session, then (journal) dream pass
    const f = await claudeTurn({ cwd, env, prompt: FLUSH, system: sys, resume: sid, raw });
    cost += f.cost;
    if (f.error) errors.push(`s${s + 1} flush: ${f.error}`);
    responses.push({ session: s, turn: -1, text: f.text, tools: f.tools });
    log.push(`## s${s + 1} flush\n**tools:** ${f.tools.join("\n") || "(none)"}\n\n**assistant:** ${f.text}\n`);
    check(`s${s + 1}flush`);
    writeFileSync(join(transcripts, `session-${s + 1}.txt`), lines.join("\n") + "\n");
    if (JOURNAL) {
      const dr = await claudeTurn({ cwd, env, prompt: DREAM(mode), system: systemPrompt(mode, memDir), raw });
      cost += dr.cost;
      if (dr.error) errors.push(`s${s + 1} dream: ${dr.error}`);
      responses.push({ session: s, turn: -2, text: dr.text, tools: dr.tools });
      log.push(`## s${s + 1} dream\n**tools:** ${dr.tools.join("\n") || "(none)"}\n\n**assistant:** ${dr.text}\n`);
      check(`s${s + 1}dream`);
    }
  }

  const ops: Op[] = existsSync(opsLog) ? readFileSync(opsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const data: RunData = { seed, checkpoints, responses, ops, final: snapshot(memDir) };
  let verdict;
  try { verdict = sc.score(data); } catch (e) { verdict = { pass: false, notes: `scorer threw: ${e}` }; }
  const result = { condition: mode, journal: JOURNAL, scenario: sc.id, run, ...verdict, cost: Number(cost.toFixed(3)), errors, model: MODEL, dir: rdir };
  appendFileSync(join(OUT, "results.jsonl"), JSON.stringify(result) + "\n");
  writeFileSync(join(rdir, "run.json"), JSON.stringify({ result, checkpoints, responses, ops }, null, 2));
  writeFileSync(join(rdir, "log.md"), log.join("\n") + `\n## verdict\n${JSON.stringify(verdict)}\n`);
  console.log(`${verdict.pass ? "PASS" : "FAIL"} ${tag} ${verdict.failureClass ?? ""} - ${verdict.notes} ($${cost.toFixed(3)})${errors.length ? ` errors: ${errors.join("; ")}` : ""}`);
  return result;
}

const jobs: (() => Promise<unknown>)[] = [];
for (const mode of CONDS as Mode[]) for (const sc of SCEN) for (let r = 1; r <= RUNS; r++) jobs.push(() => runChain(mode, sc, r));
console.log(`${jobs.length} chains -> ${OUT} (model ${MODEL}, journal ${JOURNAL})`);
const results: any[] = [];
await Promise.all(Array.from({ length: CONC }, async () => { while (jobs.length) results.push(await jobs.shift()!()); }));

// summary table
const table: Record<string, Record<string, string>> = {};
for (const r of results) (table[r.scenario] ??= {})[r.condition] = `${results.filter((x) => x.scenario === r.scenario && x.condition === r.condition && x.pass).length}/${results.filter((x) => x.scenario === r.scenario && x.condition === r.condition).length}`;
const md = [`| scenario | ${CONDS.join(" | ")} |`, `|---|${CONDS.map(() => "---").join("|")}|`, ...Object.entries(table).map(([s, c]) => `| ${s} | ${CONDS.map((m) => c[m] ?? "-").join(" | ")} |`)].join("\n");
const total = results.reduce((a, r) => a + r.cost, 0);
console.log(`\n${md}\n\ntotal cost $${total.toFixed(2)}`);
writeFileSync(join(OUT, "summary.md"), `${md}\n\ntotal cost $${total.toFixed(2)}\n\n` + results.map((r) => `- ${r.pass ? "PASS" : "FAIL"} ${r.condition} ${r.scenario} run${r.run} ${r.failureClass ?? ""}: ${r.notes}`).join("\n") + "\n");
