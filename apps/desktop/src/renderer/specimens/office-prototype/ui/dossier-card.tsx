/**
 * PROTOTYPE - the dossier card: what the office knows about the selected
 * colleague, on a glass card at the top left of the office.
 *
 * - The header: the colleague's face in its hue and pose, its name, and its
 *   state.
 * - The request it waits on, when it waits on the user, with the answers as
 *   buttons, the suggested one first.
 * - Its last few activities, newest last, the older ones fading out.
 * - The facts: the thread's title, the room, the runner and the model. For
 *   Triage, its last and next run, the Proposals pinned and the open Tasks.
 * - Open thread, for a colleague that holds a thread.
 *
 * The card hides while the thread drawer is open, because the drawer shows
 * the same thread in full. After the selection is cleared the card keeps the
 * last colleague drawn while it fades out.
 */
import { useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { Face } from "../../../faces";
import { Mark } from "../../../marks";
import { ProjectTile, type ProjectTint } from "../../../screens/project-tile";
import type { OfficeScene } from "../office-scene";
import {
  readColleagueStates,
  readOffice,
  setOffice,
  subscribeColleagueStates,
  subscribeOffice,
} from "../office-store";
import type { OfficeRequest, Pose, ProjectKey, World } from "../world/types";
import { applyColleagueState, readAnswers, sendAnswer, subscribeAnswers } from "./answers";
import { CloseIcon, SleepIcon } from "./office-icons";
import { listColleaguesInPose } from "./office-keys";

/** The tint of each project's tile, as the sidebar draws the same projects. */
const PROJECT_TINTS: Readonly<Record<ProjectKey, ProjectTint>> = {
  webshop: "webshop",
  "payments-api": "payments",
  ops: "ops",
};

/** Returns the tint of `project`'s tile, or null for a project the fixture does not know. */
export const findProjectTint = (project: string): ProjectTint | null =>
  Object.hasOwn(PROJECT_TINTS, project) ? PROJECT_TINTS[project as ProjectKey] : null;

/** How many activities the ticker shows. */
const TICKER_LENGTH = 4;

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

/** Returns the class of the button for `answer`, the `index`th answer of a request. */
const decideAnswerClass = (answer: string, index: number): string =>
  index === 0
    ? "btn btn--accent btn--sm"
    : answer === "Deny"
      ? "btn btn--quiet btn--sm"
      : answer === "Delete"
        ? "btn btn--danger btn--sm"
        : "btn btn--sm";

/** Renders what a request asks: a command in code, or a question as it is written. */
function RequestQuestion({ request }: { readonly request: OfficeRequest }): JSX.Element {
  if (request.kind === "question") return <p className="next-q">{request.prompt}</p>;
  const [command, note] = request.prompt.split(/\s+#\s*/);
  return (
    <p className="next-q">
      Run <code>{command}</code>?
      {note === undefined ? null : <small className="office-card-note">{note}</small>}
    </p>
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
  const answers = useSyncExternalStore(subscribeAnswers, readAnswers);
  const states = useSyncExternalStore(subscribeColleagueStates, readColleagueStates);
  const selected = world.colleagues.find((each) => each.id === state.selectedId) ?? null;
  const [shown, setShown] = useState(selected);
  if (selected !== null && selected !== shown) setShown(selected);
  const open = selected !== null && !state.drawer;

  if (shown === null) return <section className="office-card glass" data-open={false} inert />;

  const colleague = applyColleagueState(shown, states);
  const { pose, request } = colleague;
  const answer = answers.get(colleague.id);
  const waiting = listColleaguesInPose(world, states, "waiting");
  const runner = world.runners.find((each) => each.id === colleague.runnerId);
  const layout = scene?.readLayout();
  const roomId = layout?.homes.get(colleague.id)?.roomId;
  const room = layout?.rooms.find((each) => each.id === roomId);
  const activity = [
    ...colleague.activity,
    ...(answer === undefined ? [] : [`You answered: ${answer}`]),
  ].slice(-TICKER_LENGTH);

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

      {request === null ? null : (
        <div className="office-card-request">
          <div className="office-card-ask">
            <span className="office-card-ask-h">Waiting on you · {request.waitingMinutes}m</span>
            <span className="next-of">
              {waiting.findIndex((each) => each.id === colleague.id) + 1} of {waiting.length}
            </span>
          </div>
          <RequestQuestion request={request} />
          <div className="next-a">
            {request.answers.map((each, index) => (
              <button
                key={each}
                type="button"
                className={decideAnswerClass(each, index)}
                onClick={() => sendAnswer(colleague, each)}
              >
                {each}
              </button>
            ))}
          </div>
        </div>
      )}

      {activity.length === 0 ? null : (
        <ol className="office-card-ticker" aria-label="Activity" data-full={activity.length >= 3}>
          {activity.map((line, index) => (
            <li key={`${String(index)}:${line}`} data-you={line.startsWith("You answered")}>
              {line}
            </li>
          ))}
        </ol>
      )}

      <dl className="office-card-facts">
        {colleague.role === "triage" ? (
          <>
            <Fact name="Last run">{world.triage.lastRun}</Fact>
            <Fact name="Next run">{world.triage.nextRun}</Fact>
            <Fact name="Proposals">
              {world.proposals.total}
              {world.proposals.burning === 0 ? null : (
                <span className="office-card-burning"> · {world.proposals.burning} burning</span>
              )}
            </Fact>
            <Fact name="Open Tasks">{world.openTasks}</Fact>
          </>
        ) : (
          <>
            {colleague.role === "session" && colleague.title !== colleague.name ? (
              <Fact name="Thread">{colleague.title}</Fact>
            ) : null}
            <Fact name="Room">
              {colleague.project === null ? null : (
                <ProjectTile tint={PROJECT_TINTS[colleague.project]} name={colleague.project} />
              )}
              <span>{room?.label ?? colleague.area}</span>
            </Fact>
            <Fact name="Runner">
              {runner === undefined ? (
                <span className="faint">none while asleep</span>
              ) : (
                <>
                  {runner.name}
                  {runner.local ? <span className="faint"> · this Mac</span> : null}
                </>
              )}
            </Fact>
            {colleague.model === null ? null : <Fact name="Model">{colleague.model}</Fact>}
          </>
        )}
      </dl>

      {colleague.role === "session" ? (
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
      ) : null}
    </section>
  );
}
