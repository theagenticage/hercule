import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type ReactNode,
} from "react";
import {
  NO_MODEL_MATCHES_TEXT,
  describeContextWindow,
  describeModelPrice,
} from "@hercule/client-core";
import type { ModelCatalogItem } from "@hercule/contract";
import { readLengths, useMeasuredAtTextSize } from "../../../app/text-size";
import { CheckIcon } from "../../../icons/check";
import { PlusIcon } from "../../../icons/plus";
import { useVirtualLines } from "../../use-virtual-lines";
import { joinClassNames } from "./join-class-names";
import "./model-browser.css";

/** The custom property that holds a row's height, which follows the Text size (styles/row-heights.css). */
const ROW_HEIGHT_PROPERTIES = { row: "--model-browser-height-row" } as const;

const readRowHeight = (): number => readLengths(ROW_HEIGHT_PROPERTIES).row;

/** What a row of the list says about its model. */
type ModelRowState = "held" | "picked" | "open";

/** One row of the virtual list: its key is the model's slug. */
interface Row {
  readonly key: string;
  readonly model: ModelCatalogItem;
}

/**
 * Renders one model: its name over its maker and id, its context window and
 * its price per million tokens, and a mark at the end that says whether it is
 * in the profile already (a faint check, and the row cannot be picked),
 * picked (a filled check) or can be picked (a plus). A row is one button. A
 * screen reader hears `aria-pressed` for a model that can be picked or is
 * picked. A held model is not a toggle: it has no `aria-pressed`, it is
 * `aria-disabled`, and its description says "Already in <profile>".
 *
 * While `frozen`, pressing the row does nothing and it looks it. It stays a
 * focusable button, so a focus on it is not lost.
 */
function ModelBrowserRow({
  model,
  state,
  frozen,
  profileName,
  onToggle,
}: {
  readonly model: ModelCatalogItem;
  readonly state: ModelRowState;
  readonly frozen: boolean;
  readonly profileName: string;
  readonly onToggle: (model: ModelCatalogItem) => void;
}): JSX.Element {
  const held = state === "held";
  const heldNoteId = useId();
  return (
    <button
      type="button"
      className={joinClassNames(
        "mb-row",
        state === "picked" && "is-picked",
        held && "is-held",
        frozen && "is-frozen",
      )}
      data-key={model.slug}
      aria-pressed={held ? undefined : state === "picked"}
      aria-disabled={held || frozen ? true : undefined}
      aria-describedby={held ? heldNoteId : undefined}
      title={held ? `Already in ${profileName}` : undefined}
      onClick={() => {
        if (!held && !frozen) onToggle(model);
      }}
    >
      <span className="mb-name">
        <b>{model.name}</b>
        <small>{model.maker === undefined ? model.slug : `${model.maker} · ${model.slug}`}</small>
      </span>
      <span className="mb-num">{describeContextWindow(model)}</span>
      <span className="mb-num">{describeModelPrice(model)}</span>
      <span className="mb-act" aria-hidden="true">
        {state === "open" ? <PlusIcon size={13} /> : <CheckIcon size={13} />}
      </span>
      {held ? (
        <span id={heldNoteId} hidden>
          {`Already in ${profileName}`}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Renders the table of the model browser: a head with how many models
 * match, then a row for each model of `models`, or `whenEmpty` under the head
 * when there is none (the dialog says why: the catalog is still being read, the
 * read failed, or nothing matches).
 *
 * The rows are virtualized: only the ones in view and a few beyond it are
 * mounted, each at the height the stylesheet gives it, so a catalog of a
 * thousand models costs about what forty cost. This is not `VirtualList`,
 * which draws a `nav` landmark and keeps a focus of its own, neither of which
 * a table inside a dialog wants. The focused row stays mounted, so Tab never
 * loses its place when the row scrolls out of view.
 *
 * `held` holds the slugs the profile has, and `picked` the slugs in the tray.
 * While `frozen`, no row can be pressed (the picks are being saved).
 * The list scrolls back to the top whenever `models` is a new array, so a new
 * search or filter shows its first matches. The caller therefore keeps the
 * same array until the query or the catalog changes.
 */
export function ModelBrowserList({
  models,
  held,
  picked,
  frozen,
  profileName,
  whenEmpty,
  onToggle,
}: {
  readonly models: readonly ModelCatalogItem[];
  readonly held: ReadonlySet<string>;
  readonly picked: ReadonlySet<string>;
  readonly frozen: boolean;
  readonly profileName: string;
  readonly whenEmpty: ReactNode;
  readonly onToggle: (model: ModelCatalogItem) => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useMeasuredAtTextSize(readRowHeight);
  const estimateSize = useCallback(() => rowHeight, [rowHeight]);
  const rows = useMemo(
    (): readonly Row[] => models.map((model) => ({ key: model.slug, model })),
    [models],
  );
  useLayoutEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0;
  }, [models]);
  // The row that holds the focus, which the virtual list keeps mounted.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const { lines, totalSize } = useVirtualLines(rows, scrollRef, estimateSize, null, focusedKey);
  return (
    <div
      className="mb-main"
      ref={scrollRef}
      onFocus={(event: FocusEvent<HTMLElement>) => {
        setFocusedKey(event.target.closest<HTMLElement>(".mb-row")?.dataset.key ?? null);
      }}
      onBlur={(event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null);
      }}
    >
      <div className="mb-th">
        <span role="status">{`${String(models.length)} ${models.length === 1 ? "model" : "models"}`}</span>
        <span>Context</span>
        <span>In / out per M</span>
        <span />
      </div>
      {whenEmpty}
      {rows.length === 0 ? null : (
        <div className="mb-rows" style={{ height: totalSize }}>
          {lines.map((line) =>
            line.kind === "gap" ? (
              <div key={line.key} style={{ height: line.height }} />
            ) : (
              <ModelBrowserRow
                key={line.item.key}
                model={line.item.model}
                state={
                  held.has(line.item.key) ? "held" : picked.has(line.item.key) ? "picked" : "open"
                }
                frozen={frozen}
                profileName={profileName}
                onToggle={onToggle}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** What the table says when no model matches: a title and a line under it. */
export function NoModelMatches(): JSX.Element {
  return (
    <div className="mb-empty">
      <b>{NO_MODEL_MATCHES_TEXT.title}</b>
      <span>{NO_MODEL_MATCHES_TEXT.hint}</span>
    </div>
  );
}
