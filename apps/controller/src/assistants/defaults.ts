/**
 * The values an assistant gets for every field its create leaves out.
 *
 * Setup, the web app's onboarding and the CLI all create an assistant from a
 * name alone, so the defaults live in this one place and cannot drift apart.
 * Two defaults are not constants and are read when an assistant is created:
 * the provider instance (the oldest one whose provider this build carries)
 * and the permission profile (the shipped `assistant` profile).
 */
import type { AccessMode, DisallowedTool } from "@hercule/protocol";
import type { AssistantReply, Heartbeat, Rotation } from "@hercule/contract";

/** The name of the shipped permission profile an assistant's sessions run under. */
export const DEFAULT_PROFILE_NAME = "assistant";

/** The system prompt an assistant starts with. */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a personal assistant running inside the user's own controller. The user talks to you in a chat. Answer briefly and plainly. Prefer delegating work over doing it yourself: use the `hercule` CLI to read and create tasks, start workflows and check on sessions. You cannot edit files.";

/** The text an assistant is given at each heartbeat, unless the user writes another. */
const HEARTBEAT_PROMPT =
  "This is a scheduled heartbeat, not a message from the user. Check what you are waiting on: runs you started, subscriptions you hold, tasks you own, reminders that are due. Do not invent work and do not repeat old tasks from earlier in this conversation. If nothing needs the user's attention, reply exactly `NO_REPLY`. Otherwise write only the message the user should read: what changed, what you propose, plus any small updates worth mentioning alongside it. If a decision is needed, create a notification so it reaches the user wherever they are.";

/** Every hour from 07:00 to 23:00. No timezone is set, so the user's timezone setting applies. */
export const DEFAULT_HEARTBEAT: Heartbeat = {
  enabled: true,
  schedule: "0 7-23 * * *",
  prompt: HEARTBEAT_PROMPT,
  target: "web",
};

/** A fresh session at 70% of the context window, at 200,000 tokens, or at 04:00. */
export const DEFAULT_ROTATION: Rotation = {
  contextFraction: 0.7,
  maxContextTokens: 200000,
  dailyAt: "04:00",
};

export const DEFAULT_REPLY: AssistantReply = "turn-end";

/**
 * An assistant is chatted with, so nobody is there to approve each tool call
 * when it works on its own at a heartbeat.
 */
export const DEFAULT_ACCESS_MODE: AccessMode = "full-access";

/** An assistant delegates work rather than doing it, so it edits no files. */
export const DEFAULT_DISALLOWED_TOOLS: ReadonlyArray<DisallowedTool> = ["edit"];
