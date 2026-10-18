/**
 * PROTOTYPE (#766): the one place the composer skills prototype reaches
 * into the real screens. It lives here, outside `specimens/`, because
 * eslint refuses imports of `specimens/` from the rest of the renderer.
 *
 * The prototype's page provides a value; the real app never does, so the
 * context stays `null` there and nothing changes: each screen draws as it
 * always does. Three places read it:
 *
 * - `ComposerCard` draws `composerField` in place of its `<textarea>`;
 * - `UserMessage` draws `renderMessageText(text)` in its bubble in place of
 *   the markdown;
 * - the queued input's row draws `renderMessageText(text)` in its one line
 *   of text.
 *
 * The prototype's `composerField` replaces the `<textarea>` and with it
 * everything the card wires to it: `fieldRef`, `fieldId`, `readOnly`,
 * `autoFocus`, `onSend` and paste handling. So the prototype's focus,
 * typing and sending are drawn only, and none of it shows how the real
 * composer behaves.
 *
 * Delete this file with the prototype.
 */
import { createContext, type ReactNode } from "react";

/** What the prototype draws in place of the real parts. Each part is optional. */
export interface SkillPrototypeSeamValue {
  /** The message field of the composer card, in place of its `<textarea>`. */
  readonly composerField?: ReactNode;
  /** The text of a sent or queued user message. */
  readonly renderMessageText?: (text: string) => ReactNode;
}

export const SkillPrototypeSeam = createContext<SkillPrototypeSeamValue | null>(null);
