/**
 * PROTOTYPE, throwaway. The shared invented world of the Inbox lifetimes
 * variants, built on the model of MODEL.md:
 *
 * - `KINDS` declares each kind's lifetime, stage weight, stages, patience and
 *   what happens when patience runs out. Variants read these declarations
 *   and never branch on a kind's name.
 * - Every thing has a turn (whose move it is), a stage, flags and a history
 *   of changes, so a variant can draw a track, a pulse or a trend.
 * - The hand-written core is the twelve subjects of session f38e3c8b
 *   (fable-subjects.ts), three subjects with no lasting thing, and cases that
 *   break their kind's usual lifetime. A seeded tail adds volume per load.
 *
 * Round three adds what a card needs to look like its source (`Face`), and
 * Linear initiatives and projects with other people's issues in them.
 *
 * Times are minutes before now (`atMin`, `waitMin`, `openedMin`), or minutes
 * after now (`dueMin`), so nothing here reads a clock.
 */
import { SUBJECT_DRAFTS, type Draft, type FableSourceId } from "./fable-subjects";

export type SourceId =
  | "gmail"
  | "linear"
  | "sentry"
  | "github"
  | "slack"
  | "discord"
  | "pagerduty"
  | "intercom"
  | "calendar"
  | "vercel";

export type Lifetime = "lasting" | "standing" | "passing";
export type StageWeight = "track" | "state" | "turn";
/** What happens when patience runs out while it is the user's turn. */
export type OnOverdue = "presses" | "lapses" | "none";
/** Whose move it is: the user's, someone else's, or nobody's. */
export type Turn = "you" | "them" | "none";
export type Load = "light" | "heavy" | "extreme";

export type KindId =
  | "linear/issue"
  | "github/issue"
  | "sentry/issue"
  | "github/pull-request"
  | "gmail/thread"
  | "intercom/conversation"
  | "slack/thread"
  | "discord/thread"
  | "pagerduty/incident"
  | "calendar/invite"
  | "vercel/deployment";

export interface Kind {
  readonly id: KindId;
  readonly source: SourceId;
  readonly noun: string;
  readonly lifetime: Lifetime;
  readonly stageWeight: StageWeight;
  /** The stages in order. The last one ends the path. */
  readonly stages: readonly string[];
  /** Stages that leave the path, such as Canceled. */
  readonly exits: readonly string[];
  /** Minutes of patience while it is the user's turn. Infinity for none. */
  readonly patienceMin: number;
  readonly onOverdue: OnOverdue;
}

const H = 60;
const D = 24 * H;

export const KINDS: Readonly<Record<KindId, Kind>> = {
  "linear/issue": {
    id: "linear/issue",
    source: "linear",
    noun: "Issue",
    lifetime: "lasting",
    stageWeight: "track",
    stages: ["Triage", "Backlog", "Todo", "In Progress", "In Review", "Done"],
    exits: ["Canceled"],
    patienceMin: Infinity,
    onOverdue: "none",
  },
  "github/issue": {
    id: "github/issue",
    source: "github",
    noun: "Issue",
    lifetime: "lasting",
    stageWeight: "state",
    stages: ["Open", "Closed"],
    exits: [],
    patienceMin: Infinity,
    onOverdue: "none",
  },
  "sentry/issue": {
    id: "sentry/issue",
    source: "sentry",
    noun: "Error",
    lifetime: "lasting",
    stageWeight: "state",
    stages: ["New", "Escalating", "Ongoing", "Regressed", "Resolved"],
    exits: [],
    patienceMin: 4 * H,
    onOverdue: "presses",
  },
  "github/pull-request": {
    id: "github/pull-request",
    source: "github",
    noun: "Pull request",
    lifetime: "standing",
    stageWeight: "track",
    stages: ["Draft", "In review", "Approved", "Merged"],
    exits: ["Closed"],
    patienceMin: 1 * D,
    onOverdue: "presses",
  },
  "gmail/thread": {
    id: "gmail/thread",
    source: "gmail",
    noun: "Email",
    lifetime: "standing",
    stageWeight: "turn",
    stages: ["Open", "Closed"],
    exits: [],
    patienceMin: 1 * D,
    onOverdue: "presses",
  },
  "intercom/conversation": {
    id: "intercom/conversation",
    source: "intercom",
    noun: "Conversation",
    lifetime: "standing",
    stageWeight: "turn",
    stages: ["Open", "Closed"],
    exits: [],
    patienceMin: 2 * H,
    onOverdue: "presses",
  },
  "slack/thread": {
    id: "slack/thread",
    source: "slack",
    noun: "Thread",
    lifetime: "passing",
    stageWeight: "turn",
    stages: ["Open", "Quiet"],
    exits: [],
    patienceMin: 4 * H,
    onOverdue: "lapses",
  },
  "discord/thread": {
    id: "discord/thread",
    source: "discord",
    noun: "Thread",
    lifetime: "passing",
    stageWeight: "turn",
    stages: ["Open", "Quiet"],
    exits: [],
    patienceMin: 1 * D,
    onOverdue: "lapses",
  },
  "pagerduty/incident": {
    id: "pagerduty/incident",
    source: "pagerduty",
    noun: "Incident",
    lifetime: "passing",
    stageWeight: "track",
    stages: ["Triggered", "Acknowledged", "Resolved"],
    exits: [],
    patienceMin: 30,
    onOverdue: "presses",
  },
  "calendar/invite": {
    id: "calendar/invite",
    source: "calendar",
    noun: "Invite",
    lifetime: "passing",
    stageWeight: "turn",
    stages: ["Needs an answer", "Answered"],
    exits: [],
    patienceMin: Infinity,
    onOverdue: "lapses",
  },
  "vercel/deployment": {
    id: "vercel/deployment",
    source: "vercel",
    noun: "Deployment",
    lifetime: "passing",
    stageWeight: "state",
    stages: ["Building", "Error", "Ready"],
    exits: [],
    patienceMin: Infinity,
    onOverdue: "none",
  },
};

export interface Connection {
  readonly id: string;
  readonly source: SourceId;
  readonly label: string;
}

export interface Source {
  readonly id: SourceId;
  readonly name: string;
  readonly placeNoun: string;
  readonly connections: readonly Connection[];
}

export interface Place {
  readonly id: string;
  readonly source: SourceId;
  readonly name: string;
}

export interface Change {
  /** Minutes before now. */
  readonly atMin: number;
  readonly label: string;
  /** The stage the thing moved to, when the change was a move. */
  readonly stage?: string | undefined;
}

