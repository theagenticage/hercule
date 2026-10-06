/**
 * PROTOTYPE (#448). A Conversation that plays itself: the user sends, the
 * assistant thinks, then writes its answer token by token. Everything lives
 * in memory; nothing reaches a controller.
 */
import { useCallback, useEffect, useState } from "react";
import type { Pose } from "@hercule/client-core";
import {
  ADA_BEATS,
  ADA_REMINDERS,
  formatClock,
  type Beat,
  type Entry,
  type Extra,
  type Reminder,
} from "./fixture";
import { SPECIMEN_NOW } from "../sidebar-fixture";

/** The message the assistant is writing. */
export interface OpenMessage {
  readonly key: string;
  readonly text: string;
  /** How many characters of `text` are written. */
  readonly shown: number;
  readonly label: string;
  /** Thinking until the first token, waking first when the assistant was asleep. */
  readonly phase: "waking" | "thinking" | "writing";
  readonly extra?: Extra | undefined;
  /** `performance.now()` when the turn started. */
  readonly startedAt: number;
}

export interface ConversationSetup {
  readonly entries: ReadonlyArray<Entry>;
  /** A message already being written as the page opens. */
  readonly open?: { readonly text: string; readonly shown: number; readonly label: string };
  /** A command waiting on the user's approval as the page opens. */
  readonly approval?: { readonly command: string; readonly then: string };
  readonly resting: "idle" | "asleep" | "away";
  /** The assistant's answer to whatever is sent, picked by what is sent. */
  readonly answer: (sent: string) => { readonly text: string; readonly extra?: Extra };
}

const pageOpenedAt = performance.now();

/** Returns the fixed clock's time now: 09:41 when the page opens, moving with real time after. */
export const readClock = (): string =>
  formatClock(SPECIMEN_NOW + (performance.now() - pageOpenedAt));

/** Splits text into the pieces it streams in: a word and the space after it. */
const nextTokenEnd = (text: string, from: number): number => {
  const match = /\S+\s*/y;
  match.lastIndex = from;
  return match.exec(text) === null ? text.length : match.lastIndex;
};

/** Returns how long to wait before the token after `written`: longer after a sentence or a paragraph. */
const pauseAfter = (written: string): number => {
  const base = 22 + Math.random() * 38;
  if (written.endsWith("\n\n")) return base + 260;
  if (/[.!?:]\s*$/.test(written)) return base + 170;
  if (/[,;]\s*$/.test(written)) return base + 60;
  return base;
};

let keyCounter = 0;
const nextKey = (prefix: string): string => `${prefix}-${++keyCounter}`;

