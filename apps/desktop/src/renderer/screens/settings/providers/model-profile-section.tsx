import {
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type HTMLAttributes,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  formatProfileEntryKey,
  type ModelProfileHarnessChoice,
  type ModelSection,
  type ModelSectionRow,
  type NewModelRow,
} from "@hercule/client-core";
import type { ResolvedModelProfileEntry } from "@hercule/contract";
import { GripIcon } from "../../../icons/grip";
import { HarnessPill } from "./harness-pill";
import { joinClassNames } from "./join-class-names";
import { ModelRow } from "./model-row";
import { SectionNewModel } from "./section-new-model";
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

/**
 * Renders one account's section of a Model Profile: its head, with the
 * provider's `mark`, the account's name and the harness pill, then a "New"
 * row for each model in `section.newModels`, then its entries in order, then
 * `addModel` (the "Add a model" button and its picker) at the foot.
 *
 * - The head drags the section, and Alt+Up and Alt+Down move it, through
 *   `drag`.
 * - A row drags within the section, and Alt+Up and Alt+Down move the
 *   focused row. The new order shows at once; `onMoveEntry` saves it, once
 *   when a drag drops and once for each key press, and the order the
 *   controller sends back replaces the one shown. After a key press the
 *   focus stays on the moved row, though the browser drops the focus of an
 *   element that its list moves. So it does after "Runs in" moves a row to
 *   another harness, which replaces the row: its key holds its harness.
 * - A "New" row is not an entry: it is not dragged or moved, and the order
 *   above does not hold it. Its "Add" and "Not now" are saved by
 *   `onAddNewModel` and `onDismissNewModel`. When the row goes, the focus
 *   moves on if it was on the row's button: after "Add", to the new entry's
 *   row; after "Not now", to the next "New" row's "Add", else to the section's
 *   first entry, else to the head.
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
  onAddNewModel,
  onDismissNewModel,
}: {
  readonly section: ModelSection;
  readonly mark: ReactNode;
  readonly profileName: string;
  readonly isNew: boolean;
  readonly drag: SectionDrag;
  readonly addModel: ReactNode;
  readonly onMoveEntry: (entry: ResolvedModelProfileEntry, toIndex: number) => Promise<boolean>;
  /** Sets the harness the account's models run in; `null` follows the account's default. */
  readonly onSetHarness: (harnessId: string | null) => void;
  /** Opens the account's sheet, where its default harness is set, with the account's id and name. */
  readonly onOpenAccount: (providerAccountId: string, name: string) => void;
  readonly onMakeDefault: (entry: ResolvedModelProfileEntry) => void;
  /** Saves the move of the model's entry to the harness `harnessId`. */
  readonly onMoveToHarness: (entry: ResolvedModelProfileEntry, harnessId: string | null) => void;
  /** Saves the second entry of the model, which runs in `harnessId`. */
  readonly onAlsoOfferIn: (entry: ResolvedModelProfileEntry, harnessId: string | null) => void;
  readonly onTakeOut: (entry: ResolvedModelProfileEntry) => void;
  /** Saves the model's entry at the end of the section. Resolves, never rejects, with whether it was saved. */
  readonly onAddNewModel: (row: NewModelRow) => Promise<boolean>;
  /** Saves that the profile does not want the model announced. Resolves, never rejects, with whether it was saved. */
  readonly onDismissNewModel: (row: NewModelRow) => Promise<boolean>;
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
  // The rows' elements by the row's key, with the model each draws.
  const rowElements = useRef(
    new Map<string, { readonly model: string; readonly element: HTMLLIElement }>(),
  );
  const headElement = useRef<HTMLDivElement>(null);
  // The "Add" buttons of the "New" rows, by the model's slug.
  const addButtons = useRef(new Map<string, HTMLButtonElement>());
  // Where to put the focus once the controller's answer changes the section's
  // rows (a row moves or is replaced, or a "New" row goes). `seen` is
  // `layoutText` as it was when the user acted, to tell the answer from a draw
  // that changed nothing. `newModel` is set when the request comes from a "New"
  // row: it waits until that model's row is gone, because the answer to an
  // earlier save can change the layout while that row is still there.
  const refocus = useRef<{
    readonly find: () => HTMLElement | null | undefined;
    readonly seen: string;
    readonly newModel?: string;
  } | null>(null);
  const orderText = order.keys.join("\n");
  const layoutText = [orderText, ...section.newModels.map(({ model }) => model)].join("\n");
  const focusAfterChange = (find: () => HTMLElement | null | undefined): void => {
    refocus.current = { find, seen: layoutText };
  };
  /** Returns the element of the first row that draws `model`, in whatever harness it runs. */
  const findRowOfModel = (model: string): HTMLLIElement | undefined =>
    [...rowElements.current.values()].find((row) => row.model === model)?.element;
  /**
   * Like `focusAfterChange` for the "New" row of `newModel`, whose change
   * `save` makes. When the save fails, the request is dropped, so a later
   * change cannot take the focus.
   */
  const focusAfterNewModelSave = async (
    newModel: string,
    find: () => HTMLElement | null | undefined,
    save: () => Promise<boolean>,
  ): Promise<void> => {
    const request = { find, seen: layoutText, newModel };
    refocus.current = request;
    if (!(await save()) && refocus.current === request) refocus.current = null;
  };

  useLayoutEffect(() => {
    const pending = refocus.current;
    if (pending === null || pending.seen === layoutText) return;
    if (section.newModels.some(({ model }) => model === pending.newModel)) return;
    const element = pending.find();
    if (element === undefined || element === null) return;
    refocus.current = null;
    // The user may have moved on while the save ran: take the focus back only
    // when the move dropped it, or left it in one of the section's rows.
    const { activeElement } = document;
    const dropped =
      activeElement === null ||
      activeElement === document.body ||
      [...rowElements.current.values()].some(({ element: row }) => row.contains(activeElement));
    if (dropped) element.focus({ preventScroll: true });
  }, [layoutText, section.newModels]);

  const moveBy = (key: string, offset: -1 | 1): void => {
    const to = order.keys.indexOf(key) + offset;
    if (to < 0 || to >= order.keys.length) return;
    focusAfterChange(() => rowElements.current.get(key)?.element);
    void saveMove(key, to);
  };

  /**
   * Moves the row to the harness of `choice` and focuses it once it comes
   * back under its new key. The key exists only if the move was saved, so a
   * failed save leaves nothing to focus. A later move replaces the pending
   * key, and the effect leaves the focus alone when the user has moved on.
   */
  const moveToHarness = (row: ModelSectionRow, choice: ModelProfileHarnessChoice): void => {
    const key = formatProfileEntryKey({
      providerAccountId: row.entry.providerAccountId,
      harnessId: choice.resolvedHarnessId,
      model: row.entry.model,
    });
    focusAfterChange(() => rowElements.current.get(key)?.element);
    onMoveToHarness(row.entry, choice.harnessId);
  };

  /**
   * Saves the model's entry and focuses its row once the "New" row is gone.
   * The row is found by its model, not by a key made before the save: a retry
   * after a conflict, or another writer, can have put the entry in another
   * harness than the section's.
   */
  const saveNewModelAddition = (row: NewModelRow): Promise<void> =>
    focusAfterNewModelSave(
      row.model,
      () => findRowOfModel(row.model),
      () => onAddNewModel(row),
    );

  /** Saves the dismissal and focuses what takes the row's place, as the component's docstring says. */
  const saveNewModelDismissal = (row: NewModelRow): Promise<void> => {
    const nextModel = section.newModels[section.newModels.indexOf(row) + 1]?.model;
    const firstRowKey = order.keys[0];
    return focusAfterNewModelSave(
      row.model,
      () =>
        (nextModel === undefined ? undefined : addButtons.current.get(nextModel)) ??
        (firstRowKey === undefined ? undefined : rowElements.current.get(firstRowKey)?.element) ??
        headElement.current,
      () => onDismissNewModel(row),
    );
  };

  const rows = order.keys.flatMap((key) => rowsByKey.get(key) ?? []);
  const buildRowProps = ({ key, entry }: ModelSectionRow): ComponentProps<"li"> => {
    const dropSide = rowDrag.dropMark?.key === key ? rowDrag.dropMark.side : null;
    return {
      ...rowDrag.getSourceProps(key),
      ...rowDrag.getTargetProps(key),
      ref: (element) => {
        if (element === null) rowElements.current.delete(key);
        else rowElements.current.set(key, { model: entry.model, element });
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
        ref={headElement}
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
      {section.newModels.map((row) => (
        <SectionNewModel
          key={row.model}
          row={row}
          addButtonRef={(element) => {
            if (element === null) addButtons.current.delete(row.model);
            else addButtons.current.set(row.model, element);
          }}
          onAdd={() => saveNewModelAddition(row)}
          onDismiss={() => saveNewModelDismissal(row)}
        />
      ))}
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
              onMoveToHarness={(choice) => {
                moveToHarness(row, choice);
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