export interface Thing {
  readonly id: string;
  readonly kind: Kind;
  readonly source: SourceId;
  readonly connection: string;
  readonly place: Place;
  readonly identifier: string;
  readonly title: string;
  /** Who it is from or with. "You" for the user's own. */
  readonly person: string;
  readonly stage: string;
  /** The stage's position in `kind.stages`, or -1 for an exit. */
  readonly stageIndex: number;
  /** Facts that are not steps on the path, such as "Checks failing". */
  readonly flags: readonly string[];
  readonly turn: Turn;
  /**
   * Someone waits on the user. False when it is the user's turn only
   * because the user drives it and nothing blocks it.
   */
  readonly asksYou: boolean;
  /** The sentence: why it is here now. */
  readonly reason: string;
  readonly fact?: string | undefined;
  /** Events per day over the last 14 days, oldest first. */
  readonly trend?: readonly number[] | undefined;
  /** Minutes since the thing was created at its source. */
  readonly openedMin: number;
  /** Minutes since its last change, which is when the current turn began. */
  readonly waitMin: number;
  /** Minutes until something it waits for, such as the event of an invite. */
  readonly dueMin?: number | undefined;
  readonly patienceMin: number;
  /** Reached the end of its path, or a quiet state. */
  readonly settled: boolean;
  /** A passing thing whose patience ran out on the user's turn. Still stored. */
  readonly lapsed: boolean;
  readonly isNew: boolean;
  /** Oldest first. */
  readonly changes: readonly Change[];
  readonly subject?: string | undefined;
  /** Ids of the other things of its subject. */
  links: string[];
  /** What a card of this kind needs to look like its source: sender, branch, checks and so on. */
  readonly face: Face;
  /** False for other people's work, read only for the bigger picture. Such a thing is never on the Inbox. */
  readonly concernsYou: boolean;
  /** The Linear project of an issue, when it has one. */
  projectId?: string | undefined;
}

/**
 * The details a source shows on its own cards. Each field belongs to some
 * kinds only; a card draws what its kind has. All of it is what the source
 * reports, never something Hercule works out.
 */
export interface Face {
  /** Linear: 1 urgent, 2 high, 3 medium, 4 low, 0 none. */
  readonly priority?: number;
  readonly assignee?: string;
  readonly labels?: readonly string[];
  /** GitHub pull request. */
  readonly branch?: string;
  readonly base?: string;
  readonly checks?: { readonly passed: number; readonly failed: number; readonly pending: number };
  readonly diff?: { readonly add: number; readonly del: number };
  readonly reviewers?: readonly string[];
  readonly comments?: number;
  /** Mail. */
  readonly sender?: string;
  readonly snippet?: string;
  readonly messages?: number;
  readonly unread?: boolean;
  readonly attachments?: number;
  /** Chat. */
  readonly replies?: number;
  readonly participants?: readonly string[];
  /** Sentry. */
  readonly level?: "fatal" | "error" | "warning";
  readonly errorType?: string;
  readonly culprit?: string;
  readonly events?: number;
  readonly users?: number;
  /** Calendar. `startsInMin` is the event's own start, a real time. */
  readonly startsInMin?: number;
  readonly durationMin?: number;
  readonly guests?: number;
  readonly location?: string;
  /** Intercom. `slaMin` is Intercom's own "next reply due", a real time. */
  readonly company?: string;
  readonly plan?: string;
  readonly slaMin?: number;
  /** PagerDuty. */
  readonly urgency?: "high" | "low";
}

export type Health = "on track" | "at risk" | "off track";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly initiativeId: string;
  readonly team: string;
  readonly lead: string;
  readonly health: Health;
  /** Minutes from now to the target date; negative when it has passed. */
  readonly targetMin: number;
  readonly update: { readonly by: string; readonly atMin: number; readonly text: string };
  /** Every issue of the project: the user's and everyone else's. */
  readonly issues: readonly Thing[];
}

export interface Initiative {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly target: string;
  readonly projects: readonly Project[];
}

export interface Subject {
  readonly id: string;
  readonly title: string;
  readonly things: readonly Thing[];
  /** The lasting thing that leads the subject, if it has one. */
  readonly lead?: Thing | undefined;
}

export interface World {
  readonly load: Load;
  readonly sources: readonly Source[];
  readonly kinds: readonly Kind[];
  readonly places: readonly Place[];
  readonly things: readonly Thing[];
  readonly subjects: readonly Subject[];
  readonly byId: ReadonlyMap<string, Thing>;
  /** Minutes since the user last looked at the Inbox. */
  readonly lastLookMin: number;
  readonly initiatives: readonly Initiative[];
  readonly projects: readonly Project[];
  /** Other people's issues in those projects. Not on the Inbox, not in `things`. */
  readonly others: readonly Thing[];
}

