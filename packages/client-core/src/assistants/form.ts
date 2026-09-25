/**
 * The assistant form in Settings > Assistants: the fields it edits, how an
 * edit is recorded, the update it sends when the user saves, and the edits
 * that are left once a save lands.
 */
import type { Assistant, AssistantUpdateInput } from "@hercule/contract";

/** The assistant fields the settings form edits. */
export type AssistantDraft = Pick<
  Assistant,
  "name" | "systemPrompt" | "instanceId" | "permissionProfileId" | "accessMode" | "reply"
>;

/** Returns the form's starting values: the assistant's stored fields. */
export const buildAssistantDraft = (assistant: Assistant): AssistantDraft => ({
  name: assistant.name,
  systemPrompt: assistant.systemPrompt,
  instanceId: assistant.instanceId,
  permissionProfileId: assistant.permissionProfileId,
  accessMode: assistant.accessMode,
  reply: assistant.reply,
});

/**
 * Returns the unsaved edits with `fields` recorded on top of `edits`. A field
 * whose new value equals the assistant's stored value is removed from the
 * edits instead.
 *
 * A field typed and then typed back is therefore no longer an edit. If it
 * stayed one, a change another writer later makes to that field would be
 * hidden behind it, and the next save would write the old value back.
 */
export const mergeAssistantEdits = (
  assistant: Assistant,
  edits: Partial<AssistantDraft>,
  fields: Partial<AssistantDraft>,
): Partial<AssistantDraft> => {
  const stored = buildAssistantDraft(assistant);
  return Object.fromEntries(
    Object.entries({ ...edits, ...fields }).filter(
      ([field, value]) => stored[field as keyof AssistantDraft] !== value,
    ),
  );
};

/**
 * Returns the `assistant.update` payload that holds only the fields the draft
 * changed. The payload is empty when nothing changed.
 *
 * An unchanged field is left out rather than sent again, so a save never
 * overwrites a field that another writer (an agent, a second browser) changed
 * since the form opened. Values are compared exactly: a name with a trailing
 * space is a changed name.
 */
export const buildAssistantUpdate = (
  assistant: Assistant,
  draft: AssistantDraft,
): AssistantUpdateInput => ({
  ...(draft.name !== assistant.name && { name: draft.name }),
  ...(draft.systemPrompt !== assistant.systemPrompt && { systemPrompt: draft.systemPrompt }),
  ...(draft.instanceId !== assistant.instanceId && { instanceId: draft.instanceId }),
  ...(draft.permissionProfileId !== assistant.permissionProfileId && {
    permissionProfileId: draft.permissionProfileId,
  }),
  ...(draft.accessMode !== assistant.accessMode && { accessMode: draft.accessMode }),
  ...(draft.reply !== assistant.reply && { reply: draft.reply }),
});

/**
 * Returns the edits that are still unsaved once a save that sent `sent` has
 * landed: every edit except those whose value is the one the save sent.
 *
 * The user can keep typing while a save runs. A field typed into during the
 * save no longer holds the sent value, so its edit stays and the new text is
 * not lost.
 */
export const dropSavedEdits = (
  edits: Partial<AssistantDraft>,
  sent: AssistantUpdateInput,
): Partial<AssistantDraft> =>
  Object.fromEntries(
    Object.entries(edits).filter(
      ([field, value]) => sent[field as keyof AssistantUpdateInput] !== value,
    ),
  );
