/**
 * PROTOTYPE, throwaway. The plugin side of the Inbox's detail pane: blocks.
 *
 * It reuses the Blocks of spec 10 §9.5, which Intake's pane already draws
 * source-agnostically (text, messages, change, checks, and one quiet line for
 * a type the app does not know), and adds three the entity detail needs:
 *
 * - `fields`: labelled values, such as a Linear issue's priority and cycle;
 * - `trend`: a series with a caption, such as a Sentry issue's events per day;
 * - `code`: monospace lines, such as a stack trace.
 *
 * A plugin returns blocks as plain data; the core's pane (inbox-pane.tsx)
 * draws them and never names a plugin. The core keeps its own sections around
 * them: the provenance line, your work, the bundle, what happened, answers.
 * Each `blocksOf...` function stands in for one plugin's hook.
 */
import type { Thing, World } from "./world";

export type Block =
  | { readonly type: "text"; readonly title?: string; readonly text: string }
  | {
      readonly type: "messages";
      readonly title?: string;
      readonly messages: readonly Message[];
      readonly more?: number;
    }
  | {
      readonly type: "change";
      readonly head: string;
      readonly base: string;
      readonly files: number;
      readonly add: number;
      readonly del: number;
      readonly checks: string;
    }
  | {
      readonly type: "checks";
      readonly rows: readonly {
        readonly name: string;
        readonly state: "failed" | "pending";
        readonly log?: string;
      }[];
      readonly passed: number;
    }
  | {
      readonly type: "fields";
      readonly title?: string;
      readonly fields: readonly (readonly [string, string])[];
    }
  | { readonly type: "trend"; readonly caption: string; readonly values: readonly number[] }
  | { readonly type: "code"; readonly title?: string; readonly lines: readonly string[] };

export interface Message {
  readonly author: string;
  readonly atMin: number;
  readonly text: string;
  /** The message that asks the user, drawn with a marigold rule. */
  readonly mentionsYou?: boolean;
}

const PEOPLE = ["Priya", "Marta", "Jonas", "Ruth", "Hanna", "Tomás", "Mei", "Kwame"];

function pickFrom<T>(list: readonly T[], seed: string, salt: number): T {
  const n = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, salt);
  return list[n % list.length]!;
}

function blocksOfLinear(t: Thing, w: World): Block[] {
  const project = w.projects.find((p) => p.id === t.projectId);
  return [
    {
      type: "text",
      title: "Description",
      text: `${t.title}.\n\nAcceptance: the change sits behind a flag, has a test for the case from the support thread, and the error rate on checkout does not rise after release.`,
    },
    {
      type: "fields",
      fields: [
        ["Status", t.stage],
        ["Priority", ["No priority", "Urgent", "High", "Medium", "Low"][t.face.priority ?? 0]!],
        ["Assignee", t.face.assignee ?? "Nobody"],
        ["Team", t.place.name],
        ["Project", project ? `${project.name} · ${project.health}` : "No project"],
        ["Cycle", pickFrom(["Cycle 42", "Cycle 43", "No cycle"], t.id, 3)],
        ["Labels", (t.face.labels ?? []).join(", ") || "None"],
      ],
    },
    {
      type: "messages",
      title: "Comments",
      messages: [
        {
          author: pickFrom(PEOPLE, t.id, 1),
          atMin: t.openedMin * 0.6,
          text: "I can reproduce this on staging with a Pro seller. Logs attached in the Slack thread.",
        },
        {
          author: t.person === "You" ? pickFrom(PEOPLE, t.id, 2) : t.person,
          atMin: t.waitMin,
          text: t.reason,
          mentionsYou: t.asksYou,
        },
      ],
    },
  ];
}