const SOURCES: readonly Source[] = [
  {
    id: "linear",
    name: "Linear",
    placeNoun: "Team",
    connections: [{ id: "linear", source: "linear", label: "Northwind" }],
  },
  {
    id: "github",
    name: "GitHub",
    placeNoun: "Repository",
    connections: [
      { id: "github", source: "github", label: "northwind" },
      { id: "github-oss", source: "github", label: "open source" },
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    placeNoun: "Project",
    connections: [
      { id: "sentry", source: "sentry", label: "northwind" },
      { id: "sentry-oss", source: "sentry", label: "ferrule (open source)" },
    ],
  },
  {
    id: "gmail",
    name: "Gmail",
    placeNoun: "Label",
    connections: [
      { id: "gmail", source: "gmail", label: "you@northwind.example" },
      { id: "gmail-personal", source: "gmail", label: "personal" },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    placeNoun: "Channel",
    connections: [
      { id: "slack", source: "slack", label: "Northwind" },
      { id: "slack-partners", source: "slack", label: "Northwind × Adyen" },
    ],
  },
  {
    id: "discord",
    name: "Discord",
    placeNoun: "Channel",
    connections: [
      { id: "discord-bun", source: "discord", label: "Bun" },
      { id: "discord-effect", source: "discord", label: "Effect" },
    ],
  },
  {
    id: "intercom",
    name: "Intercom",
    placeNoun: "Inbox",
    connections: [{ id: "intercom", source: "intercom", label: "Northwind" }],
  },
  {
    id: "pagerduty",
    name: "PagerDuty",
    placeNoun: "Service",
    connections: [{ id: "pagerduty", source: "pagerduty", label: "northwind" }],
  },
  {
    id: "calendar",
    name: "Calendar",
    placeNoun: "Calendar",
    connections: [{ id: "calendar", source: "calendar", label: "you@northwind.example" }],
  },
  {
    id: "vercel",
    name: "Vercel",
    placeNoun: "Project",
    connections: [{ id: "vercel", source: "vercel", label: "northwind" }],
  },
];

// ---------------------------------------------------------------------------
// Random

function createRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE = [
  "Priya",
  "Marta",
  "Jonas",
  "Ruth",
  "Hanna",
  "Tomás",
  "Mei",
  "Kwame",
  "Sofia",
  "Dev",
  "Lars",
  "Amara",
  "Yuki",
  "Noor",
  "Felix",
  "Clara",
];

// ---------------------------------------------------------------------------
// Building one thing

interface Spec {
  readonly kind: KindId;
  readonly place: string;
  readonly title: string;
  readonly stage: string;
  readonly turn: Turn;
  readonly asksYou?: boolean;
  readonly reason: string;
  readonly person: string;
  readonly waitMin: number;
  readonly openedMin?: number;
  readonly identifier?: string;
  readonly flags?: readonly string[];
  readonly fact?: string | undefined;
  readonly trend?: readonly number[] | undefined;
  readonly dueMin?: number;
  readonly isNew?: boolean;
  readonly connection?: string;
  readonly changes?: readonly Change[];
  readonly face?: Partial<Face>;
  readonly concernsYou?: boolean;
}

class Builder {
  readonly things: Thing[] = [];
  readonly places = new Map<string, Place>();
  readonly random: () => number;
  constructor(seed: number) {
    this.random = createRandom(seed);
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.random() * list.length)]!;
  }
  between(lo: number, hi: number): number {
    return Math.floor(lo + this.random() * (hi - lo + 1));
  }
  placeFor(source: SourceId, name: string): Place {
    const id = `${source}/${name}`;
    let place = this.places.get(id);
    if (place === undefined) {
      place = { id, source, name };
      this.places.set(id, place);
    }
    return place;
  }

  /** Builds a thing from a spec, works out its derived fields and its history, and keeps it. */
  add(spec: Spec, subject?: string): Thing {
    // An event starts on the hour or the half hour. The clock stands at 09:41, 581 minutes into the day.
    if (spec.kind === "calendar/invite" && spec.dueMin !== undefined) {
      spec = { ...spec, dueMin: Math.round((spec.dueMin + 581) / 30) * 30 - 581 };
    }
    const kind = KINDS[spec.kind];
    const stageIndex = kind.stages.indexOf(spec.stage);
    const openedMin =
      spec.openedMin ??
      Math.max(
        spec.waitMin + 5,
        spec.waitMin *
          (kind.lifetime === "lasting"
            ? this.between(3, 12)
            : kind.lifetime === "standing"
              ? this.between(2, 4)
              : 1.5),
      );
    const settled =
      stageIndex === kind.stages.length - 1 ||
      stageIndex === -1 ||
      (kind.stageWeight === "turn" && spec.turn === "none" && spec.stage !== kind.stages[0]);
    const patienceMin = spec.turn === "you" ? kind.patienceMin : Infinity;
    const lapsed =
      kind.onOverdue === "lapses" &&
      spec.turn === "you" &&
      ((spec.dueMin !== undefined && spec.dueMin < 0) || spec.waitMin > kind.patienceMin);
    const partial = {
      kind,
      stage: spec.stage,
      stageIndex,
      turn: spec.turn,
      asksYou: spec.asksYou ?? spec.turn === "you",
      person: spec.person,
      flags: spec.flags ?? [],
      trend: spec.trend,
      waitMin: spec.waitMin,
      openedMin,
    };
    const thing: Thing = {
      id: `t${String(this.things.length + 1)}`,
      source: kind.source,
      connection: spec.connection ?? SOURCES.find((s) => s.id === kind.source)!.connections[0]!.id,
      place: this.placeFor(kind.source, spec.place),
      identifier: spec.identifier ?? "",
      title: spec.title,
      reason: spec.reason,
      fact: spec.fact,
      dueMin: spec.dueMin,
      patienceMin,
      settled,
      lapsed,
      isNew: spec.isNew ?? spec.waitMin < LAST_LOOK_MIN,
      changes: spec.changes ?? this.buildChanges(partial),
      subject,
      links: [],
      face: { ...this.buildFace(kind, spec), ...spec.face },
      concernsYou: spec.concernsYou ?? true,
      ...partial,
    };
    this.things.push(thing);
    return thing;
  }

  /** Invents what a card of the thing's kind shows, from the spec and its fact line where they say it. */
  buildFace(kind: Kind, spec: Spec): Face {
    const fact = spec.fact ?? "";
    const readCount = (pattern: RegExp): number | undefined => {
      const m = fact.match(pattern);
      if (!m) return undefined;
      const raw = m[1]!.replaceAll(",", "");
      return raw.endsWith("k") ? Math.round(parseFloat(raw) * 1000) : parseInt(raw, 10);
    };
    const others = (n: number): string[] => [
      ...new Set(Array.from({ length: n }, () => this.pick(PEOPLE))),
    ];
    switch (kind.id) {
      case "linear/issue":
        return {
          priority: this.pick([1, 2, 2, 3, 3, 3, 4, 0]),
          assignee: spec.turn === "you" ? "You" : spec.person,
          labels:
            this.random() < 0.6
              ? [this.pick(["Bug", "Backend", "Frontend", "Tech debt", "Customer", "Performance"])]
              : [],
        };
      case "github/issue":
        return { assignee: spec.person, comments: this.between(0, 12) };
      case "github/pull-request": {
        const failing = spec.flags?.includes("Checks failing") ?? false;
        const d = fact.match(/\+([\d,]+)\s*[−-]([\d,]+)/);
        const author = spec.person === "You" ? "you" : spec.person.toLowerCase();
        const slug = spec.title
          .toLowerCase()
          .replace(/[^a-z0-9 ]/g, "")
          .split(" ")
          .slice(0, 4)
          .join("-");
        return {
          branch: `${author}/${slug}`,
          base: "main",
          checks: failing
            ? { passed: 12, failed: 2, pending: 0 }
            : { passed: this.between(10, 16), failed: 0, pending: this.random() < 0.2 ? 2 : 0 },
          diff: d
            ? {
                add: parseInt(d[1]!.replaceAll(",", ""), 10),
                del: parseInt(d[2]!.replaceAll(",", ""), 10),
              }
            : { add: this.between(4, 600), del: this.between(0, 300) },
          reviewers: spec.person === "You" ? others(this.between(1, 2)) : ["You"],
          comments: this.between(0, 14),
        };
      }
      case "gmail/thread":
        return {
          sender: spec.person,
          snippet: `${this.pick(["Hi,", "Hello,", "Thanks for this.", "Following up:"])} ${this.pick(
            [
              "could you confirm the dates before Friday? The seller office needs them for the brochure.",
              "attached is the revised version with your comments worked in. Two points are still open.",
              "we would like to move ahead, but need an answer on the open question first.",
              "can we set up a short call this week? I have Tuesday and Thursday afternoon.",
            ],
          )}`,
          messages: readCount(/(\d+) messages/) ?? this.between(1, 6),
          unread: spec.turn === "you" && this.random() < 0.6,
          attachments: this.random() < 0.3 ? this.between(1, 3) : 0,
        };
      case "slack/thread":
      case "discord/thread":
        return {
          replies: readCount(/(\d+) repl/) ?? this.between(0, 20),
          participants: others(this.between(2, 4)),
        };
      case "sentry/issue": {
        // "TypeError: message" names the type, then the message. "Type in Place" names the type, then the code it was thrown in.
        const colon = spec.title.indexOf(":");
        const errorType = colon > 0 ? spec.title.slice(0, colon) : spec.title.split(" in ")[0]!;
        const culprit =
          colon > 0
            ? spec.title.slice(colon + 1).trim()
            : spec.title.split(" in ").slice(1).join(" in ");
        return {
          level: /EXC_BAD_ACCESS|OutOfMemory/.test(spec.title)
            ? "fatal"
            : spec.stage === "Ongoing"
              ? "warning"
              : "error",
          errorType,
          culprit,
          events: readCount(/([\d.,]+k?) events/) ?? this.between(20, 9000),
          users: readCount(/([\d.,]+k?) users/) ?? this.between(1, 400),
        };
      }
      case "calendar/invite":
        return {
          ...(spec.dueMin === undefined ? {} : { startsInMin: spec.dueMin }),
          durationMin: /1 h/.test(fact) ? 60 : /45/.test(fact) ? 45 : this.pick([30, 30, 45, 60]),
          guests: readCount(/(\d+) guests/) ?? this.between(2, 8),
          location: this.pick([
            "Google Meet",
            "Room Atlas",
            "Google Meet",
            "Seller office, Amsterdam",
          ]),
        };
      case "intercom/conversation":
        return {
          company: this.pick([
            "Kiln & Co",
            "Oakline Vintage",
            "Wildcard Comics",
            "Pip & Pine",
            "Saltmarsh Goods",
          ]),
          plan: this.pick(["Pro", "Starter", "Enterprise"]),
          ...(spec.turn === "you" ? { slaMin: this.between(-90, 240) } : {}),
        };
      case "pagerduty/incident":
        return { urgency: spec.stage === "Triggered" ? "high" : "low" };
      default:
        return {};
    }
  }

  /**
   * Invents a plausible history: the moves along the path for a track, the
   * spikes of a trend for a state, and the replies of a conversation for a
   * turn. The last change is at `waitMin`, because that is when the current
   * turn began.
   */
  buildChanges(t: {
    kind: Kind;
    stage: string;
    stageIndex: number;
    turn: Turn;
    asksYou: boolean;
    person: string;
    flags: readonly string[];
    trend?: readonly number[] | undefined;
    waitMin: number;
    openedMin: number;
  }): Change[] {
    const out: Change[] = [];
    const span = t.openedMin - t.waitMin;
    const at = (share: number): number => Math.round(t.openedMin - span * share);
    if (t.kind.stageWeight === "track") {
      const last = t.stageIndex === -1 ? t.kind.stages.length - 1 : t.stageIndex;
      // A Linear issue usually skips Triage when someone files it straight into a team.
      const first = t.kind.id === "linear/issue" ? Math.min(last, this.between(0, 2)) : 0;
      for (let i = first; i <= last; i++) {
        const share = last === first ? 1 : (i - first) / (last - first);
        const stage = i === last && t.stageIndex === -1 ? t.stage : t.kind.stages[i]!;
        out.push({
          atMin: at(share),
          label: i === first ? `Opened in ${stage}` : `Moved to ${stage}`,
          stage,
        });
      }
      for (const flag of t.flags)
        out.push({ atMin: Math.round(t.waitMin + span * 0.1), label: flag });
    } else if (t.kind.stageWeight === "state") {
      out.push({ atMin: t.openedMin, label: "First seen", stage: t.kind.stages[0] });
      if (t.trend) {
        const peak = Math.max(...t.trend);
        const day = t.trend.indexOf(peak);
        const peakAt = (13 - day) * D + 6 * H;
        if (peakAt < t.openedMin && peak > 20)
          out.push({ atMin: peakAt, label: `${String(peak)} events in a day` });
      }
      if (t.stage !== t.kind.stages[0])
        out.push({ atMin: t.waitMin, label: t.stage, stage: t.stage });
    } else {
      out.push({ atMin: t.openedMin, label: `Started by ${t.person}` });
      const replies = Math.min(6, Math.max(0, Math.round(Math.log2(span / 30 + 1))));
      for (let i = 1; i <= replies; i++) {
        out.push({ atMin: at(i / (replies + 1)), label: `${this.pick(PEOPLE)} replied` });
      }
      out.push({
        atMin: t.waitMin,
        label:
          t.turn === "you"
            ? t.asksYou
              ? `${t.person} is waiting on you`
              : "Your move"
            : t.turn === "them"
              ? "You replied"
              : "Went quiet",
      });
    }
    return out.sort((a, b) => b.atMin - a.atMin);
  }
}