export function useConversation(setup: ConversationSetup) {
  const [entries, setEntries] = useState<ReadonlyArray<Entry>>(setup.entries);
  const [open, setOpen] = useState<OpenMessage | null>(() =>
    setup.open === undefined
      ? null
      : {
          key: nextKey("open"),
          text: setup.open.text,
          shown: setup.open.shown,
          label: setup.open.label,
          phase: "writing",
          startedAt: performance.now() - 9000,
        },
  );
  const [approval, setApproval] = useState(setup.approval ?? null);
  const [resting, setResting] = useState(setup.resting);
  const [queued, setQueued] = useState<ReadonlyArray<string>>([]);
  const [reminders, setReminders] =
    useState<ReadonlyArray<Reminder & { readonly fresh?: boolean }>>(ADA_REMINDERS);
  const [beats, setBeats] = useState<ReadonlyArray<Beat>>(ADA_BEATS);

  const startTurn = useCallback(
    (text: string, label: string, extra: Extra | undefined, phase: OpenMessage["phase"]) => {
      setOpen({
        key: nextKey("open"),
        text,
        shown: 0,
        label,
        phase,
        extra,
        startedAt: performance.now(),
      });
    },
    [],
  );

  // Moves the open message on: waking, then thinking, then one token at a time.
  useEffect(() => {
    if (open === null || approval !== null) return;
    if (open.phase !== "writing") {
      const timer = setTimeout(
        () => setOpen({ ...open, phase: open.phase === "waking" ? "thinking" : "writing" }),
        open.phase === "waking" ? 1300 : 1100,
      );
      return () => clearTimeout(timer);
    }
    if (open.shown >= open.text.length) {
      const timer = setTimeout(() => {
        setEntries((before) => [
          ...before,
          { kind: "agent", key: open.key, text: open.text, label: open.label, extra: open.extra },
        ]);
        setOpen(null);
        const extra = open.extra;
        if (extra?.kind !== "reminder") return;
        // "Wed 30 Sep · 09:00 · to Web chat" shows in the rail as "Wed 09:00", first
        // because every reminder Ada sets here is for tomorrow.
        const [day, time] = extra.when.split(" · ");
        setReminders((before) => [
          {
            key: nextKey("r"),
            when: `${day!.split(" ")[0]} ${time}`,
            title: extra.title,
            fresh: true,
          },
          ...before.map((each) => ({ ...each, fresh: false })),
        ]);
      }, 0);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(
      () => setOpen({ ...open, shown: nextTokenEnd(open.text, open.shown) }),
      pauseAfter(open.text.slice(0, open.shown)),
    );
    return () => clearTimeout(timer);
  }, [open, approval]);

  const { answer } = setup;
  const deliver = useCallback(
    (text: string): void => {
      const time = readClock();
      setEntries((before) => [...before, { kind: "me", key: nextKey("me"), text, time }]);
      const wasAsleep = resting === "asleep";
      if (resting !== "away") setResting("idle");
      const reply = answer(text);
      startTurn(reply.text, time, reply.extra, wasAsleep ? "waking" : "thinking");
    },
    [answer, resting, startTurn],
  );

  // A reminder just set keeps its tint for a moment, then fades to the rail's ground.
  const hasFresh = reminders.some((each) => each.fresh === true);
  useEffect(() => {
    if (!hasFresh) return;
    const timer = setTimeout(
      () => setReminders((before) => before.map((each) => ({ ...each, fresh: false }))),
      2400,
    );
    return () => clearTimeout(timer);
  }, [hasFresh]);

  // A message sent while the assistant was busy is sent shortly after its turn ends.
  useEffect(() => {
    if (open !== null || approval !== null || queued.length === 0) return;
    const timer = setTimeout(() => {
      const [first, ...rest] = queued;
      setQueued(rest);
      deliver(first!);
    }, 500);
    return () => clearTimeout(timer);
  }, [open, approval, queued, deliver]);

  const send = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    if (open !== null || approval !== null) {
      setQueued((before) => [...before, trimmed]);
      return;
    }
    deliver(trimmed);
  };

  const stop = (): void => {
    if (open === null) return;
    const seconds = Math.max(1, Math.round((performance.now() - open.startedAt) / 1000));
    const written = open.text.slice(0, open.shown).trim();
    setEntries((before) => [
      ...before,
      ...(written === ""
        ? []
        : [{ kind: "agent" as const, key: open.key, text: written, label: open.label }]),
      {
        kind: "quiet" as const,
        key: nextKey("stopped"),
        text: `You stopped Ada after ${seconds}s`,
      },
    ]);
    setOpen(null);
    setApproval(null);
  };

  const decide = (allowed: boolean): void => {
    if (approval === null) return;
    const command = approval.command;
    setApproval(null);
    setEntries((before) => [
      ...before,
      {
        kind: "quiet",
        key: nextKey("decided"),
        text: allowed
          ? `You allowed ${command.split(" ")[0]}`
          : `You denied ${command.split(" ")[0]}`,
      },
    ]);
    startTurn(
      allowed
        ? approval.then
        : "Fine - I'll leave the log alone. From what Milo found so far, the dump of the table " +
            "`events` is what runs long. I'll ask Milo for the timing instead.",
      readClock(),
      undefined,
      "thinking",
    );
  };

  /** Plays the next hour's heartbeat: the beat lights up and the assistant speaks first. */
  const beat = (): void => {
    const next = beats.indexOf("future");
    if (next === -1 || open !== null) return;
    const hour = `${String(7 + next).padStart(2, "0")}:00`;
    setBeats((before) => before.map((each, index) => (index === next ? "spoke" : each)));
    startTurn(
      "Quick one: Milo's number is in. Dumping `events` on its own with `--jobs 4` took **38 " +
        "minutes** on last night's copy, against 71 for the whole dump. Want me to have Milo " +
        "switch tonight's backup to it?",
      `heartbeat · ${hour}`,
      {
        kind: "action",
        label: "Yes, switch tonight's backup",
        sends: "Yes, switch tonight's backup.",
      },
      "thinking",
    );
  };

  const pose: Pose =
    approval !== null
      ? "waiting"
      : open !== null
        ? "working"
        : resting === "asleep"
          ? "asleep"
          : resting === "away"
            ? "away"
            : "idle";

  return { entries, open, approval, pose, queued, reminders, beats, send, stop, decide, beat };
}

export type Conversation = ReturnType<typeof useConversation>;