function blocksOfPullRequest(t: Thing): Block[] {
  const f = t.face;
  const failing = (f.checks?.failed ?? 0) > 0;
  return [
    {
      type: "change",
      head: f.branch ?? "branch",
      base: f.base ?? "main",
      files: Math.max(1, Math.round(((f.diff?.add ?? 10) + (f.diff?.del ?? 0)) / 40)),
      add: f.diff?.add ?? 0,
      del: f.diff?.del ?? 0,
      checks: failing
        ? `${String(f.checks!.failed)} failing, ${String(f.checks!.passed)} passed`
        : `${String(f.checks?.passed ?? 0)} passed`,
    },
    ...(failing
      ? [
          {
            type: "checks" as const,
            rows: [
              {
                name: "e2e (shard 3)",
                state: "failed" as const,
                log: "✗ checkout › gift card covers the whole order\n  Expected 200, received 500\n  at tests/checkout.spec.ts:118",
              },
              { name: "typecheck", state: "failed" as const },
            ],
            passed: f.checks!.passed,
          },
        ]
      : []),
    {
      type: "messages",
      title: "Review",
      messages: [
        {
          author: t.person === "You" ? "You" : t.person,
          atMin: t.openedMin,
          text: `This pull request ${t.title.charAt(0).toLowerCase()}${t.title.slice(1)}. Tested against staging.`,
        },
        ...(t.flags.includes("Changes requested")
          ? [
              {
                author: pickFrom(PEOPLE, t.id, 4),
                atMin: t.waitMin,
                text: "Please split the migration out of this one, it is hard to review together.",
                mentionsYou: true,
              },
            ]
          : t.person !== "You"
            ? [
                {
                  author: t.person,
                  atMin: t.waitMin,
                  text: "@you could you take a look? Small one.",
                  mentionsYou: true,
                },
              ]
            : []),
      ],
    },
  ];
}

function blocksOfError(t: Thing): Block[] {
  const f = t.face;
  return [
    ...(t.trend
      ? [{ type: "trend" as const, caption: "Events per day, last 14 days", values: t.trend }]
      : []),
    {
      type: "code",
      title: "Stack trace",
      lines: [
        `${f.errorType ?? "Error"}: ${f.culprit ?? t.title}`,
        `  at ${pickFrom(["GiftCardLedger.Settle", "OrderMapper.Map", "handler", "FacetBuilder.Build"], t.id, 5)} (src/${t.place.name}/${pickFrom(["ledger", "orders", "search", "payouts"], t.id, 6)}.ts:${String(40 + ((t.id.length * 17) % 300))})`,
        "  at processTicksAndRejections (node:internal/process/task_queues:95)",
      ],
    },
    {
      type: "fields",
      fields: [
        ["Level", f.level ?? "error"],
        ["State", t.stage],
        ["Events", (f.events ?? 0).toLocaleString("en")],
        ["Users affected", (f.users ?? 0).toLocaleString("en")],
        ["Project", t.place.name],
        ["First seen", `${String(Math.round(t.openedMin / 1440))} days ago`],
      ],
    },
  ];
}

function blocksOfMail(t: Thing): Block[] {
  const f = t.face;
  const n = f.messages ?? 1;
  return [
    {
      type: "messages",
      messages: [
        ...(n > 1
          ? [
              {
                author: "You",
                atMin: t.waitMin * 2 + 60,
                text: "Thanks, I'll come back to you on this before the end of the week.",
              },
            ]
          : []),
        {
          author: f.sender ?? t.person,
          atMin: t.waitMin,
          text: f.snippet ?? t.title,
          mentionsYou: t.asksYou,
        },
      ],
      more: Math.max(0, n - 2),
    },
    {
      type: "fields",
      fields: [
        ["Label", t.place.name],
        ["Attachments", String(f.attachments ?? 0)],
        ["Messages", String(n)],
      ],
    },
  ];
}