const LAST_LOOK_MIN = 3 * H;

// ---------------------------------------------------------------------------
// Fable's twelve subjects, converted

const FABLE_SOURCE: Record<FableSourceId, SourceId> = {
  gmail: "gmail",
  linear: "linear",
  sentry: "sentry",
  github: "github",
  slack: "slack",
  discord: "discord",
  googlecalendar: "calendar",
  pagerduty: "pagerduty",
  intercom: "intercom",
  vercel: "vercel",
};

/** Converts one of Fable's drafts to a spec of the shared model. */
function convertDraft(draft: Draft): Spec {
  const source = FABLE_SOURCE[draft.source];
  const kind =
    Object.values(KINDS).find((k) => k.source === source && k.noun === draft.kind)?.id ??
    Object.values(KINDS).find((k) => k.source === source)!.id;
  const turn: Turn =
    draft.need === "you" || draft.need === "yours"
      ? "you"
      : draft.need === "waiting"
        ? "them"
        : "none";
  const flags: string[] = [];
  let stage = draft.status;
  let fact = draft.fact;
  switch (kind) {
    case "github/pull-request":
      if (draft.status === "Open") stage = "In review";
      if (draft.status === "Checks failing") {
        stage = "In review";
        flags.push("Checks failing");
      }
      if (draft.status === "Changes requested") {
        stage = "In review";
        flags.push("Changes requested");
      }
      break;
    case "slack/thread":
    case "discord/thread":
    case "gmail/thread":
    case "intercom/conversation":
      fact = fact ?? (/\d+ repl/.test(draft.status) ? draft.status : undefined);
      stage =
        draft.stage === "done" || draft.status === "Answered" || draft.stage === "quiet"
          ? "Quiet"
          : "Open";
      if (kind === "gmail/thread" || kind === "intercom/conversation")
        stage = stage === "Quiet" ? "Closed" : "Open";
      break;
    case "calendar/invite":
      stage = "Needs an answer";
      break;
    default:
      break;
  }
  return {
    kind,
    place: draft.place,
    title: draft.title,
    stage,
    turn,
    asksYou: draft.need === "you",
    reason: draft.reason,
    person: draft.person,
    waitMin: draft.ageMin,
    identifier: draft.ident,
    flags,
    fact,
    trend: draft.trend,
    ...(kind === "calendar/invite" ? { dueMin: 2 * D + 5 * H } : {}),
    ...(draft.isNew === undefined ? {} : { isNew: draft.isNew }),
  };
}

// ---------------------------------------------------------------------------
// Hand-written subjects with no lasting thing, and cases that break their
// kind's usual lifetime

const SPIKE = [2, 3, 2, 4, 3, 5, 4, 6, 9, 14, 31, 58, 96, 140];
const FLAT = [8, 9, 7, 8, 10, 9, 8, 9, 8, 7, 9, 8, 9, 8];
const BLIP = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 212];

