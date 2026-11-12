/**
 * PROTOTYPE, throwaway. The plugin side of a card: what each plugin would
 * declare so its cards look like its source, without shipping any UI.
 *
 * The boundary, as Rogier set it on 2026-11-10: cards stay source-agnostic,
 * and plugins hook into fixed slots. A plugin returns a `CardFace`, plain data
 * built from a fixed vocabulary of parts (an identifier, a person, a level of
 * priority, a diff, a count of checks, a trend). The core's one card
 * (cards.tsx) draws any face and never names a plugin or a kind. Times ("waiting
 * 3h", "due in 2d") are the core's, from the External Entity; a plugin never
 * draws one.
 *
 * In this file each `faceOf...` function stands in for one plugin's
 * contribution. In real code the plugin host would call the plugin's hook and
 * store the returned face with the entity, as spec 20 already does for the
 * kind's words.
 */
import type { Thing } from "./world";

/** A colour a plugin may use: its own brand hue, or one of the core's tones. */
export type Tone = "neutral" | "progress" | "review" | "brand" | "good" | "bad" | "warn";

/** The leading glyph: a status the plugin draws from a fixed set of shapes. */
export interface Glyph {
  readonly shape: "ring" | "dashed" | "pie" | "full" | "check" | "bar" | "branch" | "dot";
  readonly tone: Tone;
  /** For `pie`: how much is filled, 0 to 1. */
  readonly fill?: number;
  readonly label: string;
}

export type Part =
  | {
      readonly type: "text";
      readonly text: string;
      readonly tone?: "muted" | "strong" | "bad" | "good" | undefined;
    }
  | { readonly type: "id"; readonly text: string }
  | { readonly type: "person"; readonly name: string; readonly square?: boolean }
  | { readonly type: "people"; readonly names: readonly string[]; readonly square?: boolean }
  | {
      readonly type: "count";
      readonly n: number;
      readonly noun: string;
      readonly tone?: Tone | undefined;
    }
  | { readonly type: "diff"; readonly add: number; readonly del: number }
  | { readonly type: "level"; readonly value: number; readonly label: string }
  | { readonly type: "chip"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "trend"; readonly values: readonly number[] };

export interface CardFace {
  readonly glyph?: Glyph | undefined;
  /** The small line above the title: identifier, place, person. */
  readonly top: readonly Part[];
  /** Parts at the end of the top line, such as a priority or a diff. */
  readonly corner: readonly Part[];
  readonly title: string;
  readonly titleWeight: "strong" | "regular";
  /** A body under the title: a preview, a quote, a line of code. */
  readonly body?:
    | { readonly text: string; readonly style: "plain" | "quote" | "mono" | "bubble" }
    | undefined;
  /** The line under it all. The core adds the time at its end. */
  readonly bottom: readonly Part[];
  /** Answers the core draws as small buttons, such as an invite's Yes, No, Maybe. */
  readonly answers?: readonly string[] | undefined;
  /** The plugin's own hue for its accents, in oklch hue degrees. */
  readonly hue?: number | undefined;
}

const LINEAR_GLYPH: Record<string, Glyph> = {
  Triage: { shape: "dashed", tone: "warn", label: "Triage" },
  Backlog: { shape: "dashed", tone: "neutral", label: "Backlog" },
  Todo: { shape: "ring", tone: "neutral", label: "Todo" },
  "In Progress": { shape: "pie", fill: 0.5, tone: "progress", label: "In Progress" },
  "In Review": { shape: "pie", fill: 0.75, tone: "review", label: "In Review" },
  Done: { shape: "check", tone: "brand", label: "Done" },
  Canceled: { shape: "full", tone: "neutral", label: "Canceled" },
};

function faceOfLinear(t: Thing): CardFace {
  const f = t.face;
  return {
    glyph: LINEAR_GLYPH[t.stage] ?? LINEAR_GLYPH.Todo!,
    top: [
      { type: "id", text: t.identifier },
      { type: "text", text: t.place.name, tone: "muted" },
    ],
    corner: [
      {
        type: "level",
        value: f.priority ?? 0,
        label: ["No priority", "Urgent", "High", "Medium", "Low"][f.priority ?? 0]!,
      },
      ...(f.assignee && f.assignee !== "Unassigned"
        ? [{ type: "person" as const, name: f.assignee }]
        : []),
    ],
    title: t.title,
    titleWeight: "strong",
    bottom: [
      ...(f.labels ?? []).map((l) => ({ type: "chip" as const, text: l })),
      { type: "text", text: t.stage, tone: "muted" },
    ],
    hue: 275,
  };
}

function faceOfPullRequest(t: Thing): CardFace {
  const f = t.face;
  const checks = f.checks;
  return {
    glyph: {
      shape: "branch",
      tone: t.stage === "Draft" ? "neutral" : t.stage === "Merged" ? "brand" : "good",
      label: `Pull request, ${t.stage}`,
    },
    top: [
      { type: "text", text: t.place.name, tone: "muted" },
      { type: "id", text: t.identifier },
    ],
    corner: f.diff ? [{ type: "diff", add: f.diff.add, del: f.diff.del }] : [],
    title: t.title,
    titleWeight: "strong",
    body: f.branch ? { text: `${f.branch} → ${f.base ?? "main"}`, style: "mono" } : undefined,
    bottom: [
      ...(checks
        ? [
            checks.failed > 0
              ? { type: "count" as const, n: checks.failed, noun: "failing", tone: "bad" as const }
              : { type: "count" as const, n: checks.passed, noun: "checks", tone: "good" as const },
          ]
        : []),
      ...(t.flags.includes("Changes requested")
        ? [{ type: "text" as const, text: "Changes requested", tone: "bad" as const }]
        : []),
      ...(t.stage === "Approved"
        ? [{ type: "text" as const, text: "Approved", tone: "good" as const }]
        : []),
      { type: "people", names: f.reviewers ?? [] },
    ],
    hue: 145,
  };
}

