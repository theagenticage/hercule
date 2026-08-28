// PROTOTYPE (ticket #31) - the eight scenarios and their scorers. Throwaway.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type Checkpoint = { label: string; memory: Record<string, string> };
export type Response = { session: number; turn: number; text: string; tools: string[] };
export type Op = { t: string; op: string; name?: string; ok: boolean; error?: string; hits?: number };
export type RunData = { seed: Record<string, string>; checkpoints: Checkpoint[]; responses: Response[]; ops: Op[]; final: Record<string, string> };
export type Verdict = { pass: boolean; failureClass?: FailureClass; notes: string };
export type FailureClass =
  | "not-recorded" | "recorded-wrong-place" | "duplicated" | "not-recalled" | "recalled-from-transcript-instead"
  | "cap-ignored" | "fragmented-topic" | "noise-recorded";
export type Scenario = {
  id: string;
  description: string;
  seed?: (dir: string) => void;
  sessions: string[][]; // sessions -> user turns; a rotation (flush [+ dream]) runs after every session
  score: (d: RunData) => Verdict;
};

const curated = (m: Record<string, string>) => Object.entries(m).filter(([k]) => !k.startsWith("journal/")).map(([k, v]) => `### ${k}\n${v}`).join("\n");
const curatedMap = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("journal/")));
const has = (text: string, re: RegExp) => re.test(text);
const cp = (d: RunData, label: string) => d.checkpoints.find((c) => c.label === label)?.memory ?? {};
const whereIs = (m: Record<string, string>, re: RegExp) => Object.entries(m).filter(([, v]) => re.test(v)).map(([k]) => k);
const lastResponse = (d: RunData) => d.responses.filter((r) => r.turn >= 0).at(-1)?.text ?? "";
const usedRecall = (d: RunData) => d.ops.some((o) => o.op === "recall" && (o.hits ?? 0) > 0);
// recordedAt: first checkpoint whose curated memory matches
const recordedAt = (d: RunData, re: RegExp) => d.checkpoints.find((c) => re.test(curated(c.memory)))?.label ?? "never";