const NO_LEAD_SUBJECTS: readonly { title: string; things: readonly Spec[] }[] = [
  {
    title: "Hiring: Noor Haddad, senior backend",
    things: [
      {
        kind: "gmail/thread",
        place: "Hiring",
        title: "Interview loop for Noor Haddad: your availability?",
        stage: "Open",
        turn: "you",
        reason: "Clara is waiting on your reply",
        person: "Clara",
        waitMin: 5 * H,
        openedMin: 3 * D,
        fact: "6 messages",
      },
      {
        kind: "calendar/invite",
        place: "Work",
        title: "Interview: Noor Haddad, system design",
        stage: "Needs an answer",
        turn: "you",
        reason: "Clara invited you · Thu 14:00",
        person: "Clara",
        waitMin: 4 * H,
        dueMin: 2 * D + 4 * H,
        fact: "1 h · 3 guests",
      },
      {
        kind: "slack/thread",
        place: "Direct messages",
        title: "Can you do the system design round Thursday? Noor is strong on queues",
        stage: "Open",
        turn: "you",
        reason: "Clara sent you a message",
        person: "Clara",
        waitMin: 40,
      },
    ],
  },
  {
    title: "Datadog renewal",
    things: [
      {
        kind: "gmail/thread",
        place: "Vendors",
        title: "Datadog renewal: quote for 2027 and the log volume tiers",
        stage: "Open",
        turn: "you",
        reason: "Ruben from Datadog is waiting on your reply",
        person: "Ruben (Datadog)",
        waitMin: 4 * D,
        openedMin: 9 * D,
        fact: "4 messages",
      },
      {
        kind: "calendar/invite",
        place: "Work",
        title: "Datadog renewal call",
        stage: "Needs an answer",
        turn: "you",
        reason: "Ruben invited you · yesterday 15:00",
        person: "Ruben (Datadog)",
        waitMin: 6 * D,
        dueMin: -18 * H,
        fact: "30 min",
      },
      {
        kind: "slack/thread",
        place: "#finance-eng",
        title: "Do we still need APM on the workers, or only logs? Renewal is in two weeks",
        stage: "Open",
        turn: "them",
        reason: "You asked, waiting on Hanna",
        person: "You",
        waitMin: 2 * D,
        fact: "3 replies",
      },
    ],
  },
  {
    title: "Payment webhook outage this morning",
    things: [
      {
        kind: "pagerduty/incident",
        place: "payments",
        title: "Payment webhooks failing: 5xx from /webhooks/adyen",
        stage: "Resolved",
        turn: "none",
        reason: "Resolved by Marta 40 minutes ago",
        person: "Marta",
        waitMin: 40,
        openedMin: 3 * H,
        identifier: "#4417",
        fact: "P1 · 2 h 20 min",
      },
      {
        kind: "slack/thread",
        place: "#incidents",
        title: "Adyen webhooks 5xx, rolling back 2026.11.10-2",
        stage: "Open",
        turn: "you",
        reason: "Marta asked you to write the timeline",
        person: "Marta",
        waitMin: 30,
        openedMin: 3 * H,
        fact: "22 replies",
      },
      {
        kind: "sentry/issue",
        place: "checkout-api",
        title: "KeyError: 'psp_reference' in AdyenWebhookHandler",
        stage: "Resolved",
        turn: "none",
        reason: "Lived 2 hours: resolved by the rollback",
        person: "Sentry",
        waitMin: 45,
        openedMin: 2 * H + 50,
        identifier: "CHECKOUT-API-4N1",
        fact: "212 events · 0 users",
        trend: BLIP,
      },
    ],
  },
];

/** Things that live much longer or shorter than their kind usually does. */
const ODD_LIFETIMES: readonly Spec[] = [
  {
    kind: "github/pull-request",
    place: "northwind/monorepo",
    title: "Move the flash sale search to OpenSearch 2",
    stage: "In review",
    turn: "them",
    reason: "Open 3 weeks, waiting on Ruth's second review",
    person: "You",
    waitMin: 5 * D,
    openedMin: 21 * D,
    identifier: "#51877",
    fact: "+2,104 −1,388 · 61 comments",
  },
  {
    kind: "sentry/issue",
    place: "media-worker",
    title: "TimeoutError in ImageResizeWorker after 30s",
    stage: "Ongoing",
    turn: "none",
    reason: "Ongoing for 4 months, about 8 a day",
    person: "Sentry",
    waitMin: 9 * D,
    openedMin: 122 * D,
    identifier: "MEDIA-WORKER-2A",
    fact: "1,006 events · 88 users",
    trend: FLAT,
  },
  {
    kind: "slack/thread",
    place: "#backend",
    title: "Should we split monorepo CI by package? Long thread, read the summary at the top",
    stage: "Open",
    turn: "you",
    reason: "Jonas mentioned you again, day 6 of this thread",
    person: "Jonas",
    waitMin: 20,
    openedMin: 6 * D,
    fact: "40 replies",
    changes: [
      { atMin: 6 * D, label: "Started by Jonas" },
      { atMin: 6 * D - 2 * H, label: "11 replies" },
      { atMin: 5 * D, label: "You replied" },
      { atMin: 4 * D, label: "8 replies" },
      { atMin: 2 * D, label: "Ruth posted a summary" },
      { atMin: 1 * D, label: "14 replies" },
      { atMin: 20, label: "Jonas mentioned you" },
    ],
  },
  {
    kind: "gmail/thread",
    place: "Legal",
    title: "Re: Seller partnership agreement 2027, redlines round 4",
    stage: "Open",
    turn: "you",
    reason: "Legal is waiting on your answer to clause 7.2",
    person: "Hanna (Legal)",
    waitMin: 2 * D,
    openedMin: 61 * D,
    fact: "23 messages",
  },
  {
    kind: "sentry/issue",
    place: "storefront-web",
    title: "ChunkLoadError: Loading chunk 812 failed",
    stage: "Escalating",
    turn: "you",
    reason: "Escalating: 140 today, assigned to you",
    person: "Sentry",
    waitMin: 5 * H,
    openedMin: 14 * D,
    identifier: "STOREFRONT-WEB-8D",
    fact: "1,920 events · 1,204 users",
    trend: SPIKE,
  },
];

// ---------------------------------------------------------------------------
// The seeded tail

const TEAMS: readonly (readonly [string, string])[] = [
  ["Backend", "BE"],
  ["Platform", "PLA"],
  ["Frontend", "FRO"],
  ["Mobile", "MOB"],
  ["Search", "SRCH"],
  ["Finance", "FIN"],
  ["Data", "DATA"],
];
const REPOS = [
  "northwind/monorepo",
  "northwind/monorepo",
  "northwind/monorepo",
  "northwind/infra",
  "northwind/mobile-app",
  "ferrule/ferrule",
];
const SENTRY_PROJECTS = [
  "checkout-api",
  "storefront-web",
  "finance-worker",
  "mobile-ios",
  "mobile-android",
  "search-api",
  "media-worker",
];
const CHANNELS = [
  "#backend",
  "#platform",
  "#incidents",
  "#deploys",
  "#mobile",
  "#frontend",
  "#finance-eng",
  "Direct messages",
  "#random",
  "#releases",
];
const DISCORD = ["Bun · #help", "Effect · #help", "Effect · #contributors", "Bun · #general"];
const LABELS = ["Inbox", "Customers", "Vendors", "Finance", "Hiring", "Newsletters"];
const VERBS = [
  "Remove",
  "Move",
  "Fix",
  "Add",
  "Split",
  "Cache",
  "Validate",
  "Speed up",
  "Log",
  "Drop",
];
const OBJECTS = [
  "the unused GetOrdersBySellerAsync endpoint",
  "the flash sale countdown on iOS",
  "payout reconciliation for late batches",
  "the seller page season calendar",
  "facets by seller in search",
  "the old product-condition enum",
  "the CMS preview tokens",
  "the finance internal client",
  "type warnings in Northwind.Catalog",
  "retry logic in the Adyen webhook",
  "the lint config for the web app",
  "the Effect 4 layer for flash sales",
  "bid history pagination",
  "the shipping label PDF",
];
const ERRORS = [
  "NullReferenceException in OrderMapper.Map",
  "TimeoutError: upstream request exceeded 30s",
  "KeyError: 'shipping_address'",
  "RangeError: Invalid time value",
  "ECONNRESET on redis.get",
  "Unhandled rejection: 429 Too Many Requests",
  "IntegrityError: duplicate key value",
  "SyntaxError: Unexpected token < in JSON",
];
const ASKS = [
  "Can you take a look at the {o} before 3pm?",
  "Who owns {o} these days?",
  "Is it safe to drop {o} this week?",
  "Quick sanity check on {o}?",
  "Any objection to merging {o} today?",
];
const MAIL = [
  "Re: Invoice for {o}",
  "Question about {o}",
  "Re: Seller office asks about {o}",
  "Contract renewal: {o}",
];
const MAIL_TOPICS = [
  "the Q1 flash sale calendar",
  "product handover dates",
  "the October payout report",
  "a refund for order 88231",
  "the seller partnership agreement",
  "the the CMS quote",
  "your talk at the Effect meetup",
  "VAT on orders shipped to Norway",
  "API access for a reseller",
  "a signed product that arrived damaged",
];
const LOAD_FACTOR: Record<Load, number> = { light: 0.4, heavy: 1.8, extreme: 5 };

