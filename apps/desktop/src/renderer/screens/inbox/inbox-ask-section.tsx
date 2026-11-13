/**
 * One open signal of a thing as a section of the Inbox's pane (spec 17 §The
 * pane): a head that folds it, and under the head its blocks, its answers and
 * the describe line. A section is unfolded or folded to its head; its body
 * grows and shrinks on the hand spring.
 */
import { useId, useImperativeHandle, useLayoutEffect, useRef, type JSX, type Ref } from "react";
import { describeHiddenAsks } from "@hercule/client-core/inbox";
import type { Block } from "@hercule/contract";
import { animateValue, type MotionValue } from "../../app/motion";
import { ChevronDownIcon } from "../../icons/chevron-down";
import { InboxAnswers, type InboxAnswersProps } from "./inbox-answers";
import { InboxBlocks } from "./inbox-blocks";
import "./inbox-ask-section.css";

/** What the body of a section holds, or why it holds nothing yet. */
export type AskSectionBody =
  | { readonly state: "reading" }
  | { readonly state: "failed"; readonly message: string }
  | {
      readonly state: "ready";
      readonly blocks: ReadonlyArray<Block>;
      readonly timezone: string;
      readonly now: Date;
      readonly answers: Omit<InboxAnswersProps, "isCurrent">;
    };

/**
 * Renders the say line of an ask with the asker's name in ink and the rest
 * muted: "Mei asked for your review". `asker` is `undefined` when the ask has
 * no person, and the whole line is muted then.
 */
function SayLine({
  say,
  asker,
}: {
  readonly say: string;
  readonly asker: string | undefined;
}): JSX.Element {
  if (asker === undefined || !say.startsWith(asker)) return <>{say}</>;
  return (
    <>
      <b>{asker}</b>
      {say.slice(asker.length)}
    </>
  );
}

/** What the pane asks of a section. */
export interface InboxAskSectionHandle {
  /** Moves the focus to the first answer in the section's body, if it has any. */
  readonly focusFirstAnswer: () => void;
}

/**
 * Renders the section of one open signal.
 *
 * - The head is a button that calls `onToggle`; it carries `aria-expanded`.
 * - `isCurrent` marks the ask that Return answers (`aria-current`) and draws its ink edge.
 * - A folded body is inert, so its buttons take no focus and no click.
 * - `body` is how far the signal's full read is: while it is on its way the
 *   body draws quiet shapes, and a read that failed says why in one line.
 * - `ref` receives the handle that focuses the section's first answer.
 */
export function InboxAskSection({
  say,
  asker,
  time,
  isOpen,
  isCurrent,
  body,
  ref,
  onToggle,
}: {
  readonly say: string;
  readonly asker: string | undefined;
  /** The time the ask was raised, in words such as "2h". */
  readonly time: string;
  readonly isOpen: boolean;
  readonly isCurrent: boolean;
  readonly body: AskSectionBody;
  readonly ref?: Ref<InboxAskSectionHandle> | undefined;
  readonly onToggle: () => void;
}): JSX.Element {
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    focusFirstAnswer: () => {
      bodyRef.current?.querySelector<HTMLElement>("[data-answer]")?.focus();
    },
  }));
  const height = useRef<MotionValue | null>(null);
  const isFirstDraw = useRef(true);

  // Folds or unfolds the body: its height goes from what is on screen (or from where a fold that is
  // still moving has got to) to its content's height, or to nothing. The CSS holds the resting height,
  // so the inline height only lives while the spring runs. Under Reduce motion the value jumps.
  useLayoutEffect(() => {
    if (isFirstDraw.current) {
      isFirstDraw.current = false;
      return;
    }
    const element = bodyRef.current;
    if (element === null) return;
    const moving = element.style.height;
    const from = moving !== "" ? Number.parseFloat(moving) : isOpen ? 0 : element.scrollHeight;
    const to = isOpen ? element.scrollHeight : 0;
    const spring =
      height.current ??
      animateValue(from, (value) => {
        element.style.height = `${String(Math.max(0, value))}px`;
      });
    height.current = spring;
    spring.set(from);
    spring.to(to, "hand", () => {
      element.style.height = "";
    });
  }, [isOpen]);
  // A section that leaves mid-fold stops its spring.
  useLayoutEffect(
    () => () => {
      height.current?.set(height.current.current);
    },
    [],
  );

  const classes = ["sig", isOpen && "is-open", isCurrent && "is-current-ask"];
  return (
    <section
      className={classes.filter(Boolean).join(" ")}
      aria-current={isCurrent ? "true" : undefined}
    >
      <button
        type="button"
        className="sig-head"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="sig-dot" aria-hidden="true" />
        <span className="sig-say">
          <SayLine say={say} asker={asker} />
        </span>
        <time>{time}</time>
        <span className="sig-chev">
          <ChevronDownIcon size={12} />
        </span>
      </button>
      <div ref={bodyRef} id={bodyId} className="sig-body" inert={!isOpen}>
        <div className="sig-in">
          <AskSectionContent body={body} isCurrent={isCurrent} />
        </div>
      </div>
    </section>
  );
}

/** Renders what is in the body: quiet shapes, the reason the read failed, or the blocks and the answers. */
function AskSectionContent({
  body,
  isCurrent,
}: {
  readonly body: AskSectionBody;
  readonly isCurrent: boolean;
}): JSX.Element {
  if (body.state === "reading")
    return (
      <div className="sig-skel" aria-hidden="true">
        <i style={{ width: "86%" }} />
        <i style={{ width: "62%" }} />
        <i className="sig-skel-answer" />
      </div>
    );
  if (body.state === "failed") return <p className="bk-fine">{body.message}</p>;
  return (
    <>
      <InboxBlocks blocks={body.blocks} timezone={body.timezone} now={body.now} />
      <InboxAnswers {...body.answers} isCurrent={isCurrent} />
    </>
  );
}

/**
 * Renders the quiet line that says how many open asks the pane does not show a
 * section for, such as "3 more". Draws nothing for none.
 */
export function InboxMoreAsks({ count }: { readonly count: number }): JSX.Element | null {
  if (count <= 0) return null;
  return <p className="bk-fine sig-more">{describeHiddenAsks(count)}</p>;
}
