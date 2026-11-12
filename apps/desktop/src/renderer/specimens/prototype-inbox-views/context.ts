/**
 * PROTOTYPE, throwaway. What a thread started from things actually receives.
 *
 * The opening message carries the user's words and the things as references,
 * never as pasted text. The agent gets a short digest above the message:
 *
 * - where the things came from: the user's bundle and its name, Hercule's
 *   Proposal, or a plain selection;
 * - one entry per thing: its External Ref and entity id, its title, and its
 *   fields as the plugin declares them (fields.ts), in one line;
 * - what the things share: every field value that two or more of them have,
 *   so three Sentry issues of one team and one release say so once;
 * - how to read more: `hercule entity read <id>` for facts, links, signals and
 *   history, which the agent's CLI already has; the plugin's blocks (a stack
 *   trace, a diff) would come from a block read the plugin serves.
 *
 * It is small on purpose: about 60 tokens a thing, so twenty things fit, and
 * the agent reads in full only what it needs.
 */
import { listFields } from "./fields";
import type { Thing, World } from "./world";

export type Origin =
  | { readonly type: "bundle"; readonly name: string }
  | { readonly type: "proposal"; readonly title: string }
  | { readonly type: "selection" };

/** Builds the External Ref a thing would have, in the canonical form of spec 09. */
export function buildRef(t: Thing, world: World): string {
  const account =
    world.sources
      .find((s) => s.id === t.source)!
      .connections.find((c) => c.id === t.connection)
      ?.label.split(" ")[0] ?? "";
  const kind = t.kind.id.split("/")[1]!.replace("pull-request", "pr");
  return `${t.source}:${kind}:${account}/${t.place.name.replace(/^#/, "")}${t.identifier ? `#${t.identifier.replace(/^#/, "")}` : `/${t.id}`}`;
}

/** Says a thing's declared fields in one line: "Team Checkout · Level error · Events 1,200". */
function describeFields(t: Thing, world: World): [string, string][] {
  const out: [string, string][] = [];
  for (const f of listFields([t.kind.id])) {
    if (f.owner === "core" && !["waiting"].includes(f.key)) continue;
    const v = f.read(t, world);
    if (v === undefined || v === "" || typeof v === "boolean") continue;
    const text =
      f.type === "age" && typeof v === "number"
        ? formatMinutes(v)
        : typeof v === "number"
          ? v.toLocaleString("en")
          : v;
    out.push([f.label, text]);
  }
  return out;
}

function formatMinutes(min: number): string {
  if (min < 60) return `${String(Math.round(min))}m`;
  if (min < 1440) return `${String(Math.round(min / 60))}h`;
  return `${String(Math.round(min / 1440))}d`;
}

/** Builds the digest a thread starts with, and an estimate of its size in tokens (about four characters each). */
export function buildContext(
  things: readonly Thing[],
  world: World,
  origin: Origin,
): { readonly text: string; readonly tokens: number } {
  const lines: string[] = [];
  const kinds = [...new Set(things.map((t) => t.kind.noun.toLowerCase()))];
  lines.push(
    origin.type === "bundle"
      ? `The user grouped these ${String(things.length)} things themselves, as the bundle "${origin.name}".`
      : origin.type === "proposal"
        ? `Hercule's triage proposed this work, and the user accepted it: "${origin.title}".`
        : `The user selected these ${String(things.length)} things (${kinds.join(", ")}).`,
  );
  lines.push("");
  const described = things.map((t) => ({ t, fields: describeFields(t, world) }));
  for (const { t, fields } of described) {
    lines.push(`${buildRef(t, world)}  (entity ${t.id})`);
    lines.push(`  ${t.kind.noun}: ${t.title}`);
    lines.push(`  ${fields.map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    if (t.asksYou && t.turn === "you") lines.push(`  Waits on the user: ${t.reason}`);
  }
  if (things.length > 1) {
    const counts = new Map<string, number>();
    for (const { fields } of described)
      for (const [k, v] of fields)
        if (k !== "Waiting") counts.set(`${k} ${v}`, (counts.get(`${k} ${v}`) ?? 0) + 1);
    const shared = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
    if (shared.length > 0) {
      lines.push("");
      lines.push(
        `Shared: ${shared.map(([kv, n]) => `${kv} (${String(n)} of ${String(things.length)})`).join(", ")}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "Read any of them in full with `hercule entity read <entity id>`: facts, links, signals and what changed. The source's own detail (a stack trace, a diff, the messages) comes from the plugin's blocks. Do not ask the user to paste them.",
  );
  const text = lines.join("\n");
  return { text, tokens: Math.round(text.length / 4) };
}
