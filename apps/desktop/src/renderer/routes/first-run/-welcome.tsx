import { useState, type JSX, type ReactNode } from "react";
import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, type RoomContents } from "@hercule/client-core";
import type {
  ControllerUrlSaveOutcome,
  LocalControllerFindOutcome,
  LocalControllerStartOutcome,
} from "../../../ipc/contract";
import { localControllerQuery } from "../../app/queries";
import { describeControllerUrlOutcome } from "../../screens/controller-url-outcome";
import {
  ConnectElsewhere,
  FirstRunFrame,
  Welcome,
  type WelcomeState,
} from "../../screens/first-run";
import { OfficeRoom } from "../../screens/office";
import { clearStartRequested, markStartRequested } from "./-start-flag";

/** The room before Hercule answers: empty, with its lights off. */
const DARK_ROOM: RoomContents = {
  lightsOn: false,
  wing: null,
  yourDesk: false,
  assistant: null,
  triage: null,
  gitHubAccount: null,
};

/**
 * Renders the first run while no controller is saved: the welcome over the
 * dark room. The welcome looks for Hercule on this Mac once, and Open the
 * office starts it.
 *
 * Both end in a reload when Hercule answers, because main saves the
 * controller's URL then. Until the reload, the welcome keeps showing that it
 * is looking, or starting.
 */
export function NoControllerFirstRun(): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const found = useQuery(localControllerQuery(bridge));
  const start = useMutation({
    mutationFn: () => {
      // The reload that follows a start that worked loses this page, so the
      // next page learns of the start from the mark.
      markStartRequested();
      return bridge.localController.start();
    },
    onSettled: (outcome) => {
      if (outcome?._tag !== "Saved") clearStartRequested();
    },
  });

  const state = decideStartState(start) ?? decideFindState(found);

  return (
    <FirstRunFrame
      room={<OfficeRoom contents={DARK_ROOM} projects={[]} shot="room" />}
      rungs={[]}
      brand
    >
      <WelcomeCard
        state={state}
        onOpenOffice={() => {
          // Main refuses a second start while the first runs, and its error
          // would hide the first start's outcome. A start that worked also
          // shows as starting until the reload, with no request pending.
          if (state.kind !== "starting") start.mutate();
        }}
      />
    </FirstRunFrame>
  );
}

/**
 * Decides the welcome's state from the look for Hercule on this Mac. Hercule
 * found shows as searching until the reload.
 */
const decideFindState = (find: UseQueryResult<LocalControllerFindOutcome>): WelcomeState => {
  // A rejection means main failed. The welcome treats it as finding nothing,
  // so Open the office can still start Hercule and say what goes wrong.
  if (find.isError) return { kind: "fresh" };
  switch (find.data?._tag) {
    case undefined:
    case "Saved":
      return { kind: "searching" };
    case "Runner":
      return { kind: "runner", running: find.data.running };
    case "NotFound":
      return { kind: "fresh" };
  }
};

/**
 * Decides the welcome's state from the start of Hercule, or returns null
 * before the user pressed Open the office. A start that worked shows as
 * starting until the reload.
 */
const decideStartState = (
  start: UseMutationResult<LocalControllerStartOutcome, Error, void>,
): WelcomeState | null => {
  if (start.isIdle) return null;
  if (start.isPending) return { kind: "starting" };
  // A rejection means main refused the message or failed: a bug, but the
  // user can still try again, so its message shows as the start's error.
  if (start.isError) return { kind: "start-error", line: readErrorMessage(start.error) };
  const outcome = start.data;
  switch (outcome._tag) {
    case "Saved":
      return { kind: "starting" };
    case "Runner":
      return { kind: "runner", running: outcome.running };
    case "NotInstalled":
      return { kind: "not-installed" };
    case "StartFailed":
      return { kind: "start-error", line: outcome.line };
    case "NoAnswer":
      return { kind: "no-answer", address: outcome.origin, logsDir: outcome.logsFolder };
    // Something answered at Hercule's address but the connect check refused
    // it, so the line is the one the connect screen shows for the same check.
    case "Redirected":
    case "NotController":
    case "OriginNotAllowed":
    case "PreflightRefused":
      return { kind: "start-error", line: describeControllerUrlOutcome(outcome) ?? "" };
  }
};

/**
 * Renders the welcome in `state`, or, once the user chooses a way to Hercule
 * on another machine, the remote screen. `onOpenOffice` runs on Open the
 * office and on Try again. On a Mac that is another machine's runner, the
 * remote screen offers no way back to this Mac.
 */
export function WelcomeCard({
  state,
  onOpenOffice,
}: {
  readonly state: WelcomeState;
  readonly onOpenOffice: () => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const [elsewhere, setElsewhere] = useState(false);
  if (elsewhere) {
    return (
      <ConnectElsewhereCard
        initialAddress=""
        initialError={null}
        onUseThisMac={
          state.kind === "runner"
            ? null
            : () => {
                setElsewhere(false);
              }
        }
      />
    );
  }
  return (
    <Welcome
      state={state}
      onOpenOffice={onOpenOffice}
      onShowLogs={() => {
        bridge.logsFolder.show().catch((error: unknown) => {
          console.error("Could not show Hercule's logs folder:", error);
        });
      }}
      onConnectElsewhere={() => {
        setElsewhere(true);
      }}
    />
  );
}

/**
 * Renders the remote screen, which saves the address the user types with
 * main's connect check. A check that passes reloads the window; any other
 * outcome shows its line under the field. `initialError` shows until the
 * first Continue.
 */
export function ConnectElsewhereCard({
  initialAddress,
  initialError,
  onUseThisMac,
}: {
  readonly initialAddress: string;
  readonly initialError: ReactNode;
  readonly onUseThisMac: (() => void) | null;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const [address, setAddress] = useState(initialAddress);
  const save = useMutation<ControllerUrlSaveOutcome, Error, string>({
    mutationFn: (url) => bridge.controllerUrl.save(url),
    // A rejection means main refused the message or failed: a bug, which the
    // user cannot act on, so it is logged rather than shown.
    onError: (error) => {
      console.error("Could not save the controller URL:", error);
    },
  });
  return (
    <ConnectElsewhere
      address={address}
      onAddressChange={setAddress}
      error={save.isSuccess ? describeControllerUrlOutcome(save.data) : initialError}
      // A saved address reloads the window, so Continue stays busy until then.
      saving={save.isPending || save.data?._tag === "Saved"}
      onSubmit={() => {
        save.mutate(address);
      }}
      onUseThisMac={onUseThisMac}
    />
  );
}
