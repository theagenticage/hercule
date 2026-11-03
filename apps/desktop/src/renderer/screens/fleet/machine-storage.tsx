import { useId, type JSX, type ReactNode } from "react";
import type {
  AutomaticCleanup,
  MachineStorage,
  StorageBar as StorageBarModel,
} from "@hercule/client-core/machine-storage";
import type { IdleWorkspaceRow } from "@hercule/client-core/cleanup";
import { QuestionIcon } from "../../icons/question";
import { MachinePageSection } from "./machine-page-section";
import "../thread/menus.css";
import "./machine-storage.css";

/** A removal frees less than this share of what the workspace takes on disk when it shows "of {size}" under its number. */
const FREES_SHOWS_SIZE_BELOW = 0.9;

/**
 * Renders the head's note: the free space, then the forecast, if any, after a
 * dot and in the ink of a need that is coming.
 */
function StorageHeadNote({ head }: { readonly head: MachineStorage["head"] }): JSX.Element {
  return (
    <span className="machine-storage-head">
      {head.freeText}
      {head.forecastText === null ? null : (
        <>
          {" · "}
          <span className="machine-storage-forecast">{head.forecastText}</span>
        </>
      )}
    </span>
  );
}

/**
 * Renders the disk as one bar: the parts that take space, left to right, and
 * a mark where the disk limit is. The free space is the bar's own background.
 * `limitShare` is the limit's share of the disk, counted from the right edge.
 * The bar is decoration: the legend under it says every size in words.
 */
function StorageBar({ bar }: { readonly bar: StorageBarModel }): JSX.Element {
  return (
    <div className="machine-storage-bar" aria-hidden="true">
      {bar.parts.map((part) =>
        part.share === null || part.share <= 0 ? null : (
          <i
            key={part.key}
            className={`machine-storage-seg machine-storage-part--${part.key}`}
            style={{ width: `${part.share * 100}%` }}
          />
        ),
      )}
      {bar.limitShare === null ? null : (
        <b className="machine-storage-limit" style={{ right: `${bar.limitShare * 100}%` }} />
      )}
    </div>
  );
}

/** Renders one entry per part under the bar: its colour, its name and its size. */
function StorageLegend({ bar }: { readonly bar: StorageBarModel }): JSX.Element | null {
  if (bar.parts.length === 0) return null;
  return (
    <ul className="machine-storage-legend">
      {bar.parts.map((part) => (
        <li key={part.key} title={part.tooltip ?? undefined}>
          <i
            className={`machine-storage-swatch machine-storage-part--${part.key}`}
            aria-hidden="true"
          />
          {part.label}
          <b>{part.sizeText}</b>
        </li>
      ))}
    </ul>
  );
}

/**
 * Renders `sentence` with `button` after its last word. The two sit in one
 * nowrap group, so a line that wraps never leaves the button alone.
 */
function SentenceEndingWith({
  sentence,
  button,
}: {
  readonly sentence: string;
  readonly button: ReactNode;
}): JSX.Element {
  const lastWordStart = sentence.lastIndexOf(" ") + 1;
  return (
    <>
      {sentence.slice(0, lastWordStart)}
      <span className="machine-storage-nowrap">
        {sentence.slice(lastWordStart)}
        {button}
      </span>
    </>
  );
}

/**
 * Renders the line on automatic cleanup, with an info button at its end that
 * opens a popover listing the rules. The popover is the browser's own
 * (`popover`), so Esc and a press outside close it. CSS anchors it under the
 * button and flips it to the other side when it would leave the window, which
 * a wrapped line can make happen.
 */
