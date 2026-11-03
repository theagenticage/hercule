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

/** Where the user is in Fleet, as the header draws it. */
export type FleetHeaderPlace =
  | { readonly page: "fleet" }
  | { readonly page: "machine"; readonly machine: FleetHeaderMachine }
  | {
      readonly page: "activity";
      readonly runnerId: string;
      readonly machine: FleetHeaderMachine;
    };

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

/**
 * Renders the floating header of every Fleet route (spec 17 §Fleet, "The
 * routes and the way in").
 *
 * - On the Fleet page, it holds the title "Fleet", then a jump link for each
 *   of `sections`.
 * - On a machine's page, the title is the crumb "Fleet /", a link back, then
 *   the machine's icon and name, then the jump links.
 * - On a machine's activity, the title is the crumbs "Fleet / atlas /", each a
 *   link back to its page, then "Activity". It has no jump links.
 * - "Add a machine" is at the far end on all of them. Pressing it calls
 *   `onAddMachine`.
 *
 * The jump link of `activeSectionId` is lit. Pressing a jump link calls
 * `onJump` with the section's id.
 */
export function FleetHeader({
  place,
  sections,
  activeSectionId,
  onJump,
  onAddMachine,
}: {
  readonly place: FleetHeaderPlace;
  readonly sections: ReadonlyArray<FleetSection>;
  readonly activeSectionId: string | null;
  readonly onJump: (sectionId: string) => void;
  readonly onAddMachine: () => void;
}): JSX.Element {
  return (
    <header className="top">
      <nav className="pill fleet-header-pill" aria-label="Fleet">
        <FleetHeaderTitle place={place} />
        {sections.length === 0 ? null : (
          <>
            {place.page === "machine" ? <i className="fleet-header-rule" /> : null}
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={section.id === activeSectionId ? "ptab is-on" : "ptab"}
                aria-current={section.id === activeSectionId ? "location" : undefined}
                onClick={() => onJump(section.id)}
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