/** Picks a wait: most recent, a long tail weeks old. */
function pickWait(b: Builder, maxDays: number): number {
  const u = b.random();
  return Math.max(
    3,
    Math.round(Math.exp(Math.log(3) + u * u * (Math.log(maxDays * D) - Math.log(3)))),
  );
}

function buildTail(b: Builder, load: Load): void {
  const f = LOAD_FACTOR[load];
  const counter = new Map<string, number>();
  const next = (key: string, start: number): number => {
    const n = (counter.get(key) ?? start) + b.between(1, 6);
    counter.set(key, n);
    return n;
  };
  const object = (): string => b.pick(OBJECTS);

  // Linear issues, many with a pull request or two that ride on them.
  for (let i = 0; i < Math.round(110 * f); i++) {
    const [team, key] = b.pick(TEAMS);
    const stage = b.pick([
      "Triage",
      "Backlog",
      "Backlog",
      "Todo",
      "Todo",
      "In Progress",
      "In Progress",
      "In Review",
      "Done",
    ]);
    const mine = b.random() < 0.55;
    const title = `${b.pick(VERBS)} ${object()}`;
    const subject =
      b.random() < 0.4 && stage !== "Triage" && stage !== "Backlog"
        ? `tail-${String(i)}`
        : undefined;
    const issue = b.add(
      {
        kind: "linear/issue",
        place: team,
        title,
        stage,
        turn: mine ? "you" : "none",
        asksYou: stage === "Triage" && mine,
        reason: mine
          ? stage === "Triage"
            ? `${b.pick(PEOPLE)} asks you to triage it`
            : "Assigned to you"
          : `${b.pick(PEOPLE)} mentioned you`,
        person: mine ? "You" : b.pick(PEOPLE),
        waitMin: pickWait(b, 30),
        identifier: `${key}-${String(next(key, 300))}`,
        ...(b.random() < 0.15 ? { dueMin: b.between(-2, 10) * D } : {}),
      },
      subject,
    );
    if (subject !== undefined) {
      const prs = b.between(1, 2);
      for (let p = 0; p < prs; p++) {
        const prStage =
          issue.stage === "Done"
            ? "Merged"
            : b.pick(["Draft", "In review", "In review", "Approved"]);
        const flags =
          prStage === "In review" && b.random() < 0.3
            ? [b.pick(["Checks failing", "Changes requested"])]
            : [];
        b.add(
          {
            kind: "github/pull-request",
            place: b.pick(REPOS),
            title: p === 0 ? title : `${b.pick(VERBS)} ${object()}`,
            stage: prStage,
            turn: prStage === "Merged" ? "none" : flags.length > 0 ? "you" : "them",
            asksYou: false,
            reason:
              flags.length > 0
                ? `${flags[0]!} on your pull request`
                : prStage === "Approved"
                  ? "Approved, ready to merge"
                  : `Waiting on ${b.pick(PEOPLE)}'s review`,
            person: "You",
            waitMin: pickWait(b, 8),
            identifier: `#${String(next("pr", 51900))}`,
            flags,
          },
          subject,
        );
      }
      if (b.random() < 0.3) {
        const person = b.pick(PEOPLE);
        b.add(
          {
            kind: "slack/thread",
            place: b.pick(CHANNELS),
            title: b.pick(ASKS).replace("{o}", object()),
            stage: "Open",
            turn: b.random() < 0.5 ? "you" : "none",
            reason: `${person} mentioned you`,
            person,
            waitMin: pickWait(b, 4),
            fact: `${String(b.between(1, 20))} replies`,
          },
          subject,
        );
      }
    }
  }

  // Review requests from others, which do not ride on anything.
  for (let i = 0; i < Math.round(60 * f); i++) {
    const person = b.pick(PEOPLE);
    const merged = b.random() < 0.15;
    b.add({
      kind: "github/pull-request",
      place: b.pick(REPOS),
      title: `${b.pick(VERBS)} ${object()}`,
      stage: merged ? "Merged" : b.random() < 0.2 ? "Draft" : "In review",
      turn: merged ? "none" : "you",
      reason: merged ? `${person} merged it` : `${person} asked for your review`,
      person,
      waitMin: pickWait(b, 14),
      identifier: `#${String(next("pr", 51900))}`,
    });
  }

  // Errors.
  for (let i = 0; i < Math.round(45 * f); i++) {
    const stage = b.pick(["New", "Escalating", "Ongoing", "Ongoing", "Regressed", "Resolved"]);
    const loud = stage === "New" || stage === "Escalating" || stage === "Regressed";
    // A quarter of the errors come from the second Sentry account, the open source org.
    const oss = b.random() < 0.25;
    const project = oss ? b.pick(["ferrule-cli", "ferrule-registry"]) : b.pick(SENTRY_PROJECTS);
    const trend =
      stage === "Escalating"
        ? SPIKE
        : stage === "Resolved"
          ? [...SPIKE].reverse()
          : FLAT.map((n) => n + b.between(-4, 6));
    b.add({
      kind: "sentry/issue",
      place: project,
      title: b.pick(ERRORS),
      stage,
      turn: loud && b.random() < 0.6 ? "you" : "none",
      reason: loud
        ? `${stage}, and ownership rules point at you`
        : stage === "Resolved"
          ? "Resolved in the last release"
          : "Ongoing",
      person: "Sentry",
      waitMin: pickWait(b, 20),
      openedMin: b.between(1, 120) * D,
      identifier: `${project.toUpperCase()}-${next(project, 900).toString(36).toUpperCase()}`,
      trend,
      fact: `${String(b.between(20, 9000))} events`,
      ...(oss ? { connection: "sentry-oss" } : {}),
    });
  }

  // Chat.
  for (let i = 0; i < Math.round(120 * f); i++) {
    const person = b.pick(PEOPLE);
    const discord = b.random() < 0.3;
    const turn: Turn = b.random() < 0.45 ? "you" : b.random() < 0.3 ? "them" : "none";
    b.add({
      kind: discord ? "discord/thread" : "slack/thread",
      place: discord ? b.pick(DISCORD) : b.pick(CHANNELS),
      title: b.pick(ASKS).replace("{o}", object()),
      stage: turn === "none" && b.random() < 0.5 ? "Quiet" : "Open",
      turn,
      reason:
        turn === "you"
          ? `${person} mentioned you`
          : turn === "them"
            ? `You asked, waiting on ${person}`
            : `${person} posted`,
      person,
      waitMin: pickWait(b, 5),
      fact: `${String(b.between(0, 30))} replies`,
      ...(discord ? { connection: b.random() < 0.5 ? "discord-bun" : "discord-effect" } : {}),
    });
  }

  // Mail and support.
  for (let i = 0; i < Math.round(70 * f); i++) {
    const person = b.pick(PEOPLE);
    const support = b.random() < 0.25;
    const turn: Turn = b.random() < 0.4 ? "you" : b.random() < 0.4 ? "them" : "none";
    b.add({
      kind: support ? "intercom/conversation" : "gmail/thread",
      place: support ? b.pick(["Support", "Escalations"]) : b.pick(LABELS),
      title: b.pick(MAIL).replace("{o}", b.pick(MAIL_TOPICS)),
      stage: turn === "none" ? "Closed" : "Open",
      turn,
      reason:
        turn === "you"
          ? `${person} is waiting on your reply`
          : turn === "them"
            ? `You replied, waiting on ${person}`
            : `From ${person}`,
      person,
      waitMin: pickWait(b, 25),
      fact: `${String(b.between(1, 9))} messages`,
    });
  }

  // Incidents and invites.
  for (let i = 0; i < Math.round(8 * f); i++) {
    const stage = b.pick(["Triggered", "Acknowledged", "Resolved", "Resolved"]);
    b.add({
      kind: "pagerduty/incident",
      place: b.pick(["checkout-api", "payments", "search-api"]),
      title: b.pick([
        "High error rate",
        "p95 latency above 2s",
        "Health check failing in eu-west-1",
        "Queue depth above 5,000",
      ]),
      stage,
      turn: stage === "Triggered" ? "you" : "none",
      reason:
        stage === "Triggered"
          ? "You are on call"
          : stage === "Acknowledged"
            ? `${b.pick(PEOPLE)} acknowledged it`
            : "Resolved",
      person: b.pick(PEOPLE),
      waitMin: pickWait(b, 3),
      identifier: `#${String(next("pd", 4400))}`,
    });
  }
  for (let i = 0; i < Math.round(10 * f); i++) {
    const person = b.pick(PEOPLE);
    const answered = b.random() < 0.3;
    b.add({
      kind: "calendar/invite",
      place: "Work",
      title: b
        .pick([
          "1:1 with {p}",
          "Backend sync",
          "Design crit: seller pages",
          "Incident review: checkout 500s",
          "Q1 planning: flash sales",
        ])
        .replace("{p}", person),
      stage: answered ? "Answered" : "Needs an answer",
      turn: answered ? "none" : "you",
      reason: `${person} invited you`,
      person,
      waitMin: pickWait(b, 6),
      dueMin: b.between(-3, 12) * D + b.between(1, 8) * H,
    });
  }
}

