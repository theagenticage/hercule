import type { JSX } from "react";
import { IconFrame } from "../icons/icon-frame";
import type { MarkState } from "./mark-state";
import "./mark.css";

/**
 * The glyph each state's mark draws, on the icons' 16-unit grid. Every
 * coordinate is copied from the Bureau book's crew.js as the same string. The
 * colour is never in the glyph: it comes from the mark's `mark--<state>` class.
 */
const MARK_GLYPHS: { readonly [State in MarkState]: JSX.Element } = {
  working: (
    <>
      <circle cx="3.8" cy="8" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12.2" cy="8" r="1.35" fill="currentColor" stroke="none" />
    </>
  ),
  waiting: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
    </>
  ),
  done: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M5.5 8.2l1.7 1.7 3.3-3.5" />
    </>
  ),
  failed: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M6.1 6.1l3.8 3.8M9.9 6.1l-3.8 3.8" />
    </>
  ),
  paused: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M6.7 6v4M9.3 6v4" />
    </>
  ),
  idle: <path d="M12.4 9.9A5 5 0 0 1 6.1 3.6a5 5 0 1 0 6.3 6.3z" />,
};

/**
 * Renders a state mark: the state's glyph, 14 CSS pixels square, in the
 * state's colour. The mark is hidden from assistive technology, because
 * every place that draws one also names the state in words, such as a thread
 * row's name "Fix checkout, working".
 *
 * Nothing in a mark moves. The book fades the working mark's dots in turn;
 * the app draws them still. The app allows one continuous animation, the face
 * beside the open thread's running turn, so a list full of working rows draws
 * no frames (spec 17 §Performance, rule 2).
 */
export function Mark({ state }: { readonly state: MarkState }): JSX.Element {
  return (
    <span className={`mark mark--${state}`} aria-hidden="true">
      <IconFrame size={14}>{MARK_GLYPHS[state]}</IconFrame>
    </span>
  );
}
