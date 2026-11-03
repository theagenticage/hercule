import type { CSSProperties, JSX } from "react";
import type {
  FleetSoftware,
  SoftwareCell,
  SoftwareColumn,
  SoftwareLatest,
  SoftwareRow,
} from "@hercule/client-core/software";
import { CheckIcon } from "../../icons/check";
import { ChevronRightIcon } from "../../icons/chevron-right";
import "./fleet-page.css";
import "./fleet-software.css";

/** The short dash that stands for "not installed", in the cells and in the key. */
const NOT_INSTALLED_DASH = "–";

/** The id of the detail that a tool's name opens, so the name can point at it with `aria-controls`. */
const buildDetailId = (key: string): string => `fleet-software-detail-${key.replace(/\W+/g, "-")}`;

/**
 * Renders one machine's cell of a tool's row, as its kind says:
 *
 * - `latest`: a check, with the version as text for assistive technology;
 * - `older`: the version in the marigold ink;
 * - `below-floor`: the version in the failure ink, with its tooltip;
 * - `not-installed`: a short dash, with "Not installed" as text for
 *   assistive technology;
 * - `version`, `unknown-version` and `not-probed`: the version, "Installed"
 *   or "Unknown" (with a tooltip for the last two).
 *
 * A machine that is away shows what it last reported: every cell that has a
 * version draws the version as text in the muted colour, a `latest` one too
 * (see `fleet-software.css`). Only the dash stays a dash.
 */
function SoftwareCellView({ cell }: { readonly cell: SoftwareCell }): JSX.Element {
  const className = cell.isAway
    ? `fleet-sw-cell is-${cell.kind} is-away`
    : `fleet-sw-cell is-${cell.kind}`;
  const showsCheck = cell.kind === "latest" && !cell.isAway;
  // A check shows nothing of the version, and a raw version string can be cut
  // short, so both carry the version in their tooltip.
  const title =
    cell.tooltip ?? (cell.kind === "latest" || cell.kind === "version" ? cell.text : undefined);
  return (
    <div role="cell" className={className} title={title}>
      {showsCheck ? (
        <>
          <CheckIcon size={13} />
          <span className="fleet-sw-hidden">{cell.text}</span>
        </>
      ) : cell.kind === "not-installed" ? (
        <>
          <span aria-hidden="true">{NOT_INSTALLED_DASH}</span>
          <span className="fleet-sw-hidden">{cell.text}</span>
        </>
      ) : (
        cell.text
      )}
    </div>
  );
}

/** Renders the Latest cell of a tool's row: the version in its tone, then the note, such as "checked 09:00", in muted text. */
function SoftwareLatestCell({ latest }: { readonly latest: SoftwareLatest }): JSX.Element {
  return (
    <div
      role="cell"
      className={`fleet-sw-latest is-${latest.tone}`}
      title={latest.tooltip ?? undefined}
    >
      <span>{latest.text}</span>
      {latest.note === null ? null : <small>{latest.note}</small>}
    </div>
  );
}

/**
 * Renders what a tool's row shows when it is open, in place under the row:
 * what the tool is and its latest release on the left, and the machines by
 * version on the right. Under 800px of width the two stack.
 */
