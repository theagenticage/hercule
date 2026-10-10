/**
 * The rows of an expanded work stretch, drawn below its divider: one row per
 * step or group of steps, from `buildWorkRows`. A row is its icon, its label
 * and target, its result when that is not "completed", the time it started,
 * shown while the pointer is on the row, and a chevron when there is
 * something to open: a group's steps, or a step's output and images.
 *
 * The book draws no expanded stretch, so the rows are built from its parts:
 * the divider's type and inks, the icons, and the code block's sunken box
 * for a step's output.
 */
import type { JSX } from "react";
import type { WorkRow, WorkRowIcon } from "@hercule/client-core";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { CloseIcon } from "../../icons/close";
import { CrewIcon } from "../../icons/crew";
import { EyeIcon } from "../../icons/eye";
import { FileIcon } from "../../icons/file";
import { GlobeIcon } from "../../icons/globe";
import type { IconProps } from "../../icons/icon-frame";
import { ListIcon } from "../../icons/list";
import { MoreIcon } from "../../icons/more";
import { PuzzleIcon } from "../../icons/puzzle";
import { SearchIcon } from "../../icons/search";
import { SparkleIcon } from "../../icons/sparkle";
import { TerminalIcon } from "../../icons/terminal";
import { ToolResultImages } from "../attachments/tool-result-images";
import { formatBlockTime } from "../session/messages";

/** The icon each `WorkRowIcon` name is drawn with. */
const WORK_ROW_ICONS: Record<WorkRowIcon, (props: IconProps) => JSX.Element> = {
  eye: EyeIcon,
  search: SearchIcon,
  terminal: TerminalIcon,
  file: FileIcon,
  globe: GlobeIcon,
  puzzle: PuzzleIcon,
  crew: CrewIcon,
  list: ListIcon,
  sparkle: SparkleIcon,
  close: CloseIcon,
  more: MoreIcon,
};

/**
 * Renders `rows` as a list, and below each open row its steps, or its output
 * and images.
 *
 * - `openKeys` holds the keys of the rows the reader opened. It belongs to
 *   the transcript, so a row stays open while its stretch scrolls out of the
 *   mounted range and back.
 * - `onToggle` opens or closes the row with the key it is passed.
 * - `timezone` and `today` format each row's time, as `formatBlockTime` does.
 */
export function WorkRowList({
  rows,
  openKeys,
  onToggle,
  timezone,
  today,
}: {
  readonly rows: readonly WorkRow[];
  readonly openKeys: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly timezone: string;
  readonly today: number;
}): JSX.Element {
  return (
    <ul className="work-rows">
      {rows.map((row) => {
        const open = row.canOpen && openKeys.has(row.key);
        const cells = <WorkRowCells row={row} timezone={timezone} today={today} />;
        return (
          <li key={row.key}>
            {row.canOpen ? (
              <button
                type="button"
                className="work-row"
                aria-expanded={open}
                aria-label={describeRowForScreenReader(row)}
                onClick={() => {
                  onToggle(row.key);
                }}
              >
                {cells}
              </button>
            ) : (
              <div className="work-row">{cells}</div>
            )}
            {!open ? null : row.steps.length > 0 ? (
              <WorkRowList
                rows={row.steps}
                openKeys={openKeys}
                onToggle={onToggle}
                timezone={timezone}
                today={today}
              />
            ) : (
              <WorkRowOutput text={row.output} images={row.images} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Returns the name a screen reader reads for an openable row: its label, its
 * target and its result word, with commas where the row puts a gap, as the
 * divider's name does. Without it, the reader would run the cells together,
 * as in "Ran bun testrunning". A completed row has no result word.
 */
const describeRowForScreenReader = (row: WorkRow): string =>
  [row.label, row.target, row.result === "completed" ? "" : row.result]
    .filter((part) => part !== "")
    .join(", ");

/**
 * Renders the cells of one row: the icon, the label and target, the result,
 * the time and, when the row can open, the chevron. The chevron is
 * decorative, because the row's `aria-expanded` says whether it is open. The
 * time is hidden from screen readers: it shows only on hover, as a detail.
 *
 * A target that is code (`WorkRow.targetIsCode`), such as a command or a
 * path, is drawn in the mono face; any other target, such as a web search's
 * query, in the UI face, since the design language keeps the mono face for
 * code.
 */
function WorkRowCells({
  row,
  timezone,
  today,
}: {
  readonly row: WorkRow;
  readonly timezone: string;
  readonly today: number;
}): JSX.Element {
  const Icon = WORK_ROW_ICONS[row.icon];
  const time = formatBlockTime(row.startedAt, timezone, today);
  return (
    <>
      <Icon size={14} />
      <span className="work-label">
        {row.label}
        {row.target === "" ? null : (
          <>
            {" "}
            {row.targetIsCode ? (
              <code className="work-target">{row.target}</code>
            ) : (
              <span className="work-target">{row.target}</span>
            )}
          </>
        )}
      </span>
      <WorkRowResult result={row.result} />
      {time === undefined ? null : (
        <span className="work-time" aria-hidden="true">
          {time}
        </span>
      )}
      {row.canOpen ? <ChevronRightIcon size={12} /> : null}
    </>
  );
}

/**
 * Renders a row's result when it is not "completed": a small cross named
 * "Failed" for a failed step, and the word itself for a step that was
 * declined, still runs, or waits on approval. Returns nothing for a
 * completed step, which is what most steps are.
 *
 * The cross is in the muted ink, not in tomato: a step that failed is part of
 * the agent's work, which went on, and the turn's own ending says when the
 * turn failed.
 */
function WorkRowResult({ result }: { readonly result: WorkRow["result"] }): JSX.Element | null {
  switch (result) {
    case "completed":
      return null;
    case "failed":
      return (
        <span className="work-result" role="img" aria-label="Failed">
          <CloseIcon size={12} />
        </span>
      );
    default:
      return <span className="work-result">{result}</span>;
  }
}

/**
 * Renders what an open step returned: its text, in a box that scrolls past
 * its maximum height, and under it the images, as tiles. A step that
 * returned only images draws no empty box.
 */
function WorkRowOutput({
  text,
  images,
}: {
  readonly text: string;
  readonly images: WorkRow["images"];
}): JSX.Element {
  return (
    <div className="work-output">
      {text === "" ? null : <pre className="work-output-text">{text}</pre>}
      {images.length === 0 ? null : <ToolResultImages images={images} />}
    </div>
  );
}
