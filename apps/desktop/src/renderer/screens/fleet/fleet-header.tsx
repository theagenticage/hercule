import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { MachineKind } from "@hercule/client-core/fleet";
import { PlusIcon } from "../../icons/plus";
import "../session/floating-header.css";
import "../thread/thread-header.css";
import "./fleet-header.css";
import { MachineIcon } from "./machine-icon";

/** A machine as the header names it: its name and its icon. */
export interface FleetHeaderMachine {
  readonly name: string;
  readonly kind: MachineKind;
}

/**
 * A jump link to one section of the open page. `count` is the small text
 * after the label, drawn in the "you" colour when `isYou`, because the user
 * has something to do there.
 */
export interface FleetSection {
  readonly id: string;
  readonly label: string;
  readonly count?: { readonly text: string; readonly isYou: boolean };
}

/** The jump links of a page that has sections, which one is lit, and what pressing one does. */
export interface FleetSectionJumps {
  readonly sections: ReadonlyArray<FleetSection>;
  /** The id of the section in view, whose link is lit, or `null` when none is. */
  readonly activeSectionId: string | null;
  /** Called with the id of the section whose link was pressed. */
  readonly onJump: (sectionId: string) => void;
}

/** Where the user is in Fleet, as the header draws it. The pages that have sections carry their jump links. */
export type FleetHeaderPlace =
  | ({ readonly page: "fleet" } & FleetSectionJumps)
  | ({ readonly page: "machine"; readonly machine: FleetHeaderMachine } & FleetSectionJumps)
  | {
      readonly page: "activity";
      readonly runnerId: string;
      readonly machine: FleetHeaderMachine;
    };

/**
 * Renders the floating header of every Fleet route (spec 17 §Fleet, "The
 * routes and the way in").
 *
 * - On the Fleet page, it holds the title "Fleet", then a jump link for each
 *   of the page's `sections`.
 * - On a machine's page, the title is the crumb "Fleet /", a link back, then
 *   the machine's icon and name, then the jump links.
 * - On a machine's activity, the title is the crumbs "Fleet / atlas /", each a
 *   link back to its page, then "Activity". It has no jump links.
 * - "Add a machine" is at the far end on all of them. Pressing it calls
 *   `onAddMachine`.
 *
 * The jump link of the section in view is lit. Pressing a jump link calls
 * `onJump` with the section's id. The links are a convenience, so a header
 * too narrow to hold them with the crumbs and "Add a machine" drops them
 * (see fleet-header.css); the sections stay reachable by scrolling.
 */
export function FleetHeader({
  place,
  onAddMachine,
}: {
  readonly place: FleetHeaderPlace;
  readonly onAddMachine: () => void;
}): JSX.Element {
  return (
    <header className="top fleet-header">
      <nav className="pill fleet-header-pill" aria-label="Fleet">
        <FleetHeaderTitle place={place} />
        {place.page === "activity" || place.sections.length === 0 ? null : (
          <>
            {place.page === "machine" ? (
              <i className="fleet-header-rule fleet-header-jump" />
            ) : null}
            {place.sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={
                  section.id === place.activeSectionId
                    ? "ptab fleet-header-jump is-on"
                    : "ptab fleet-header-jump"
                }
                aria-current={section.id === place.activeSectionId ? "location" : undefined}
                onClick={() => place.onJump(section.id)}
              >
                {section.label}
                {section.count === undefined ? null : (
                  <>
                    {" "}
                    <small className={section.count.isYou ? "is-you" : undefined}>
                      {section.count.text}
                    </small>
                  </>
                )}
              </button>
            ))}
          </>
        )}
      </nav>
      <span className="spacer" />
      <nav className="pill" aria-label="Fleet actions">
        <button type="button" className="pill-btn fleet-header-add" onClick={onAddMachine}>
          <PlusIcon size={14} /> Add a machine
        </button>
      </nav>
    </header>
  );
}

/** Renders the pill's first part: the title on the Fleet page, the crumbs on the pages of a machine. */
function FleetHeaderTitle({ place }: { readonly place: FleetHeaderPlace }): JSX.Element {
  switch (place.page) {
    case "fleet":
      return <h1 className="pill-title">Fleet</h1>;
    case "machine":
      return (
        <>
          <FleetCrumb />
          <span className="ptab is-name" aria-current="page">
            <MachineIcon kind={place.machine.kind} size={14} />
            <span className="fleet-header-name">{place.machine.name}</span>
          </span>
        </>
      );
    case "activity":
      return (
        <>
          <FleetCrumb />
          <span className="pill-crumb">
            <Link to="/fleet/$runnerId" params={{ runnerId: place.runnerId }}>
              <MachineIcon kind={place.machine.kind} size={14} />
              <span className="fleet-header-name">{place.machine.name}</span>
            </Link>
          </span>
          <span className="ptab is-name" aria-current="page">
            Activity
          </span>
        </>
      );
  }
}

/** Renders the first crumb of a machine's page: a link to the Fleet page. */
function FleetCrumb(): JSX.Element {
  return (
    <span className="pill-crumb">
      <Link to="/fleet">Fleet</Link>
    </span>
  );
}
