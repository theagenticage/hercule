/**
 * The dossier card: what the Office knows about the selected colleague, on
 * a glass card at the top left of the Office.
 *
 * - The header: the colleague's face in its hue and pose, its name, and its
 *   state.
 * - The Request it waits on, when it waits on the user, answered with the
 *   same dock and the same operations as the thread screen's.
 * - The facts: the thread's title, the room, the runner and the model.
 * - Open thread.
 *
 * The card hides while the thread drawer is open, because the drawer shows
 * the same thread in full. After the selection is cleared the card keeps the
 * last colleague drawn while it fades out.
 */
import { useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { Face } from "../../faces";
import { Mark } from "../../marks";
import { ProjectTile } from "../../screens/project-tile";
import { RequestDock } from "../../screens/thread/dock";
import type { OfficeScene } from "../office-scene";
import {
  applyColleagueState,
  readColleagueStates,
  readOffice,
  setOffice,
  subscribeColleagueStates,
  subscribeOffice,
} from "../office-store";
import type { Pose } from "@hercule/client-core";
import type { World } from "../world/types";
import { CloseIcon } from "../../icons/close";
import { SleepIcon } from "./office-icons";
import { listColleaguesInPose } from "./office-keys";

/** Renders the state mark for `pose`, or a Z for the two poses that have no mark. */
export function PoseMark({ pose }: { readonly pose: Pose }): JSX.Element {
  return pose === "asleep" || pose === "away" ? (
    <span className="office-sleep" aria-hidden="true">
      <SleepIcon size={14} />
    </span>
  ) : (
    <Mark state={pose} />
  );
}

/** Renders one fact of the card: its name at the left, its value at the right. */
function Fact({
  name,
  children,
}: {
  readonly name: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Renders the dossier card of the selected colleague. It shows while a colleague is selected and the drawer is closed. */
export function DossierCard({
  world,
  scene,
}: {
  readonly world: World;
  readonly scene: OfficeScene | null;
}): JSX.Element {
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  const states = useSyncExternalStore(subscribeColleagueStates, readColleagueStates);
  const selected = world.colleagues.find((each) => each.id === state.selectedId) ?? null;
  const [shown, setShown] = useState(selected);
  if (selected !== null && selected !== shown) setShown(selected);
  const open = selected !== null && !state.drawer;

  if (shown === null) return <section className="office-card glass" data-open={false} inert />;

  const colleague = applyColleagueState(shown, states);
  const { pose, request, openRequest } = colleague;
  const waiting = listColleaguesInPose(world, states, "waiting");
  const runner = world.runners.find((each) => each.id === colleague.runnerId);
  const layout = scene?.readLayout();
  const roomId = layout?.homes.get(colleague.id)?.roomId;
  const room = layout?.rooms.find((each) => each.id === roomId);

  return (
    <section
      className="office-card glass"
      data-open={open}
      inert={!open}
      role="dialog"
      aria-label={colleague.name}
    >
      <header className="office-card-h">
        <Face look={colleague.look} pose={pose} size={38} />
        <span className="who-text">
          <span className="who-name">{colleague.name}</span>
          <span className="who-state">
            <PoseMark pose={pose} />
            <span>{colleague.stateLabel}</span>
          </span>
        </span>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Close"
          onClick={() => setOffice({ selectedId: null })}
        >
          <CloseIcon size={14} />
        </button>
      </header>

      {request === null || openRequest === null ? null : (
        <div className="office-card-request">
          <div className="office-card-ask">
            <span className="office-card-ask-h">Waiting on you · {request.waitingMinutes}m</span>
            <span className="next-of">
              {waiting.findIndex((each) => each.id === colleague.id) + 1} of {waiting.length}
            </span>
          </div>
          <RequestDock key={openRequest.requestId} sessionId={colleague.id} request={openRequest} />
        </div>
      )}

      <dl className="office-card-facts">
        {colleague.title !== colleague.name ? <Fact name="Thread">{colleague.title}</Fact> : null}
        <Fact name="Room">
          {room === undefined ? null : room.kind === "project" ? (
            <ProjectTile tint={room.tint} name={room.label} />
          ) : (
            <span>{room.label}</span>
          )}
        </Fact>
        <Fact name="Runner">
          {runner === undefined ? (
            <span className="faint">unknown</span>
          ) : (
            <>
              {runner.name}
              {runner.local ? <span className="faint"> · this Mac</span> : null}
            </>
          )}
        </Fact>
        {colleague.model === null ? null : <Fact name="Model">{colleague.model}</Fact>}
      </dl>

      <footer className="office-card-foot">
        <span className="faint">
          <kbd>esc</kbd> to close
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn--sm"
          aria-keyshortcuts="Enter"
          onClick={() => setOffice({ drawer: true })}
        >
          Open thread
          <kbd>↩</kbd>
        </button>
      </footer>
    </section>
  );
}
