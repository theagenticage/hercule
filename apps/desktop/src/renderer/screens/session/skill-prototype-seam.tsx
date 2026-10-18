/**
 * PROTOTYPE (#766): the one place the composer skills prototype reaches
 * into the real screens. It lives here, outside `specimens/`, because
 * eslint refuses imports of `specimens/` from the rest of the renderer.
 *
 * The prototype's page provides a value; the real app never does, so the
 * context stays `null` there and each screen draws as it always does. Three
 * places read it:
 *
 * - `ComposerCard` draws `field` in place of its `<textarea>`;
 * - `UserMessage` draws `renderMessageText(text)` in its bubble in place of
 *   the markdown;
 * - the queued input's row draws `renderMessageText(text)` in its one line
 *   of text.
 *
 * Delete this file with the prototype.
 */
import { createContext, type ReactNode } from "react";

/** What the prototype draws in place of the real parts. Each part is optional. */
export interface SkillPrototypeSeamValue {
  /** The message field of the composer card. */
  readonly field?: ReactNode;
  /** The text of a sent or queued user message. */
  readonly renderMessageText?: (text: string) => ReactNode;
}

export const SkillPrototypeSeam = createContext<SkillPrototypeSeamValue | null>(null);
