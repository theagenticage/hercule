/**
 * The Requests dock while it shows a Permission Request: a session asking
 * for a grant its profile lacks. A thread's agent page and an assistant's
 * Conversation draw it when no agent Request is open.
 */
import { useEffect, useId, type JSX, type KeyboardEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildPermissionRequestCard,
  buildPermissionRequestDock,
  readErrorMessage,
} from "@hercule/client-core";
import type {
  ApprovalDecision,
  PermissionDecisionOutcome,
  PermissionRequest,
  Session,
} from "@hercule/contract";
import { profilesQuery } from "../../app/queries";
import { useRequestDraft, useShownRequestId } from "../../app/request-drafts";
import { Face, type Look } from "../../faces";
import { AnswerLedger, findDecisionForKey, ShrunkDockRow, type DockAnswer } from "./dock";
import { RequestPager } from "./request-pager";
import "./dock.css";

/**
 * The approval decision each answer mirrors, as the Bureau book's dock draws
 * Allow once, Always allow and Deny: the answer takes that decision's key
 * and its button. "This session only" is the suggested answer, as Allow once
 * is.
 */
const MIRRORED_DECISIONS: Readonly<Record<PermissionDecisionOutcome, ApprovalDecision>> = {
  session: "allow",
  profile: "allow_always",
  deny: "deny",
};

/**
 * Renders the dock of the open Permission Request of `session` that the
 * user paged to, or the oldest, or nothing while none is open. `look` is the
 * face of the session's own agent, the thread's or the assistant's.
 *
 * While several are open, the pager line above the dock pages between them.
 * It names no asker: a Permission Request is always the session's own.
 * Paging is kept in the session's Request drafts, as the agent Requests'
 * is; the two never share an id, so a paged-to id picks only its own kind.
 */
export function SessionPermissionRequestDock({
  session,
  look,
}: {
  readonly session: Session;
  readonly look: Look;
}): JSX.Element | null {
  const [shownRequestId, setShownRequestId] = useShownRequestId(session.id);
  const dock = buildPermissionRequestDock(session.openPermissionRequests, shownRequestId);
  if (dock === null) return null;
  return (
    <>
      {dock.position === null ? null : (
        <RequestPager sessionId={session.id} dock={dock} asker={null} onShow={setShownRequestId} />
      )}
      <PermissionRequestDock
        key={dock.request.id}
        sessionId={session.id}
        permissionProfileId={session.permissionProfileId}
        look={look}
        request={dock.request}
      />
    </>
  );
}

/**
 * Renders one Permission Request of the session `sessionId`, docked on top of
 * the composer, as the Bureau book's `.dock` draws an agent Request:
 *
 * - the question: the face of the session's agent, the card's title and the
 *   grant in `code`, then the agent's reason and, when the session named
 *   one, the operation it wanted to call;
 * - the ledger: "This session only", "Add to profile" and "Deny", each with
 *   what it does and its key.
 *
 * The face is in the waiting pose, as on every dock, because the agent asks
 * the user something. The agent is not blocked meanwhile, so nothing else
 * counts the request as waiting on the user.
 *
 * "Add to profile" names the profile `permissionProfileId`, read from the
 * permission profiles. Until that read answers with the profile, the
 * answer's line stays empty and the answer is faded and sends nothing, by
 * click or by key, so the user never widens a profile they cannot see. The
 * read is made only while a Permission Request is shown, and the thread's
 * and the Conversation's loaders make it first when one is open already.
 *
 * No live topic covers the profiles, so the cached list can predate the
 * profile, such as one another client created and the session then resumed
 * onto. When the list the dock finds lacks the profile, the dock reads the
 * profiles once more. It reads them only once: a profile still missing
 * from that read does not exist, and the answer stays faded.
 *
 * While the focus is inside the dock, ↩ on the dock itself answers "This
 * session only", ⌥↩ "Add to profile" and esc "Deny", as the keys of the
 * agent Request's dock do. A focused answer takes ↩ as its own press.
 *
 * The answer is sent with `permission.decide`. The response is not written
 * into the cache: the live `session` push closes the request, and until then
 * the answers stay locked through the Request draft's `answered`. Mount one
 * dock per request, keyed by its id.
 */
function PermissionRequestDock({
  sessionId,
  permissionProfileId,
  look,
  request,
}: {
  readonly sessionId: string;
  readonly permissionProfileId: string;
  readonly look: Look;
  readonly request: PermissionRequest;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const titleId = useId();
  const profiles = useQuery(profilesQuery(client));
  const profileName =
    profiles.data?.find((profile) => profile.id === permissionProfileId)?.name ?? null;
  // `isFetchedAfterMount` turns true with the first read that ends after
  // this dock mounted, so a list read before then is read once more, and a
  // list the dock read itself is not. A read already running joins the one
  // asked for here rather than being restarted, so the effect running twice
  // still makes one read.
  const isProfileMissingFromCachedList =
    profiles.isSuccess && profileName === null && !profiles.isFetchedAfterMount;
  const { refetch: readProfilesAgain } = profiles;
  useEffect(() => {
    if (isProfileMissingFromCachedList) void readProfilesAgain({ cancelRefetch: false });
  }, [isProfileMissingFromCachedList, readProfilesAgain]);
  const card = buildPermissionRequestCard(request, profileName);
  const answers = card.rows.map((row): DockAnswer<PermissionDecisionOutcome> => ({
    ...row,
    decision: MIRRORED_DECISIONS[row.id],
  }));
  const [requestDraft, changeRequestDraft] = useRequestDraft(sessionId, request.id);
  // A failed send unlocks the request, so the user can answer again. The
  // draft is changed through the session's Request drafts, so the unlock
  // lands whether or not the dock is still shown.
  const markAnswered = (answered: boolean): void => {
    changeRequestDraft((current) => ({ ...current, answered }));
  };
  const decide = useMutation({
    mutationFn: (outcome: PermissionDecisionOutcome) =>
      client.permission.decide({ params: { id: request.id }, payload: { outcome } }),
    onMutate: () => markAnswered(true),
    onError: () => markAnswered(false),
  });
  // One answer per request: a second one, sent before the push closes the
  // request, could contradict the first. The keys obey this too.
  const locked = requestDraft.answered || decide.isPending;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (locked) return;
    const decision = findDecisionForKey(event);
    const answer = answers.find((each) => each.decision === decision);
    if (answer === undefined || !answer.available) return;
    // Without this, ↩ or ⌥↩ on a focused answer would also press that
    // answer, and send a second outcome.
    event.preventDefault();
    decide.mutate(answer.id);
  };

  return (
    <div
      className="dock"
      role="group"
      aria-labelledby={titleId}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="fold">
        <div className="dock-q">
          <Face look={look} pose="waiting" size={30} />
          <span className="dock-text">
            <span id={titleId}>{card.title}</span> <code>{card.grant}</code>
          </span>
        </div>
        <div className="dock-permission">
          <span className="dock-permission-reason">{card.reason}</span>
          {card.operation === null ? null : (
            <span className="dock-permission-operation">
              {card.operation.intro} <code>{card.operation.op}</code>
            </span>
          )}
        </div>
        <AnswerLedger
          titleId={titleId}
          answers={answers}
          locked={locked}
          onAnswer={(outcome) => decide.mutate(outcome)}
        />
        {decide.error === null ? null : (
          <p className="dock-error" role="alert">
            {readErrorMessage(decide.error)}
          </p>
        )}
      </div>
      <ShrunkDockRow
        look={look}
        question={card.question}
        answers={answers}
        locked={locked}
        onAnswer={(outcome) => decide.mutate(outcome)}
      />
    </div>
  );
}
