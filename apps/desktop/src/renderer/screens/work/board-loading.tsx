import type { JSX } from "react";
import { BOARD_STAGES } from "@hercule/contract";
import { FolderIcon } from "../../icons/folder";

/** How many quiet cards each stage of a loading lane shows: five columns, a few rows. */
const LOADING_CARDS_PER_STAGE: readonly number[] = [2, 1, 2, 1, 0];

/**
 * Renders the board while its first read is on its way: the lanes' heads and
 * their cells are already in place, and each card shows two quiet bars where
 * its words will be. Cards are one height, so nothing moves when the words
 * arrive. `laneNames` are the Projects the lanes will probably be.
 */
export function BoardLoading({
  laneNames,
}: {
  readonly laneNames: readonly string[];
}): JSX.Element {
  return (
    <div className="board-lanes" aria-busy="true" aria-label="Loading the board">
      {laneNames.map((name) => (
        <section key={name} className="board-lane" aria-hidden="true">
          <h3 className="board-lane-head">
            <span className="board-lane-button">
              <span className="board-chevron" />
              <span className="board-lane-folder">
                <FolderIcon size={14} />
              </span>
              <span className="board-lane-name">{name}</span>
            </span>
          </h3>
          <div className="board-grid">
            {BOARD_STAGES.map((stage, column) => (
              <div key={stage} className="board-cell">
                {Array.from({ length: LOADING_CARDS_PER_STAGE[column] ?? 0 }, (_, row) => (
                  <div key={row} className="desk-card board-skeleton">
                    <i className="card-stock" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