function blocksOfChat(t: Thing): Block[] {
  const f = t.face;
  const others = f.participants ?? [];
  return [
    {
      type: "messages",
      title: t.place.name,
      messages: [
        { author: t.person, atMin: t.openedMin, text: t.title, mentionsYou: t.asksYou },
        ...others.slice(0, 2).map((p, i) => ({
          author: p,
          atMin: t.openedMin - (i + 1) * 7,
          text: pickFrom(
            [
              "+1, seeing the same here",
              "I think this came in with Tuesday's deploy",
              "Can we get someone on it today?",
            ],
            `${t.id}${p}`,
            i,
          ),
        })),
      ],
      more: Math.max(0, (f.replies ?? 0) - 2),
    },
  ];
}

function blocksOfConversation(t: Thing): Block[] {
  const f = t.face;
  return [
    {
      type: "messages",
      messages: [
        {
          author: f.company ?? t.person,
          atMin: t.waitMin + 30,
          text: `${t.title}. We have orders waiting and our customers are asking.`,
        },
        {
          author: "Amara (Support)",
          atMin: t.waitMin,
          text: `Escalating to you: ${t.reason.toLowerCase()}.`,
          mentionsYou: true,
        },
      ],
    },
    {
      type: "fields",
      fields: [
        ["Company", f.company ?? ""],
        ["Plan", f.plan ?? ""],
        [
          "Reply due",
          f.slaMin === undefined
            ? "No SLA"
            : f.slaMin < 0
              ? "Overdue"
              : `in ${String(Math.round(f.slaMin))} min`,
        ],
      ],
    },
  ];
}

function blocksOfInvite(t: Thing): Block[] {
  const f = t.face;
  return [
    {
      type: "fields",
      fields: [
        ["Duration", `${String(f.durationMin ?? 30)} min`],
        ["Where", f.location ?? ""],
        ["Guests", String(f.guests ?? 0)],
        ["Organizer", t.person],
      ],
    },
    {
      type: "text",
      title: "Agenda",
      text: "1. Where we are\n2. What is blocking\n3. Who does what by Friday",
    },
  ];
}

function blocksOfIncident(t: Thing): Block[] {
  return [
    {
      type: "fields",
      fields: [
        ["Urgency", t.face.urgency ?? "low"],
        ["Status", t.stage],
        ["Service", t.place.name],
        ["Open for", `${String(Math.round(t.openedMin))} min`],
      ],
    },
    {
      type: "text",
      title: "Alert",
      text: `${t.title}. Runbook: runbooks.northwind.example/${t.place.name}`,
    },
  ];
}

/** Returns the blocks a thing's plugin declares for its detail. Stands in for the plugin host calling each plugin's hook. */
export function readBlocks(t: Thing, w: World): Block[] {
  switch (t.kind.id) {
    case "linear/issue":
      return blocksOfLinear(t, w);
    case "github/pull-request":
      return blocksOfPullRequest(t);
    case "sentry/issue":
      return blocksOfError(t);
    case "gmail/thread":
      return blocksOfMail(t);
    case "slack/thread":
    case "discord/thread":
      return blocksOfChat(t);
    case "intercom/conversation":
      return blocksOfConversation(t);
    case "calendar/invite":
      return blocksOfInvite(t);
    case "pagerduty/incident":
      return blocksOfIncident(t);
    default:
      return [];
  }
}

/** The answers a plugin offers on a thing, besides the core's. Stands in for the actions a plugin declares, as Intake's actions already are. */
export function readAnswers(t: Thing): string[] {
  switch (t.kind.id) {
    case "github/pull-request":
      return t.person === "You" ? ["Merge", "Ask for review"] : ["Approve", "Request changes"];
    case "gmail/thread":
    case "intercom/conversation":
      return ["Reply"];
    case "slack/thread":
    case "discord/thread":
      return ["Reply in thread"];
    case "sentry/issue":
      return ["Resolve", "Ignore"];
    case "linear/issue":
      return ["Move to In Progress"];
    case "pagerduty/incident":
      return ["Acknowledge"];
    case "calendar/invite":
      return ["Yes", "No", "Maybe"];
    default:
      return [];
  }
}
