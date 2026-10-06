/**
 * PROTOTYPE (#448). The assistants, their Conversations and what each one
 * keeps between turns, as the Bureau book's desktop/assistant.html draws
 * them. Throwaway: nothing here is read from the contract.
 *
 * The clock is the specimens' fixed clock: Tuesday 29 September 2026, 09:41.
 */
import type { Pose } from "@hercule/client-core";
import { buildLook, type Look } from "../../faces";
import { FIX_THREAD_ID } from "../sidebar-fixture";

/** An assistant as the prototype draws it. */
export interface PrototypeAssistant {
  readonly id: string;
  readonly name: string;
  readonly look: Look;
  /** The line under the name in the header. */
  readonly role: string;
  /** The pose its sidebar row shows when the screen does not set one. */
  readonly pose: Pose;
}

// Ids picked so that `buildLook` gives each one the hue the book casts it in:
// Ada iris, Milo teal, Juno orchid, Hercule sky.
const assistant = (id: string, name: string, role: string, pose: Pose): PrototypeAssistant => ({
  id,
  name,
  look: buildLook(id),
  role,
  pose,
});

export const ADA = assistant(
  "01a0ec64-6e80-7000-8000-a00000000010",
  "Ada",
  "personal assistant",
  "working",
);
export const MILO = assistant(
  "01a0ec64-6e80-7000-8000-a0000000003b",
  "Milo",
  "ops assistant",
  "working",
);
export const JUNO = assistant(
  "01a0ec64-6e80-7000-8000-a0000000001e",
  "Juno",
  "research assistant",
  "asleep",
);
export const HERCULE = assistant(
  "01a0ec64-6e80-7000-8000-a0000000004c",
  "Hercule",
  "the assistant setup made",
  "idle",
);

export const ASSISTANTS = [ADA, MILO, JUNO, HERCULE] as const;

export const FIX_THREAD_LOOK = buildLook(FIX_THREAD_ID);
export { FIX_THREAD_ID };

/** One entry of a Conversation, top to bottom. */
export type Entry =
  | { readonly kind: "stamp"; readonly key: string; readonly text: string }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly pose: Pose;
      readonly lead: string;
      readonly text: string;
      readonly time: string;
    }
  | { readonly kind: "quiet"; readonly key: string; readonly text: string }
  | { readonly kind: "me"; readonly key: string; readonly text: string; readonly time: string }
  | {
      readonly kind: "agent";
      readonly key: string;
      /** Markdown, paragraphs split by a blank line. A paragraph may start with `@Milo `. */
      readonly text: string;
      /** The meta beside the name: "09:20", "heartbeat · 09:00". */
      readonly label: string;
      readonly extra?: Extra | undefined;
    };

/** What a message carries under its text. */
export type Extra =
  | { readonly kind: "refs" }
  | { readonly kind: "reminder"; readonly title: string; readonly when: string }
  | { readonly kind: "action"; readonly label: string; readonly sends: string };

const YESTERDAY: ReadonlyArray<Entry> = [
  { kind: "stamp", key: "s-yesterday", text: "Yesterday" },
  {
    kind: "notice",
    key: "n-timeout",
    pose: "failed",
    lead: "Ada was interrupted:",
    text: "her turn failed: provider timeout after 120s. Your last message was kept.",
    time: "22:14",
  },
];

const MORNING: ReadonlyArray<Entry> = [
  { kind: "stamp", key: "s-today", text: "Today" },
  { kind: "quiet", key: "q-morning", text: "2 quiet check-ins · 07:00 · 08:00" },
  {
    kind: "agent",
    key: "a-heartbeat",
    label: "heartbeat · 09:00",
    text:
      "Morning Rogier. Triage found one urgent thing: EU card payments that need 3‑D Secure " +
      "have failed since yesterday's deploy. You started a fix at 09:02; it's waiting on your OK " +
      "to push. Also: Marta at Brightline wants her invoice in the company name - I can draft that.",
    extra: { kind: "refs" },
  },
  {
    kind: "me",
    key: "m-ssl",
    text: "Remind me Friday to renew the SSL cert for ops.",
    time: "09:20",
  },
  {
    kind: "agent",
    key: "a-ssl",
    label: "09:20",
    text: "Done. Reminder set for Friday 2 October, 09:00: renew the SSL cert for ops.",
    extra: {
      kind: "reminder",
      title: "Renew the SSL cert for ops",
      when: "Fri 2 Oct · 09:00 · to Web chat",
    },
  },
  { kind: "me", key: "m-backup", text: "What's the status of the backup job?", time: "09:38" },
];

/** Ada's answer about the backup job, which the default state streams. */
export const BACKUP_ANSWER =
  "@Milo started an investigation at 09:35 on build-box-1. So far: the backup job's `pg_dump` " +
  "has been slower each night since the table `events` passed 40 GB, and last night it ran " +
  "past the end of its window, finishing at 05:12.\n\n" +
  "Two ways out, both small:\n\n" +
  "- **Dump `events` on its own** with `--jobs 4`, which Milo measured at 38 minutes instead of 71.\n" +
  "- **Archive events older than 90 days** to B2 first, which brings the table back under 12 GB.\n\n" +
  "Milo is trying the first one on a copy now. I'll tell you when the number is in - or say " +
  "*go* and I'll have Milo switch tonight's backup to whichever is faster.";