function AutomaticCleanupLine({
  automaticCleanup,
}: {
  readonly automaticCleanup: AutomaticCleanup;
}): JSX.Element {
  const popoverId = useId();
  const anchorName = `--storage-rules-${popoverId.replace(/\W/g, "")}`;
  const { rules } = automaticCleanup;
  const button = (
    <button
      type="button"
      className="icon-btn icon-btn--sm machine-storage-info"
      style={{ anchorName }}
      popoverTarget={popoverId}
      aria-label="When Hercule removes a workspace by itself"
    >
      <QuestionIcon size={14} />
    </button>
  );
  return (
    <div className="machine-storage-auto">
      {automaticCleanup.last === null ? (
        <span>
          <SentenceEndingWith sentence={automaticCleanup.text} button={button} />
        </span>
      ) : (
        <>
          <span>{automaticCleanup.text}</span>{" "}
          <span className="machine-storage-auto-last">
            <SentenceEndingWith sentence={automaticCleanup.last} button={button} />
          </span>
        </>
      )}
      <div
        id={popoverId}
        popover="auto"
        className="pop machine-storage-rules"
        style={{ positionAnchor: anchorName }}
      >
        <b>{rules.intro}</b>
        <ul>
          {rules.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <span>{rules.closing}</span>
      </div>
    </div>
  );
}

/**
 * Renders one of the largest idle workspaces: its name, with under it why its
 * numbers are old or missing, when it was last used, and what removing it
 * frees. A removal that frees clearly less than the workspace takes (a
 * package store its files link to stays) says "of {size}" under the number.
 */
function IdleWorkspace({ row }: { readonly row: IdleWorkspaceRow }): JSX.Element {
  const showsSize =
    row.sizeBytes !== null &&
    row.freesBytes !== null &&
    row.freesBytes < row.sizeBytes * FREES_SHOWS_SIZE_BELOW;
  return (
    <li className="machine-storage-idle-row">
      <span className="machine-storage-idle-name">
        <b>{row.name}</b>
        {row.measuringNote === null ? null : <span>{row.measuringNote}</span>}
      </span>
      <span className="machine-storage-idle-age">{row.lastUsedText}</span>
      <span
        className="machine-storage-idle-frees"
        title={
          row.sizeText !== null && row.freesText !== null
            ? `${row.sizeText} on disk; removing it frees ${row.freesText}`
            : undefined
        }
      >
        {row.freesText}
        {showsSize ? <small>of {row.sizeText}</small> : null}
      </span>
    </li>
  );
}

/**
 * Renders the Storage section of a machine's page (spec 17 §Fleet, A
 * machine's page, point 5) from `storage`: the free space and the forecast in
 * the head, the bar with its legend, the line on automatic cleanup, and the
 * largest idle workspaces.
 *
 * - `cleanUp` is drawn at the right of the head of "Largest idle workspaces":
 *   the button that opens the cleanup dialog.
 * - `readFailure` is drawn under that head when reading the idle workspaces'
 *   Threads failed.
 * - A runner that is too old to measure storage has an empty bar and the
 *   line that says so. A runner that has reported no disk has the head alone.
 */
export function MachineStoragePanel({
  id,
  storage,
  cleanUp,
  readFailure,
}: {
  readonly id: string;
  readonly storage: MachineStorage;
  readonly cleanUp: ReactNode;
  readonly readFailure: ReactNode;
}): JSX.Element {
  const { head, bar, tooOld, automaticCleanup, largestIdle } = storage;
  const headingId = `${id}-idle`;
  // Without a disk report, or on a runner too old to measure, there is nothing to list.
  const isMeasured = tooOld === null && bar !== null;
  return (
    <MachinePageSection id={id} title="Storage" note={<StorageHeadNote head={head} />}>
      {bar === null ? null : (
        <>
          <StorageBar bar={bar} />
          <StorageLegend bar={bar} />
        </>
      )}
      {tooOld === null ? null : <p className="machine-storage-old">{tooOld}</p>}
      {automaticCleanup === null ? null : (
        <AutomaticCleanupLine automaticCleanup={automaticCleanup} />
      )}
      {isMeasured ? (
        <div className="machine-storage-idle">
          <div className="machine-storage-idle-head">
            <h4 id={headingId}>Largest idle workspaces</h4>
            {cleanUp}
          </div>
          {readFailure}
          {largestIdle.length === 0 ? (
            <p className="machine-storage-idle-empty">No idle workspaces.</p>
          ) : (
            <ul className="machine-storage-idle-list" aria-labelledby={headingId}>
              {largestIdle.map((row) => (
                <IdleWorkspace key={row.workspaceId} row={row} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </MachinePageSection>
  );
}
