/**
 * The dossier card: what the Office knows about the selected colleague, on
 * a glass card at the top left of the Office.
 *
 * - The header: the colleague's face in its hue and pose, its name, and its
 *   state. An assistant's state line starts with "Assistant".
 * - The oldest Request it waits on, when it waits on the user, answered with the
 *   same dock and the same operations as the thread screen's.
 * - The facts: the room, the runner and the model, and for an assistant
 *   when its current session was last active.
 * - Open thread for a thread, Open session for an Agent's session, or Open
 *   conversation for an assistant.
 *
 * The card hides while the drawer is open, because the drawer shows the
 * same thread or Conversation in full. The card keeps the colleague's Request drafts, as
 * the drawer does, so an answer begun on the card is still there in the
 * drawer, and the other way round. As the card keeps the last colleague
 * drawn after the selection is cleared, it keeps that colleague's drafts
 * until another colleague is selected or the Office closes.
 */
import { useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { isAbsentPose } from "@hercule/client-core";
import { Face } from "../../faces";
import { Mark } from "../../marks";
import { ProjectTile } from "../../screens/project-tile";
import { RequestDock } from "../../screens/session/dock";
import { useAgeLabel, useAgeWords } from "../../app/age-clock";
import { buildAssistantDraftKey } from "../../app/pending-submissions";
import { useKeepRequestDrafts } from "../../app/request-drafts";
import type { BuiltOffice } from "../engine/contracts";
import {
  applyColleagueState,
  readColleagueStates,
  readOffice,
  setOffice,
  subscribeColleagueStates,
  subscribeOffice,
} from "../office-store";
import type { ColleagueKind, World } from "../world/types";
import { CloseIcon } from "../../icons/close";
import { listColleaguesInPose } from "./office-keys";

/**
 * Renders the head of the card's Request: how long the colleague has waited
 * since `waitingSince`, counted as the sidebar counts a thread's age, and its
 * place in the queue. The age stays current only while `counting` is true.
 */
function RequestHead({
  waitingSince,
  place,
  queueLength,
  counting,
}: {
  readonly waitingSince: string;
  readonly place: number;
  readonly queueLength: number;
  readonly counting: boolean;
}): JSX.Element {
  const age = useAgeLabel(waitingSince, counting);
  return (
    <div className="office-card-ask">
      <span className="office-card-ask-h">Waiting on you · {age}</span>
      <span className="next-of">
        {place} of {queueLength}
      </span>
    </div>
  );
}

/**
 * Renders the card's Last active fact: how long ago `at` was, in words, such
 * as "2 hours ago", counted as the sidebar counts a thread's age. The age
 * stays current only while `counting` is true.
 */
function LastActiveFact({
  at,
  counting,
}: {
  readonly at: string;
  readonly counting: boolean;
}): JSX.Element {
  return <Fact name="Last active">{useAgeWords(at, counting)}</Fact>;
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

/**
 * The word the card's state line starts with for each kind of colleague, or
 * null for a thread, which needs none: most colleagues are threads.
 */
const KIND_WORDS: Readonly<Record<ColleagueKind, string | null>> = {
  thread: null,
  run: "Workflow step",
  agent: "Agent",
  assistant: "Assistant",
};

/** The label of the card's button that opens the colleague in the drawer. */
const OPEN_WORDS: Readonly<Record<ColleagueKind, string>> = {
  thread: "Open thread",
  run: "Open session",
  agent: "Open session",
  assistant: "Open conversation",
};

/** Renders the dossier card of the selected colleague. It shows while a colleague is selected and the drawer is closed. */
export function DossierCard({
  world,
  office,
}: {
  readonly world: World;
  /** The office as built now, or null before the scene mounts. */
  readonly office: BuiltOffice | null;
}): JSX.Element {
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  const states = useSyncExternalStore(subscribeColleagueStates, readColleagueStates);
  const selected = world.colleagues.find((each) => each.id === state.selectedId) ?? null;
  const [shown, setShown] = useState(selected);
  if (selected !== null && selected !== shown) setShown(selected);
  const open = selected !== null && !state.drawer;
  useKeepRequestDrafts(shown?.sessionId ?? null);

  if (shown === null) return <section className="office-card glass" data-open={false} inert />;

  const colleague = applyColleagueState(shown, states);
  const { pose, request, oldestRequest, sessionId } = colleague;
  const assistant = colleague.kind === "assistant";
  const kindWord = KIND_WORDS[colleague.kind];
  const waiting = listColleaguesInPose(world, states, "waiting");
  const runner = world.runners.find((each) => each.id === colleague.runnerId);
  const roomId = office?.homes.get(colleague.id)?.roomId;
  const room = office?.rooms.find((each) => each.id === roomId);

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
            {kindWord === null ? null : (
              <>
                <span>{kindWord}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            {isAbsentPose(pose) ? null : <Mark state={pose} />}
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

      {request === null || oldestRequest === null || sessionId === null ? null : (
        <div className="office-card-request">
          <RequestHead
            waitingSince={request.waitingSince}
            place={waiting.findIndex((each) => each.id === colleague.id) + 1}
            queueLength={waiting.length}
            counting={open}
          />
          <RequestDock
            key={oldestRequest.requestId}
            sessionId={sessionId}
            look={colleague.look}
            request={oldestRequest}
            composerBelow={false}
            messageDraftKey={assistant ? buildAssistantDraftKey(colleague.id) : sessionId}
          />
        </div>
      )}

      <dl className="office-card-facts">
        <Fact name="Room">
          {room === undefined ? null : room.kind === "project" ? (
            <ProjectTile tint={room.tint} name={room.label} />
          ) : (
            <span>{room.label}</span>
          )}
        </Fact>
        <Fact name="Runner">
          {runner === undefined ? (
            <span className="faint">
              {assistant && colleague.runnerId === null ? "no session" : "unknown"}
            </span>
          ) : (
            <>
              {runner.name}
              {runner.local ? <span className="faint"> · this Mac</span> : null}
            </>
          )}
        </Fact>
        {colleague.model === null ? null : <Fact name="Model">{colleague.model}</Fact>}
        {colleague.lastActivityAt === null ? null : (
          <LastActiveFact at={colleague.lastActivityAt} counting={open} />
        )}
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
          {OPEN_WORDS[colleague.kind]}
          <kbd>↩</kbd>
        </button>
      </footer>
    </section>
  );
}
