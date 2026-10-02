import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildFirstRunFacts,
  buildFirstRunLadder,
  buildRoomContents,
  decideFirstRunStep,
  formatControllerAddress,
  invalidateWithoutCancelling,
  isLoopbackOrigin,
  queryKeys,
  type FirstRunStep,
  type Live,
} from "@hercule/client-core";
import type { SavedController } from "../../app/context";
import { useLiveConnection } from "../../app/live";
import { firstRunQuery, setupQuery, setupTokenQuery } from "../../app/queries";
import { FirstRunFrame } from "../../screens/first-run";
import { OfficeRoom, type RoomShot } from "../../screens/office";
import { AccountCard } from "./-account";
import { DoneCard } from "./-done";
import { GitHubCard } from "./-github";
import { ProjectCard } from "./-project";
import { ProvidersCard } from "./-providers";
import { useFirstRunData } from "./-reads";
import { ConnectElsewhereCard, WelcomeCard } from "./-welcome";

/**
 * What the first run shows on its card:
 *
 * - `found`: the welcome, for Hercule found on this Mac and not set up;
 * - `remote`: the remote screen, when main has no setup token for the
 *   controller, so the user pastes its setup address;
 * - `account`, then each step, then `done` (All set).
 */
type FirstRunCard = "found" | "remote" | "account" | FirstRunStep | "done";

/** The part of the room each card frames, as the book's first run moves its camera. */
const CARD_SHOTS: { readonly [Card in FirstRunCard]: RoomShot } = {
  found: "room",
  remote: "room",
  account: "room",
  providers: "your-desk",
  github: "wing",
  project: "triage",
  done: "room",
};

/**
 * Renders the first run on the saved `controller`, from the welcome to All
 * set. The room stays mounted the whole way, so its camera moves from step to
 * step instead of starting over.
 *
 * Which step shows is decided from the controller's state when the step
 * opens, and then it stays until the user moves on, even when its fact turns
 * true: a provider logged in on the providers step leaves the user there to
 * press Continue. Continue, Do this later, Skip for now and a project added
 * decide again.
 *
 * `startRequested` is true when this page follows Open the office, so the
 * welcome does not greet Hercule as found a second time.
 */
export function ControllerFirstRun({
  controller,
  startRequested,
}: {
  readonly controller: SavedController;
  readonly startRequested: boolean;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();
  const { client, url, live } = controller;
  const signedIn = useSuspenseQuery(setupQuery(client)).data.complete;
  const setupToken = useQuery({ ...setupTokenQuery(bridge), enabled: !signedIn }).data;
  const data = useFirstRunData(client, bridge, signedIn);
  const onThisMac = isLoopbackOrigin(url);
  // A controller elsewhere was chosen by the user on the remote screen, so
  // there is nothing to greet.
  const [openedOffice, setOpenedOffice] = useState(startRequested || !onThisMac);

  const facts = buildFirstRunFacts(data.reads);
  const decided = decideFirstRunStep(facts, data.putOff);
  const [pinned, setPinned] = useState<FirstRunStep | "done" | null>(null);
  if (signedIn && pinned === null) setPinned(decided);

  const putOff = useMutation({
    mutationFn: async (step: FirstRunStep) => {
      const progress = { putOff: [...new Set([...data.putOff, step])] };
      await bridge.firstRun.write(progress);
      return progress;
    },
    onSuccess: (progress) => {
      queryClient.setQueryData(firstRunQuery(bridge).queryKey, progress);
      setPinned(null);
    },
    // A rejection means main refused the message or failed: a bug, which the
    // user cannot act on, so it is logged rather than shown.
    onError: (error) => {
      console.error("Could not put the step off:", error);
    },
  });
  const decideAgain = (): void => {
    setPinned(null);
  };

  const card: FirstRunCard = signedIn
    ? (pinned ?? decided)
    : !openedOffice
      ? "found"
      : setupToken?._tag === "PasteNeeded"
        ? "remote"
        : "account";

  // The remote screen asks for a setup address before anyone can sign in, so
  // the room stays dark there, as before Hercule answers.
  const canSignInOrSetUp = card !== "remote";
  // The room compares its contents by identity to see what arrived, so they
  // are built again only when what they are built from changes.
  const contents = useMemo(
    () =>
      buildRoomContents({
        ...data.reads,
        canSignInOrSetUp,
        controllerOnThisMac: onThisMac,
        assistants: data.assistants,
        putOff: data.putOff,
      }),
    [data, onThisMac, canSignInOrSetUp],
  );

  let body: ReactNode;
  switch (card) {
    case "found":
      body = (
        <WelcomeCard
          state={{ kind: "found", address: formatControllerAddress(url) }}
          onOpenOffice={() => {
            setOpenedOffice(true);
          }}
        />
      );
      break;
    case "remote":
      body = (
        <ConnectElsewhereCard
          initialAddress={url}
          initialError={
            <>
              Hercule on {formatControllerAddress(url)} isn’t set up yet. On that machine, run{" "}
              <span className="mono">hercule setup-url</span> and paste the address it prints.
            </>
          }
          onUseThisMac={null}
        />
      );
      break;
    case "account":
      body = <AccountCard client={client} />;
      break;
    case "providers":
      body = (
        <ProvidersCard
          client={client}
          origin={url}
          localRunner={data.reads.localRunner}
          instances={data.reads.instances}
          ready={facts.providers}
          onContinue={decideAgain}
          onLater={() => {
            putOff.mutate("providers");
          }}
        />
      );
      break;
    case "github":
      body = (
        <GitHubCard
          client={client}
          onSkip={() => {
            putOff.mutate("github");
          }}
          onContinue={decideAgain}
        />
      );
      break;
    case "project":
      body = (
        <ProjectCard
          client={client}
          gitHubConnected={facts.github}
          onAdded={decideAgain}
          onConnectGitHub={() => {
            setPinned("github");
          }}
        />
      );
      break;
    case "done":
      body = <DoneCard client={client} reads={data.reads} onDoItNow={setPinned} />;
      break;
  }

  const greeting = card === "found" || card === "remote";
  return (
    <>
      {signedIn ? <LiveUpdates live={live} /> : null}
      <FirstRunFrame
        room={
          <OfficeRoom contents={contents} projects={data.reads.projects} shot={CARD_SHOTS[card]} />
        }
        rungs={greeting ? [] : buildFirstRunLadder(card, facts, data.putOff)}
        brand={greeting}
      >
        {body}
      </FirstRunFrame>
    </>
  );
}

/**
 * Runs the live connection while the signed-in first run shows, so a login,
 * a Connection or a runner made anywhere reaches the steps and the room.
 * Renders nothing.
 *
 * The controller's record has no live topic, but its `localRunnerId` is null
 * until its runner joins, which a push on the `runner` topic tells. So each
 * such push reads the controller's record again too. The subscription is
 * made before the live connection starts, so the connection's first reads
 * cover it.
 */
function LiveUpdates({ live }: { readonly live: Live }): null {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      live.subscribe("runner", () => {
        invalidateWithoutCancelling(queryClient, queryKeys.controller());
      }),
    [live, queryClient],
  );
  useLiveConnection(live, queryClient);
  return null;
}
