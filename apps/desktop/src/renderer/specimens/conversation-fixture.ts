/**
 * The records the Conversation specimen (conversation.tsx) seeds its query
 * cache with, as the controller would return them: Ada's Conversation as the
 * Bureau book's desktop/assistant.html draws it, at the book's times.
 *
 * Yesterday at 22:14 a turn of Ada's failed, and the controller stored a
 * notice. This morning Ada wrote at 09:00, the user asked for a reminder at
 * 09:20 and Ada answered, and at 09:38 the user asked about the backup job.
 * Ada's current session is still writing that answer, so the Conversation
 * ends in the open reply. Every time is in UTC, which the capture sets as
 * the system time zone, and the fixed clock reads 09:41.
 *
 * The sidebar is the sidebar specimen's (sidebar-fixture.ts), with Ada in its
 * Assistants section.
 *
 * The reference sheet reads this module too (conversation-reference.ts), to
 * edit the book's page where the app draws the fixture's words instead of
 * the book's.
 */
import type { ConversationMessage } from "@hercule/contract";
import { CLAUDE_SONNET, SPECIMEN_RECORDS } from "./sidebar-fixture";
import type { SidebarRecords } from "./shell-page";
import {
  ADA,
  buildAssistantSession,
  ADA_MORNING_STEPS,
  buildConversationMessages,
  buildRunningTurnRows,
} from "./assistant-states-fixture";

/** The Conversation's messages, oldest first: yesterday's notice, then Ada's morning. */
export const CONVERSATION_MESSAGES: ReadonlyArray<ConversationMessage> = buildConversationMessages(
  ADA,
  [
    {
      senderRole: "notice",
      createdAt: "2026-09-28T22:14:00.000Z",
      text: "Ada was interrupted: her turn failed: provider timeout after 120s. Your last message was kept.",
    },
    ...ADA_MORNING_STEPS,
  ],
);

/**
 * The text Ada is writing, not finished yet. It is plain text, as the app
 * draws the paragraph being written, so the book's `pg_dump` and `events`
 * carry no backticks here.
 */
export const OPEN_REPLY_TEXT =
  "Milo started an investigation at 09:35 on build-box-1. So far: the backup job's pg_dump " +
  "has been slower each night since the table events passed 40 GB";

/** The records the Conversation specimen draws: the sidebar specimen's, and Ada at work. */
export const CONVERSATION_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  assistants: [
    {
      assistant: ADA,
      currentSession: buildAssistantSession(ADA, { status: "busy", minutesAgo: 3 }),
      messages: CONVERSATION_MESSAGES,
      runningTurn: buildRunningTurnRows(ADA, "2026-09-29T09:38:00.000Z", [
        { _tag: "turn.started", turnId: "turn-ada-backup", model: CLAUDE_SONNET.slug },
        {
          _tag: "item.started",
          turnId: "turn-ada-backup",
          itemId: "it-ada-answer",
          kind: "assistant_message",
        },
        {
          _tag: "content.delta",
          turnId: "turn-ada-backup",
          itemId: "it-ada-answer",
          streamKind: "assistant_text",
          delta: OPEN_REPLY_TEXT,
        },
      ]),
    },
  ],
};

/** The address of Ada's page, which the specimen opens. */
export const CONVERSATION_PATH = `/assistants/${ADA.id}`;