/** Where the book's still frame cuts the backup answer off. */
export const BACKUP_ANSWER_CUT = BACKUP_ANSWER.indexOf(" passed 40 GB") + " passed 40 GB".length;

/** Ada's Conversation as each state opens it. The open message, if any, is added by the screen. */
export const ADA_CONVERSATION: ReadonlyArray<Entry> = [...YESTERDAY, ...MORNING];

/** Ada's Conversation once the backup answer has finished. */
export const ADA_SETTLED: ReadonlyArray<Entry> = [
  ...ADA_CONVERSATION,
  { kind: "agent", key: "a-backup", label: "09:39", text: BACKUP_ANSWER },
];

export const MILO_CONVERSATION: ReadonlyArray<Entry> = [
  { kind: "stamp", key: "s-today", text: "Today" },
  { kind: "quiet", key: "q-morning", text: "8 quiet check-ins · every 15 minutes since 07:30" },
  {
    kind: "agent",
    key: "a-alert",
    label: "heartbeat · 09:30",
    text:
      "The nightly backup on build-box-1 finished at 05:12, 72 minutes past its window. " +
      "It is the third night in a row. I'm looking into it now; Ada knows.",
  },
  {
    kind: "me",
    key: "m-thanks",
    text: "Thanks. Don't change anything in production without asking.",
    time: "09:34",
  },
];

export const MILO_ANSWER =
  "Understood - I'm only reading. `pg_dump` spends 61 of its 71 minutes on the table " +
  "`events`. I'm timing a parallel dump on a copy of last night's snapshot now.";

export const JUNO_CONVERSATION: ReadonlyArray<Entry> = [
  { kind: "stamp", key: "s-monday", text: "Monday" },
  {
    kind: "me",
    key: "m-ideal",
    text: "Can you find out what iDEAL 2.0 changes for a Stripe shop?",
    time: "16:02",
  },
  {
    kind: "agent",
    key: "a-ideal",
    label: "16:09",
    text:
      "Short version: nothing you need to do before 2027. iDEAL 2.0 moves payers to a bank app " +
      "login with a stored account, and Stripe handles the switch on its side.\n\n" +
      "- **Checkout stays the same** - the Payment Element shows the new flow by itself.\n" +
      "- **Refunds** stay at 5 days.\n" +
      "- **Recurring iDEAL** becomes possible through SEPA mandates, which you asked about in May.\n\n" +
      "I wrote the details into my *payments* topic.",
  },
];

/** A heartbeat in the rail's strip, 07:00 to 23:00. */
export type Beat = "quiet" | "spoke" | "future";

/** Ada's heartbeats, one per hour from 07:00. */
export const ADA_BEATS: ReadonlyArray<Beat> = [
  "quiet",
  "quiet",
  "spoke",
  ...Array.from({ length: 14 }, () => "future" as const),
];

export interface Reminder {
  readonly key: string;
  readonly when: string;
  readonly title: string;
  readonly repeat?: string;
}

export const ADA_REMINDERS: ReadonlyArray<Reminder> = [
  { key: "r-accountant", when: "Thu 16:00", title: "Call the accountant" },
  { key: "r-ssl", when: "Fri 09:00", title: "Renew the SSL cert for ops" },
  { key: "r-revenue", when: "Mon 08:30", title: "Weekly revenue summary", repeat: "every week" },
];

export interface Topic {
  readonly name: string;
  readonly size: string;
  readonly summary: string;
  /** What the topic holds, shown when it is opened. */
  readonly body: string;
}

export const ADA_CORE_NOTE =
  "Rogier runs Acme alone with agents. Projects: webshop, payments-api, ops. Be brief. " +
  "Never deploy on Fridays. Ask before spending money. Mornings are for deep work.";

export const ADA_TOPICS: ReadonlyArray<Topic> = [
  {
    name: "work-style",
    size: "1.2k",
    summary: "Prefers short answers; decides fast; hates long preambles",
    body: "Answers first, reasons after. One question at a time. No emoji. Bullet lists over tables.",
  },
  {
    name: "webshop",
    size: "3.4k",
    summary: "Stripe checkout, EU customers mostly NL/DE; deploys on weekdays only",
    body: "Next.js on Vercel, Stripe Payment Element. 68% of orders from NL, 21% DE. Deploy window Mon-Thu.",
  },
  {
    name: "payments-api",
    size: "2.1k",
    summary: "Owns webhooks + payouts; v2.x; publish via npm",
    body: "Webhooks retried 3x with backoff. Payouts every Monday. Releases tagged v2.x, published by CI.",
  },
  {
    name: "ops",
    size: "1.8k",
    summary: "Backups nightly 04:00 to B2; certs on status.acme.dev",
    body: "pg_dump at 04:00, window ends 05:00. B2 bucket acme-backups. Certs renew by hand, owner Rogier.",
  },
  {
    name: "customers",
    size: "2.7k",
    summary: "Marta @ Brightline (invoices), Jonas @ Kiteworks (API limits)",
    body: "Marta: invoices in the company name from October. Jonas: wants 600 req/min, on 300 today.",
  },
];

/** Formats a moment of the fixed clock as "09:41". */
export const formatClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