// ---------------------------------------------------------------------------
// Linear initiatives and projects, with everyone's issues

interface ProjectPlan {
  readonly name: string;
  readonly team: string;
  readonly key: string;
  readonly lead: string;
  readonly health: Health;
  readonly targetDays: number;
  /** Words that put one of the user's issues in this project when its title has them. */
  readonly match: readonly string[];
  /** What other people's issues in the project are about. */
  readonly topics: readonly string[];
  readonly update: string;
}

const INITIATIVE_PLANS: readonly {
  readonly name: string;
  readonly owner: string;
  readonly target: string;
  readonly projects: readonly ProjectPlan[];
}[] = [
  {
    name: "Checkout reliability",
    owner: "Marta",
    target: "End of Q4",
    projects: [
      {
        name: "Gift card settlement",
        team: "Backend",
        key: "BE",
        lead: "Priya",
        health: "at risk",
        targetDays: 9,
        match: ["gift card", "giftcard", "checkout fails"],
        topics: [
          "partial gift card refunds",
          "the gift card ledger",
          "settlement retries",
          "gift card balance on the receipt",
          "double charges at payment",
        ],
        update:
          "The settlement fix is in review, but the Adyen sandbox is down, so we cannot test the double charge.",
      },
      {
        name: "Payment webhooks hardening",
        team: "Platform",
        key: "PLA",
        lead: "Marta",
        health: "on track",
        targetDays: 21,
        match: ["webhook", "adyen", "carrier"],
        topics: [
          "webhook signature checks",
          "the webhook dead-letter queue",
          "idempotency keys for webhooks",
          "webhook replay tooling",
        ],
        update: "Signed routes are live for the carrier. Adyen is next week.",
      },
      {
        name: "Payout reconciliation",
        team: "Finance",
        key: "FIN",
        lead: "Hanna",
        health: "off track",
        targetDays: -3,
        match: ["payout", "reconciliation"],
        topics: [
          "late payout batches",
          "the payout report time zone",
          "ledger totals per seller",
          "payout CSV export",
        ],
        update:
          "We missed the target: three September payouts are still a day off. New date after the close.",
      },
    ],
  },
  {
    name: "Flash sales on Effect 4",
    owner: "Jonas",
    target: "Mid Q1",
    projects: [
      {
        name: "Workers to Effect 4",
        team: "Platform",
        key: "PLA",
        lead: "Jonas",
        health: "on track",
        targetDays: 34,
        match: ["effect 4", "layer"],
        topics: [
          "the flash sales worker layers",
          "the mail worker on Effect 4",
          "Effect 4 test helpers",
          "scoped resources in the workers",
        ],
        update: "Two of five workers are on Effect 4. The flash sales worker is the big one.",
      },
      {
        name: "Flash sale countdown rewrite",
        team: "Mobile",
        key: "MOB",
        lead: "Yuki",
        health: "at risk",
        targetDays: 12,
        match: ["countdown", "flash sale detail"],
        topics: [
          "the countdown on Android",
          "server time drift",
          "the last-minute bid extension",
          "countdown accessibility",
        ],
        update: "The iOS 19 crash pushed the rewrite back a week.",
      },
      {
        name: "Bid history service",
        team: "Backend",
        key: "BE",
        lead: "Kwame",
        health: "on track",
        targetDays: 45,
        match: ["bid history"],
        topics: [
          "bid history pagination",
          "the bid history API",
          "bid history caching",
          "bid history export for sellers",
        ],
        update: "The read side is done. Writes move over in December.",
      },
    ],
  },
  {
    name: "Seller partnerships Q1",
    owner: "Clara",
    target: "End of Q1",
    projects: [
      {
        name: "Season calendar on seller pages",
        team: "Search",
        key: "SRCH",
        lead: "Sofia",
        health: "on track",
        targetDays: 28,
        match: ["season calendar", "seller page", "handover"],
        topics: [
          "match dates from the seller feed",
          "the calendar on mobile",
          "product handover dates",
          "calendar sharing links",
        ],
        update: "Design is signed off. The seller feed import is being built.",
      },
      {
        name: "the CMS editorial pages",
        team: "Frontend",
        key: "FRO",
        lead: "Dev",
        health: "at risk",
        targetDays: 40,
        match: ["cms", "editorial"],
        topics: [
          "the CMS preview",
          "the editorial page templates",
          "the CMS SSO",
          "image crops in the CMS",
        ],
        update: "Waiting on the enterprise quote before we commit.",
      },
      {
        name: "Search by seller",
        team: "Search",
        key: "SRCH",
        lead: "Noor",
        health: "off track",
        targetDays: 6,
        match: ["facet", "search"],
        topics: [
          "facets by seller",
          "search p95",
          "the search index for products",
          "seller name synonyms",
        ],
        update: "p95 doubled after the facet change. Reverting is on the table.",
      },
    ],
  },
  {
    name: "Backend cleanup",
    owner: "Ruth",
    target: "Ongoing",
    projects: [
      {
        name: "Dead code removal",
        team: "Backend",
        key: "BE",
        lead: "Ruth",
        health: "on track",
        targetDays: 60,
        match: ["dead", "unused", "obsolete"],
        topics: [
          "unused endpoints in catalog",
          "dead feature flags",
          "the old product-condition enum",
          "unused MediatR handlers",
        ],
        update: "142 endpoints removed so far. The finder runs in CI now.",
      },
      {
        name: "Type warnings to zero",
        team: "Backend",
        key: "BE",
        lead: "Lars",
        health: "on track",
        targetDays: 50,
        match: ["type"],
        topics: [
          "type warnings in Catalog",
          "type warnings in Finance",
          "type warnings in Sports",
          "warnings as errors in CI",
        ],
        update: "Down from 1,900 to 412 warnings.",
      },
      {
        name: "CI under two minutes",
        team: "Platform",
        key: "PLA",
        lead: "Felix",
        health: "at risk",
        targetDays: 15,
        match: ["ci", "install", "lint", "bun"],
        topics: [
          "the marketplace install step",
          "test sharding",
          "the Docker layer cache",
          "flaky e2e shards",
        ],
        update: "Install is down to 70 seconds with Bun. Tests are the rest.",
      },
    ],
  },
];

