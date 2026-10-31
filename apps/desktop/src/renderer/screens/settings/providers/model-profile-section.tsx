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
 *   controller sends back replaces the one shown. The focus stays on the
 *   moved row after a key press, after "Runs in" moves the row to another
 *   harness, and on the row that "Also offer in" was pressed on, though the
 *   browser drops the focus of an element that its list moves or replaces.
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
  /** Saves the move and resolves to whether it was saved; it never rejects. */
  readonly onMoveEntry: (entry: ResolvedModelProfileEntry, toIndex: number) => Promise<boolean>;
  /** Sets the harness the account's models run in; `null` follows the account's default. */
  readonly onSetHarness: (harnessId: string | null) => void;
  /** Opens the account's sheet, where its default harness is set, with the account's id and name. */
  readonly onOpenAccount: (providerAccountId: string, name: string) => void;
  readonly onMakeDefault: (entry: ResolvedModelProfileEntry) => void;
  /** Saves the move to the harness and resolves to whether it was saved; it never rejects. */
  readonly onMoveToHarness: (
    entry: ResolvedModelProfileEntry,
    harnessId: string | null,
  ) => Promise<boolean>;
  /** Saves the second entry and resolves to whether it was saved; it never rejects. */
  readonly onAlsoOfferIn: (
    entry: ResolvedModelProfileEntry,
    harnessId: string | null,
  ) => Promise<boolean>;
  readonly onTakeOut: (entry: ResolvedModelProfileEntry) => void;
}): JSX.Element {
  const rowsByKey = new Map<string, ModelSectionRow>(section.rows.map((row) => [row.key, row]));
  const order = useOptimisticOrder(section.rows.map(({ key }) => key));
  /** Moves the row at once and saves it; resolves to whether a save was made and worked. */
  const saveMove = async (key: string, toIndex: number): Promise<boolean> => {
    const row = rowsByKey.get(key);
    if (row === undefined) return false;
    let saved = false;
    await order.move(key, toIndex, async () => {
      saved = await onMoveEntry(row.entry, toIndex);
    });
    return saved;
  };
  const rowDrag = useDragReorder(order.keys, (key, toIndex) => {
    // `onMoveEntry` never rejects: a failed save shows above the sections.
    void saveMove(key, toIndex);
  });
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  // The row to focus once the controller's answer arrives and the list moves
  // it or replaces it. A row is named by its model and the harness it runs in,
  // not by its key, because moving a row to another harness changes its key.
  const refocus = useRef<{
    readonly model: string;
    readonly resolvedHarnessId: string;
    readonly order: string;
  } | null>(null);
  const orderText = order.keys.join("\n");

  useLayoutEffect(() => {
    const pending = refocus.current;
    if (pending === null || pending.order === orderText) return;
    const target = section.rows.find(
      ({ entry }) =>
        entry.model === pending.model && entry.resolvedHarnessId === pending.resolvedHarnessId,
    );
    const element = target === undefined ? undefined : rowElements.current.get(target.key);
    if (element === undefined) return;
    refocus.current = null;
    // The user may have moved on while the save ran: take the focus back only
    // when the move dropped it, or left it in one of the section's rows.
    const { activeElement } = document;
    const dropped =
      activeElement === null ||
      activeElement === document.body ||
      [...rowElements.current.values()].some((row) => row.contains(activeElement));
    if (dropped) element.focus({ preventScroll: true });
  }, [orderText, section.rows]);

  /**
   * Focuses the row of `model` in `resolvedHarnessId` once the list changes
   * because of `save`. When `save` resolves to false nothing changes, so the
   * focus is left alone: a later move of the list must not pull it back.
   */
  const refocusAfterSave = (
    model: string,
    resolvedHarnessId: string,
    save: () => Promise<boolean>,
  ): void => {
    const pending = { model, resolvedHarnessId, order: orderText };
    refocus.current = pending;
    void save().then((saved) => {
      if (!saved && refocus.current === pending) refocus.current = null;
    });
  };

  const moveBy = (row: ModelSectionRow, offset: -1 | 1): void => {
    const to = order.keys.indexOf(row.key) + offset;
    if (to < 0 || to >= order.keys.length) return;
    refocusAfterSave(row.entry.model, row.entry.resolvedHarnessId, () => saveMove(row.key, to));
  };

  const rows = order.keys.flatMap((key) => rowsByKey.get(key) ?? []);
  const buildRowProps = (row: ModelSectionRow): ComponentProps<"li"> => {
    const { key } = row;
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
        moveBy(row, offset);
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
          onChangeAccountHarness={() => {
            onOpenAccount(section.providerAccountId, section.name);
          }}
        />
      </div>
      {rows.length === 0 ? null : (
        <ul className="pm-rows">
          {rows.map((row) => (
            <ModelRow
              key={row.key}
              row={row}
              profileName={profileName}
              rowProps={buildRowProps(row)}
              onMakeDefault={() => {
                onMakeDefault(row.entry);
              }}
              onMoveToHarness={(harnessId) => {
                // The row's key holds its harness, so the row comes back as a
                // new element and the focus it had is lost.
                const moved = row.runsIn.find((choice) => choice.harnessId === harnessId);
                refocusAfterSave(
                  row.entry.model,
                  moved?.resolvedHarnessId ?? row.entry.resolvedHarnessId,
                  () => onMoveToHarness(row.entry, harnessId),
                );
              }}
              onAlsoOfferIn={(harnessId) => {
                refocusAfterSave(row.entry.model, row.entry.resolvedHarnessId, () =>
                  onAlsoOfferIn(row.entry, harnessId),
                );
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
