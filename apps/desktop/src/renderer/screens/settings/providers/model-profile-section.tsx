import {
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type HTMLAttributes,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ModelSection, ModelSectionRow } from "@hercule/client-core";
import type { ResolvedModelProfileEntry } from "@hercule/contract";
import { GripIcon } from "../../../icons/grip";
import { HarnessPill } from "./harness-pill";
import { ModelRow } from "./model-row";
import { useDragReorder } from "./use-drag-reorder";
import { useOptimisticOrder } from "./use-optimistic-order";
import "./models.css";

/** The props the Models section gives an account's head and section, so the accounts can be dragged into another order. */
export interface SectionDrag {
  /** Spread on the head the user grabs. */
  readonly headProps: HTMLAttributes<HTMLElement> & { readonly draggable: true };
  /** Spread on the section a dragged account is dropped on. */
  readonly sectionProps: HTMLAttributes<HTMLElement>;
  readonly dropSide: "before" | "after" | null;
  /** Moves the account up (-1) or down (+1) one place; the head's Alt+Up and Alt+Down call it. */
  readonly onMoveBy: (offset: -1 | 1) => void;
}

/** Returns -1 for Alt+Up and +1 for Alt+Down, or `null` for any other key press. */
const readAltArrowOffset = (event: KeyboardEvent): -1 | 1 | null => {
  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return null;
  return event.key === "ArrowUp" ? -1 : 1;
};

/** Joins the class names that are not empty. */
const joinClassNames = (...names: readonly string[]): string =>
  names.filter((name) => name !== "").join(" ");

/**
 * Renders one account's section of a Model Profile: its head, with the
 * provider's `mark`, the account's name and the harness pill, then its entries in order, then
 * `addModel` (the "Add a model" button and its picker) at the foot.
 *
 * - The head drags the section, and Alt+Up and Alt+Down move it, through
 *   `drag`.
 * - A row drags within the section, and Alt+Up and Alt+Down move the
 *   focused row. The new order shows at once; `onMoveEntry` saves it, once
 *   when a drag drops and once for each key press, and the order the
 *   controller sends back replaces the one shown. After a key press the
 *   focus stays on the moved row, though the browser drops the focus of an
 *   element that its list moves.
 * - A section that waits for its account's first Model Catalog read says so
 *   and offers no "Add a model", because the read will fill the section.
 * - A section with no entry says so.
 * - `isNew` flashes the section once, as it appears when its account was just
 *   added to the profile.
 */