/**
 * Builds the initiatives and projects, puts each of the user's Linear issues
 * in the first project whose words its title has, and adds other people's
 * issues to every project. Those are built with `concernsYou: false`, so they
 * never reach the Inbox views; the bigger picture reads them through the
 * projects.
 */
function buildProjects(b: Builder): Initiative[] {
  const mine = b.things.filter((t) => t.kind.id === "linear/issue");
  const STAGE_MIX = [
    "Done",
    "Done",
    "Done",
    "In Review",
    "In Progress",
    "In Progress",
    "Todo",
    "Todo",
    "Backlog",
    "Triage",
  ];
  const counter = new Map<string, number>();
  return INITIATIVE_PLANS.map((plan, i) => {
    const initiativeId = `initiative-${String(i)}`;
    return {
      id: initiativeId,
      name: plan.name,
      owner: plan.owner,
      target: plan.target,
      projects: plan.projects.map((pp, j): Project => {
        const id = `${initiativeId}-project-${String(j)}`;
        const own = mine.filter(
          (t) =>
            t.projectId === undefined && pp.match.some((m) => t.title.toLowerCase().includes(m)),
        );
        for (const t of own) t.projectId = id;
        const theirs: Thing[] = [];
        const count = b.between(9, 20);
        for (let n = 0; n < count; n++) {
          const stage = b.pick(STAGE_MIX);
          const person = b.random() < 0.12 ? "Unassigned" : b.pick(PEOPLE);
          const num = (counter.get(pp.key) ?? 500) + b.between(1, 9);
          counter.set(pp.key, num);
          const t = b.add({
            kind: "linear/issue",
            place: pp.team,
            title: `${b.pick(["Fix", "Add", "Move", "Speed up", "Test", "Split", "Clean up", "Document"])} ${b.pick(pp.topics)}`,
            stage,
            turn: "none",
            reason: person === "Unassigned" ? "Nobody has it yet" : `${person} has it`,
            person,
            waitMin: b.between(30, 20 * 24 * 60),
            identifier: `${pp.key}-${String(num)}`,
            concernsYou: false,
            face: { assignee: person },
          });
          t.projectId = id;
          theirs.push(t);
        }
        return {
          id,
          name: pp.name,
          initiativeId,
          team: pp.team,
          lead: pp.lead,
          health: pp.health,
          targetMin: pp.targetDays * D,
          update: { by: pp.lead, atMin: b.between(2, 96) * 60, text: pp.update },
          issues: [...own, ...theirs],
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// The world

/** Builds the world for a load. The same load always builds the same world. */
export function buildWorld(load: Load): World {
  const b = new Builder(1105);
  const subjects: Subject[] = [];
  const addSubject = (id: string, title: string, things: Thing[]): void => {
    for (const a of things) a.links = things.filter((o) => o !== a).map((o) => o.id);
    // The lead is a lasting thing that is still open: a settled one, such as an
    // error resolved within hours, leads nothing.
    const open = things.filter((t) => t.kind.lifetime === "lasting" && !t.settled);
    const lead = open.find((t) => t.kind.stageWeight === "track") ?? open[0];
    subjects.push({ id, title, things, lead });
  };

  SUBJECT_DRAFTS.forEach((draft, i) => {
    const id = `fable-${String(i)}`;
    addSubject(
      id,
      draft.title,
      draft.things.map((d) => b.add(convertDraft(d), id)),
    );
  });
  NO_LEAD_SUBJECTS.forEach((s, i) => {
    const id = `nolead-${String(i)}`;
    addSubject(
      id,
      s.title,
      s.things.map((spec) => b.add(spec, id)),
    );
  });
  for (const spec of ODD_LIFETIMES) b.add(spec);

  buildTail(b, load);
  const tailSubjects = new Map<string, Thing[]>();
  for (const t of b.things) {
    if (t.subject?.startsWith("tail-"))
      tailSubjects.set(t.subject, [...(tailSubjects.get(t.subject) ?? []), t]);
  }
  for (const [id, things] of tailSubjects) addSubject(id, things[0]!.title, things);
  const initiatives = buildProjects(b);
  const inbox = b.things.filter((t) => t.concernsYou);

  return {
    load,
    sources: SOURCES,
    kinds: Object.values(KINDS),
    places: [...b.places.values()],
    things: inbox,
    subjects,
    byId: new Map(b.things.map((t) => [t.id, t])),
    lastLookMin: LAST_LOOK_MIN,
    initiatives,
    projects: initiatives.flatMap((i) => i.projects),
    others: b.things.filter((t) => !t.concernsYou),
  };
}

// ---------------------------------------------------------------------------
// Readings every variant may use

/** Returns the share of its patience a thing has used: 0 when it is not the user's turn, above 1 when late. */
export function measurePressure(thing: Thing): number {
  return Number.isFinite(thing.patienceMin) ? thing.waitMin / thing.patienceMin : 0;
}

/** Checks whether a standing thing has run past its patience and now presses. */
export function isPressing(thing: Thing): boolean {
  return thing.kind.onOverdue === "presses" && thing.turn === "you" && measurePressure(thing) > 1;
}

/** Formats minutes in the short form of a thread row: "4m", "3h", "2d", "3w", "4mo". */
export function formatWait(min: number): string {
  const m = Math.abs(min);
  if (m < 60) return `${String(Math.max(1, Math.round(m)))}m`;
  if (m < D) return `${String(Math.round(m / 60))}h`;
  if (m < 14 * D) return `${String(Math.round(m / D))}d`;
  if (m < 60 * D) return `${String(Math.round(m / (7 * D)))}w`;
  return `${String(Math.round(m / (30 * D)))}mo`;
}

/** Formats a count with grouped digits. */
export function formatCount(n: number): string {
  return n.toLocaleString("en");
}