function SoftwareDetail({ row }: { readonly row: SoftwareRow }): JSX.Element {
  const { description, latestLine, versions } = row.detail;
  return (
    <div role="row" id={buildDetailId(row.key)} className="fleet-sw-detail-row">
      <div role="cell" className="fleet-sw-detail">
        <div className="fleet-sw-detail-main">
          {description === null ? null : <p className="fleet-sw-blurb">{description}</p>}
          <p className="fleet-sw-latest-line">{latestLine}</p>
        </div>
        <dl className="fleet-sw-versions">
          {versions.map((group) => (
            <div key={group.text}>
              <dt>{group.text}</dt>
              <dd>{group.machines.join(", ")}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** Renders a tool's row: its name (which opens the detail), its Latest cell and one cell per machine, then the detail while it is open. */
function SoftwareToolRow({
  row,
  isOpen,
  onToggle,
}: {
  readonly row: SoftwareRow;
  readonly isOpen: boolean;
  readonly onToggle: (key: string) => void;
}): JSX.Element {
  return (
    <>
      <div role="row" className="fleet-sw-row">
        <div role="rowheader" className="fleet-sw-tool">
          <button
            type="button"
            className="fleet-sw-name"
            aria-expanded={isOpen}
            aria-controls={isOpen ? buildDetailId(row.key) : undefined}
            onClick={() => onToggle(row.key)}
          >
            <ChevronRightIcon size={12} />
            <span>{row.name}</span>
          </button>
        </div>
        <SoftwareLatestCell latest={row.latest} />
        {row.cells.map((cell, index) => (
          <SoftwareCellView key={index} cell={cell} />
        ))}
      </div>
      {isOpen ? <SoftwareDetail row={row} /> : null}
    </>
  );
}

/** Renders the head of a machine's column: its name, as a button that opens the machine's page at its Software. */
function SoftwareColumnHead({
  column,
  onOpenMachine,
}: {
  readonly column: SoftwareColumn;
  readonly onOpenMachine: (runnerId: string) => void;
}): JSX.Element {
  // The name alone would be the name of the machine's card as well.
  const label = `Open ${column.name} at Software`;
  return (
    <div role="columnheader" className="fleet-sw-machine-cell">
      <button
        type="button"
        className={column.isAway ? "fleet-sw-machine is-away" : "fleet-sw-machine"}
        aria-label={label}
        title={label}
        onClick={() => onOpenMachine(column.runnerId)}
      >
        {column.name}
      </button>
    </div>
  );
}

/**
 * Renders the Software section of the Fleet page (spec 17 §Fleet, Software):
 * tools down and machines across, in the groups of `software`, and under the
 * grid a key to its cells.
 *
 * - The grid scrolls sideways inside its own box when there are more machines
 *   than fit, and the Tool and Latest columns stay in place.
 * - A tool's name opens its detail in place, under its row. `openKey` is the
 *   key of the row that is open, or `null`; pressing a name calls `onToggle`
 *   with the row's key.
 * - A machine's column head calls `onOpenMachine` with its runner id.
 * - With no machine column the section keeps its heading and, in place of
 *   the grid and the key, says that Software shows once a machine has joined.
 * - It only shows. Nothing is installed or updated from here.
 */
export function FleetSoftwarePanel({
  software,
  openKey,
  onToggle,
  onOpenMachine,
}: {
  readonly software: FleetSoftware;
  readonly openKey: string | null;
  readonly onToggle: (key: string) => void;
  readonly onOpenMachine: (runnerId: string) => void;
}): JSX.Element {
  return (
    <section id="software" className="fleet-software" aria-labelledby="fleet-software-heading">
      <div className="fleet-sec-h">
        <h2 id="fleet-software-heading">Software</h2>
      </div>
      {software.columns.length === 0 ? (
        <p className="fleet-sw-empty">Software shows here once a machine has joined.</p>
      ) : (
        <>
          <div className="fleet-sw-scroll">
            <div
              role="table"
              aria-label="Software on each machine"
              className="fleet-sw-table"
              style={{ "--fleet-sw-columns": software.columns.length } as CSSProperties}
            >
              <div role="row" className="fleet-sw-head">
                <div role="columnheader">Tool</div>
                <div role="columnheader">Latest</div>
                {software.columns.map((column) => (
                  <SoftwareColumnHead
                    key={column.runnerId}
                    column={column}
                    onOpenMachine={onOpenMachine}
                  />
                ))}
              </div>
              {software.groups.map((group) => (
                <div key={group.name} role="rowgroup">
                  <div role="row" className="fleet-sw-group">
                    <div role="rowheader">{group.name}</div>
                  </div>
                  {group.rows.map((row) => (
                    <SoftwareToolRow
                      key={row.key}
                      row={row}
                      isOpen={openKey === row.key}
                      onToggle={onToggle}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <p className="fleet-sw-key">
            <span>
              <CheckIcon size={12} /> latest
            </span>
            <span>
              <b className="is-older">1.2.3</b> older
            </span>
            <span>
              <b>{NOT_INSTALLED_DASH}</b> not installed
            </span>
          </p>
        </>
      )}
    </section>
  );
}