export function ModelProfileSection({
  section,
  mark,
  profileName,
  isNew,
  drag,
  addModel,
  onMoveEntry,
  onSetHarness,
  onOpenAccount,
  onMakeDefault,
  onMoveToHarness,
  onAlsoOfferIn,
  onTakeOut,
}: {
  readonly section: ModelSection;
  readonly mark: ReactNode;
  readonly profileName: string;
  readonly isNew: boolean;
  readonly drag: SectionDrag;
  readonly addModel: ReactNode;
  readonly onMoveEntry: (entry: ResolvedModelProfileEntry, toIndex: number) => Promise<void>;
  /** Sets the harness the account's models run in; `null` follows the account's default. */
  readonly onSetHarness: (harnessId: string | null) => void;
  /** Opens the account's sheet, where its default harness is set. */
  readonly onOpenAccount: () => void;
  readonly onMakeDefault: (entry: ResolvedModelProfileEntry) => void;
  readonly onMoveToHarness: (entry: ResolvedModelProfileEntry, harnessId: string | null) => void;
  readonly onAlsoOfferIn: (entry: ResolvedModelProfileEntry, harnessId: string | null) => void;
  readonly onTakeOut: (entry: ResolvedModelProfileEntry) => void;
}): JSX.Element {
  const rowsByKey = new Map<string, ModelSectionRow>(section.rows.map((row) => [row.key, row]));
  const order = useOptimisticOrder(section.rows.map(({ key }) => key));
  const saveMove = (key: string, toIndex: number): Promise<void> => {
    const row = rowsByKey.get(key);
    if (row === undefined) return Promise.resolve();
    return order.move(key, toIndex, () => onMoveEntry(row.entry, toIndex));
  };
  const rowDrag = useDragReorder(order.keys, (key, toIndex) => {
    // `onMoveEntry` never rejects: a failed save shows above the sections.
    void saveMove(key, toIndex);
  });
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  // The row to focus once the controller's order arrives and the list moves it.
  const refocus = useRef<{ readonly key: string; readonly order: string } | null>(null);
  const orderText = order.keys.join("\n");

  useLayoutEffect(() => {
    const pending = refocus.current;
    if (pending === null || pending.order === orderText) return;
    refocus.current = null;
    rowElements.current.get(pending.key)?.focus({ preventScroll: true });
  }, [orderText]);

  const moveBy = (key: string, offset: -1 | 1): void => {
    const to = order.keys.indexOf(key) + offset;
    if (to < 0 || to >= order.keys.length) return;
    refocus.current = { key, order: orderText };
    void saveMove(key, to);
  };

  const rows = order.keys.flatMap((key) => rowsByKey.get(key) ?? []);
  const buildRowProps = (key: string): ComponentProps<"li"> => {
    const dropSide = rowDrag.dropMark?.key === key ? rowDrag.dropMark.side : null;
    return {
      ...rowDrag.getSourceProps(key),
      ...rowDrag.getTargetProps(key),
      ref: (element) => {
        if (element === null) rowElements.current.delete(key);
        else rowElements.current.set(key, element);
      },
      tabIndex: 0,
      "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
      className: joinClassNames(
        "pm-row",
        rowDrag.draggingKey === key ? "is-dragging" : "",
        dropSide === null ? "" : `drop-${dropSide}`,
      ),
      onKeyDown: (event) => {
        // The menu inside the row takes its own arrow keys.
        if (event.target !== event.currentTarget) return;
        const offset = readAltArrowOffset(event);
        if (offset === null) return;
        event.preventDefault();
        moveBy(key, offset);
      },
    };
  };
  return (
    <section
      {...drag.sectionProps}
      aria-label={section.name}
      className={joinClassNames(
        "pm-sec",
        isNew ? "is-fresh" : "",
        drag.dropSide === null ? "" : `drop-${drag.dropSide}`,
      )}
    >
      <div
        {...drag.headProps}
        className="pm-head"
        tabIndex={0}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        title={`Drag to move ${section.name}'s models up or down the menu`}
        onKeyDown={(event) => {
          // The pill and its popover inside the head take their own keys.
          if (event.target !== event.currentTarget) return;
          const offset = readAltArrowOffset(event);
          if (offset === null) return;
          event.preventDefault();
          drag.onMoveBy(offset);
        }}
      >
        <span className="pm-grip" aria-hidden="true">
          <GripIcon size={12} />
        </span>
        {mark}
        <b>{section.name}</b>
        <HarnessPill
          harness={section.harness}
          accountName={section.name}
          profileName={profileName}
          onPick={onSetHarness}
          onChangeAccountHarness={onOpenAccount}
        />
      </div>
      {rows.length === 0 ? null : (
        <ul className="pm-rows">
          {rows.map((row) => (
            <ModelRow
              key={row.key}
              row={row}
              profileName={profileName}
              rowProps={buildRowProps(row.key)}
              onMakeDefault={() => {
                onMakeDefault(row.entry);
              }}
              onMoveToHarness={(harnessId) => {
                onMoveToHarness(row.entry, harnessId);
              }}
              onAlsoOfferIn={(harnessId) => {
                onAlsoOfferIn(row.entry, harnessId);
              }}
              onTakeOut={() => {
                onTakeOut(row.entry);
              }}
            />
          ))}
        </ul>
      )}
      {section.selectionPending ? (
        <p className="pm-note">Reading models…</p>
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="pm-note">{`No model from ${section.name} in the menu yet.`}</p>
          ) : null}
          {addModel}
        </>
      )}
    </section>
  );
}
