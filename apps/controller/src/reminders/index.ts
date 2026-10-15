/**
 * Reminders: one-shot Scheduled Wakes, each owned by a conversation. The
 * assistant sets one on itself, or the user sets one for it, and at its time
 * the Scheduler delivers its text into the conversation.
 *
 * This domain stores reminders and runs the three operations. The Scheduler
 * calls `reminderRepository` for what it fires: `listDue(now)` returns the
 * pending reminders that are due, oldest first, and `markFired(id, at)` moves
 * one to fired and returns whether it did.
 */
export { reminderRepository, type NewReminder } from "./repository";
export { Reminders, RemindersLayer } from "./service";