export const scenarios: Scenario[] = [
  {
    id: "recall-preference",
    description: "A preference stated in session 1 must drive behaviour in session 3.",
    sessions: [
      ["Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max."],
      ["Unrelated: give me three ideas for a weekly review ritual, one line each."],
      ["Quick check: what do you call me, and where does that come from? One line."],
    ],
    score(d) {
      const re = /\bRo\b/;
      const recorded = recordedAt(d, re);
      const answer = lastResponse(d);
      const recalled = has(answer, re) && !/call you Rogier/i.test(answer);
      if (recorded === "never" && recalled && usedRecall(d)) return { pass: false, failureClass: "recalled-from-transcript-instead", notes: "never written to memory; answered via hydra recall" };
      if (recorded === "never") return { pass: false, failureClass: "not-recorded", notes: `answer: ${answer.slice(0, 120)}` };
      if (!recalled) return { pass: false, failureClass: "not-recalled", notes: `recorded at ${recorded} in ${whereIs(curatedMap(d.final), re)}; answer: ${answer.slice(0, 120)}` };
      return { pass: true, notes: `recorded at ${recorded} in ${whereIs(curatedMap(d.final), re)}` };
    },
  },
  {
    id: "recall-topic-body",
    description: "A fact that lives only in a topic body (not the index) must be found by drilling in.",
    sessions: [["What's the Discord channel id for #ops? I need it for a webhook. Just the number."]],
    score(d) {
      const answer = lastResponse(d);
      const tools = d.responses.flatMap((r) => r.tools);
      const drilled = tools.some((t) => /discord-setup|memory read|memory search|Grep|Read/.test(t));
      if (!/1188429077315/.test(answer)) return { pass: false, failureClass: "not-recalled", notes: `tools: ${tools.join(" | ").slice(0, 200)}; answer: ${answer.slice(0, 120)}` };
      return { pass: true, notes: `drilled via: ${tools.filter((t) => /discord|memory|Grep|Read|cat/.test(t)).join(" | ").slice(0, 200) || "(no read tool seen)"}${drilled ? "" : " - suspicious"}` };
    },
  },
  {
    id: "record-unprompted",
    description: "A new durable fact mentioned in passing must be recorded, ideally in the same turn.",
    sessions: [["Small thing before I forget: I set up a Tailscale account today, the tailnet is rogier-lab.ts.net and the Mac mini is already on it. Anyway - from what you know, what are the open threads on Hydra right now? Bullet list."]],
    score(d) {
      const re = /rogier-lab\.ts\.net/;
      const at = recordedAt(d, re);
      if (at === "never") return { pass: false, failureClass: "not-recorded", notes: `journal has it: ${Object.entries(d.final).some(([k, v]) => k.startsWith("journal/") && re.test(v))}` };
      return { pass: true, notes: `recorded at ${at} in ${whereIs(curatedMap(d.final), re).join(",")}` };
    },
  },
  {
    id: "update-supersede",
    description: "A changed fact must replace the old one, not sit next to it.",
    sessions: [["Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only."]],
    score(d) {
      const text = curated(d.final);
      const hasNew = /gitlab\.com\/rogier\/hydra/.test(text);
      const oldLines = text.split("\n").filter((l) => /github\.com\/rogierpennink\/hydra/.test(l));
      const oldQualified = oldLines.every((l) => /mirror|old|previous|formerly|moved|read-only|was/i.test(l));
      if (!hasNew) return { pass: false, failureClass: "not-recorded", notes: `recorded at ${recordedAt(d, /gitlab/)}` };
      if (oldLines.length && !oldQualified) return { pass: false, failureClass: "duplicated", notes: `old url still present unqualified: ${oldLines[0].trim().slice(0, 100)}` };
      return { pass: true, notes: `recorded at ${recordedAt(d, /gitlab/)} in ${whereIs(curatedMap(d.final), /gitlab/).join(",")}; old url ${oldLines.length ? "kept, qualified as mirror" : "removed"}` };
    },
  },
  {
    id: "cap-full",
    description: "Adding facts to a topic at its cap must consolidate, not blow through or silently drop.",
    seed(dir) {
      const p = join(dir, "topics", "hydra-project.md");
      let text = readFileSync(p, "utf8") + "\n## Decision log (chronological)\n";
      const log = [
        "Chose SQLite over Postgres for the controller: single-user, single file, trivially portable.",
        "Rejected containers on runners: bare processes, supervision by the runner, no Docker dependency.",
        "Runner join = single-use token plus one fully programmatic command; no fleet auto-discovery in v1.",
        "Workspaces split into primary (shared main checkout) and ephemeral (worktrees on task branches).",
        "Plugins register contributions in code via a pure register() step; manifest stays coarse.",
        "Provider adapter is thin: probe plus five session methods plus one normalized event stream.",
        "Workflow graphs route on declared step outputs; actions never redirect the graph.",
        "All events flow through one persisted pipeline with durable cursors; at-least-once plus idempotency.",
        "External accounts are core-owned Connections; plugins define types, core owns the rows.",
        "Triage is a workflow pattern inside core-enforced spawn bounds, not an engine.",
        "Notifications are core-routed; channel sinks are dumb.",
        "Agents operate Hydra through the public API only; nothing reachable in-process that HTTP cannot reach.",
        "Secrets encrypted per value under a keychain-held master key; promotion re-wraps.",
        "Git credentials derive from Connections via a runner credential helper; identity follows the repo.",
        "Web app is a static pure client of the public API; one WebSocket for live topics only.",
      ];
      let i = 0;
      while (text.length < 11750) {
        text += `- 2026-0${(i % 8) + 1}-${String((i % 27) + 1).padStart(2, "0")}: ${log[i % log.length]} (revisited: ${["confirmed", "no change", "wording tightened", "example added"][i % 4]}.)\n`;
        i++;
      }
      writeFileSync(p, text);
    },
    sessions: [["Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only."]],
    score(d) {
      const fin = curatedMap(d.final);
      const text = curated(d.final);
      const facts = [/bun/i, /0018/, /single-use/i].filter((re) => re.test(text)).length;
      const topic = fin["topics/hydra-project"] ?? "";
      const over = Object.entries(fin).filter(([k, v]) => v.length > (k === "core" ? 4000 : 12000)).map(([k, v]) => `${k}=${v.length}`);
      const rejected = d.ops.filter((o) => !o.ok && /cap/.test(o.error ?? "")).length;
      const newTopics = Object.keys(fin).filter((k) => k.startsWith("topics/") && !(k in d.seed));
      if (over.length) return { pass: false, failureClass: "cap-ignored", notes: `over cap: ${over.join(",")}; facts ${facts}/3; rejects ${rejected}` };
      if (facts < 3) return { pass: false, failureClass: "not-recorded", notes: `facts ${facts}/3; stub rejects ${rejected}; hydra-project now ${topic.length} chars; new topics ${newTopics.join(",") || "none"}` };
      return { pass: true, notes: `facts 3/3; hydra-project ${topic.length} chars (was ${d.seed["topics/hydra-project"].length}); stub rejects ${rejected}; new topics ${newTopics.join(",") || "none"}` };
    },
  },
  {
    id: "rotation-distill",
    description: "Facts spread over a long conversation must survive rotation into the next session.",
    sessions: [
      [
        "Morning. Planning day. First: the Discord bot token now lives in the 1Password vault called hydra-ops, not the keychain anymore. Noted?",
        "What would you suggest as the order for the next three Hydra tickets? Keep it to three lines.",
        "Also, our contact at the hosting provider TransIP is Jelle Bakker - he handles the VPS and DNS. Just so you know who I mean when I say Jelle.",
        "Draft a two-sentence status update I can paste into #hydra-dev.",
        "My dentist moved the appointment to September 12 at 10:30, same practice.",
        "One more Hydra question: should the runner or the controller own the workspace teardown timer? One paragraph.",
        "Thanks, that's it for now.",
      ],
      ["Three quick checks from memory, one line each: where is the Discord bot token kept now, who is our hosting contact, and when is my dentist appointment?"],
    ],
    score(d) {
      const answer = lastResponse(d);
      const checks: [string, RegExp][] = [["token", /1password|hydra-ops/i], ["jelle", /jelle/i], ["dentist", /(sept(ember)?\.?\s*12|12\s*sept|09-12|12\/09)/i]];
      const recalled = checks.filter(([, re]) => re.test(answer)).map(([n]) => n);
      const inMemory = checks.filter(([, re]) => re.test(curated(d.final))).map(([n]) => n);
      const missing = checks.map(([n]) => n).filter((n) => !recalled.includes(n));
      if (recalled.length === 3) return { pass: true, notes: `3/3 recalled; in memory: ${inMemory.join(",")}; at ${checks.map(([n, re]) => `${n}@${recordedAt(d, re)}`).join(" ")}` };
      const notRecorded = missing.filter((n) => !inMemory.includes(n));
      return { pass: false, failureClass: notRecorded.length ? "not-recorded" : "not-recalled", notes: `recalled ${recalled.join(",") || "none"}; missing ${missing.join(",")}; in memory ${inMemory.join(",") || "none"}; answer: ${answer.slice(0, 160)}` };
    },
  },
  {
    id: "noise",
    description: "Chit-chat must not end up in curated memory.",
    sessions: [[
      "What's a good name for a grey cat? Three options.",
      "Is it going to rain in Amsterdam this weekend? Just guess, no lookup.",
      "Tell me a short joke about databases.",
    ]],
    score(d) {
      const seedText = curated(d.seed);
      const finText = curated(d.final);
      const journal = Object.entries(d.final).filter(([k]) => k.startsWith("journal/")).map(([, v]) => v).join("\n");
      if (finText !== seedText) {
        const changed = Object.keys(curatedMap(d.final)).filter((k) => d.final[k] !== d.seed[k]);
        return { pass: false, failureClass: "noise-recorded", notes: `changed: ${changed.join(",")}; ${changed.map((k) => (d.final[k] ?? "").split("\n").filter((l) => !(d.seed[k] ?? "").includes(l)).join(" / ")).join(" | ").slice(0, 200)}` };
      }
      return { pass: true, notes: journal.trim() ? `curated untouched; journal got: ${journal.trim().slice(0, 160)}` : "curated untouched, nothing journaled" };
    },
  },
  {
    id: "fragmentation",
    description: "Two facts about the same subject across two sessions must land in the same topic.",
    sessions: [
      ["Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all."],
      ["Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all."],
    ],
    score(d) {
      const fin = curatedMap(d.final);
      const f1 = /websocket/i, f2 = /auto-?joined|local runner/i;
      const w1 = whereIs(fin, f1), w2 = whereIs(fin, f2);
      const newTopics = Object.keys(fin).filter((k) => k.startsWith("topics/") && !(k in d.seed));
      if (!w1.length || !w2.length) return { pass: false, failureClass: "not-recorded", notes: `websocket in ${w1.join(",") || "nowhere"}, local runner in ${w2.join(",") || "nowhere"}` };
      if (newTopics.length) return { pass: false, failureClass: "fragmented-topic", notes: `new topics: ${newTopics.join(",")}; websocket in ${w1.join(",")}, local runner in ${w2.join(",")}` };
      if (!w1.includes("topics/hydra-project") || !w2.includes("topics/hydra-project")) return { pass: false, failureClass: "recorded-wrong-place", notes: `websocket in ${w1.join(",")}, local runner in ${w2.join(",")}` };
      return { pass: true, notes: "both in hydra-project, no new topics" };
    },
  },
];