function faceOfMail(t: Thing): CardFace {
  const f = t.face;
  return {
    top: [
      { type: "person", name: f.sender ?? t.person },
      { type: "text", text: f.sender ?? t.person, tone: f.unread ? "strong" : undefined },
      ...((f.messages ?? 1) > 1
        ? [{ type: "text" as const, text: String(f.messages), tone: "muted" as const }]
        : []),
    ],
    corner: [],
    title: t.title,
    titleWeight: f.unread ? "strong" : "regular",
    body: f.snippet ? { text: f.snippet, style: "plain" } : undefined,
    bottom: [
      { type: "chip", text: t.place.name },
      ...(f.attachments ? [{ type: "count" as const, n: f.attachments, noun: "attachments" }] : []),
    ],
    hue: 25,
  };
}

function faceOfChat(t: Thing): CardFace {
  const f = t.face;
  const slack = t.source === "slack";
  return {
    top: [
      { type: "person", name: t.person, square: slack },
      { type: "text", text: t.person, tone: "strong" },
      { type: "text", text: t.place.name, tone: "muted" },
    ],
    corner: [],
    title: t.title,
    titleWeight: "regular",
    bottom:
      (f.replies ?? 0) > 0
        ? [
            { type: "people", names: f.participants ?? [], square: slack },
            { type: "count", n: f.replies ?? 0, noun: "replies", tone: "brand" },
          ]
        : [],
    hue: slack ? 330 : 265,
  };
}

function faceOfError(t: Thing): CardFace {
  const f = t.face;
  return {
    glyph: {
      shape: "bar",
      tone: f.level === "warning" ? "warn" : "bad",
      label: f.level ?? "error",
    },
    top: [
      { type: "text", text: t.place.name, tone: "muted" },
      {
        type: "text",
        text: t.stage,
        tone: t.stage === "Escalating" || t.stage === "Regressed" ? "bad" : "muted",
      },
    ],
    corner: t.trend ? [{ type: "trend", values: t.trend }] : [],
    title: f.errorType ?? t.title,
    titleWeight: "strong",
    body: f.culprit ? { text: f.culprit, style: "mono" } : undefined,
    bottom: [
      { type: "count", n: f.events ?? 0, noun: "events" },
      { type: "count", n: f.users ?? 0, noun: "users" },
    ],
    hue: 350,
  };
}

function faceOfIncident(t: Thing): CardFace {
  return {
    glyph: {
      shape: "full",
      tone: t.face.urgency === "high" ? "bad" : "warn",
      label: `${t.face.urgency ?? "low"} urgency`,
    },
    top: [
      { type: "id", text: t.identifier },
      { type: "text", text: t.place.name, tone: "muted" },
      { type: "text", text: t.stage, tone: t.stage === "Triggered" ? "bad" : "muted" },
    ],
    corner: [],
    title: t.title,
    titleWeight: "strong",
    bottom: [{ type: "text", text: t.reason, tone: "muted" }],
    hue: 145,
  };
}

function faceOfInvite(t: Thing): CardFace {
  const f = t.face;
  return {
    glyph: { shape: "dot", tone: "brand", label: "Invite" },
    top: [
      {
        type: "text",
        text: `${String(f.durationMin ?? 30)} min · ${f.location ?? ""}`,
        tone: "muted",
      },
    ],
    corner: [{ type: "count", n: f.guests ?? 0, noun: "guests" }],
    title: t.title,
    titleWeight: "strong",
    bottom: [],
    answers: t.stage === "Needs an answer" && !t.lapsed ? ["Yes", "No", "Maybe"] : undefined,
    hue: 250,
  };
}

function faceOfConversation(t: Thing): CardFace {
  const f = t.face;
  return {
    top: [
      { type: "person", name: f.company ?? t.person },
      { type: "text", text: f.company ?? t.person, tone: "strong" },
      { type: "chip", text: f.plan ?? "" },
    ],
    corner: [],
    title: t.title,
    titleWeight: "regular",
    body: { text: t.reason, style: "bubble" },
    bottom: [],
    hue: 230,
  };
}

function faceOfGeneric(t: Thing): CardFace {
  return {
    top: [
      { type: "text", text: t.place.name, tone: "muted" },
      { type: "id", text: t.identifier },
    ],
    corner: [],
    title: t.title,
    titleWeight: "strong",
    bottom: [{ type: "text", text: t.stage, tone: "muted" }],
  };
}

/**
 * Returns the face a thing's plugin declares. Stands in for the plugin host
 * calling each plugin's hook; the card that draws the face never sees this
 * switch.
 */
export function readFace(t: Thing): CardFace {
  switch (t.kind.id) {
    case "linear/issue":
      return faceOfLinear(t);
    case "github/pull-request":
      return faceOfPullRequest(t);
    case "gmail/thread":
      return faceOfMail(t);
    case "slack/thread":
    case "discord/thread":
      return faceOfChat(t);
    case "sentry/issue":
      return faceOfError(t);
    case "pagerduty/incident":
      return faceOfIncident(t);
    case "calendar/invite":
      return faceOfInvite(t);
    case "intercom/conversation":
      return faceOfConversation(t);
    default:
      return faceOfGeneric(t);
  }
}
