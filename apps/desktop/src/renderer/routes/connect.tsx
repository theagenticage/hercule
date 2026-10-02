import { useState, type JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { isMutationRunning } from "@hercule/client-core";
import type { ControllerUrlSaveOutcome } from "../../ipc/contract";
import type { ConnectProblem } from "../app/entry-guard";
import { CenteredScreen } from "../screens/centered-screen";

/** The address the field shows before any controller is saved: a controller on this Mac. */
const LOCAL_CONTROLLER_URL = "http://127.0.0.1:4937";

/** Names the save in the query client's mutation cache, where the submit handler looks for it. */
const CONTROLLER_URL_SAVE_KEY = ["controllerUrl.save"];

export const Route = createFileRoute("/connect")({
  validateSearch: (search: Record<string, unknown>): { readonly problem?: ConnectProblem } =>
    search.problem === "unreachable" || search.problem === "setupIncomplete"
      ? { problem: search.problem }
      : {},
  // The app can start on this route, so it is not split into a chunk of its
  // own: a split route costs two more requests (its script and its
  // stylesheet) before the first render.
  codeSplitGroupings: [],
  staticData: { title: "Connect" },
  component: Connect,
});

/**
 * Returns the line that explains why the entry guard sent the user back here
 * from the saved controller at `url`.
 */
const describeProblem = (problem: ConnectProblem, url: string): string =>
  problem === "unreachable"
    ? `Could not reach ${url}. Check that the controller is running.`
    : // The first run sets the controller up. Until it is built, nothing in the
      // app can, so this line only says so.
      "This controller is not set up yet.";

/**
 * Returns the line that explains the outcome of connecting, or `null` for
 * `Saved`, after which main reloads the window. A line names the origin main
 * checked, not the text the user typed, which may differ in spaces, capitals,
 * a trailing `/` or a default port.
 */
const describeOutcome = (outcome: ControllerUrlSaveOutcome): string | null => {
  switch (outcome._tag) {
    case "Saved":
      return null;
    case "InvalidUrl":
      return `Enter the controller's address, such as ${LOCAL_CONTROLLER_URL}.`;
    case "Unreachable":
      return `Could not reach ${outcome.origin}. Check that the controller is running.`;
    case "Redirected":
      return `${outcome.origin} redirects to ${outcome.targetOrigin}. Connect to that address instead.`;
    case "NotController":
      return `${outcome.origin} answered, but it is not a Hercule controller.`;
    case "OriginNotAllowed":
      return `${outcome.origin} does not accept the desktop app yet. Update the controller.`;
    case "PreflightRefused": {
      const methods = new Intl.ListFormat("en", { type: "conjunction" }).format(outcome.methods);
      return `${outcome.origin} does not accept the desktop app's ${methods} requests. Update the controller, or check any proxy in front of it.`;
    }
  }
};

function Connect(): JSX.Element {
  const { bridge, controller, queryClient } = Route.useRouteContext();
  const { problem } = Route.useSearch();
  const [address, setAddress] = useState(controller?.url ?? LOCAL_CONTROLLER_URL);

  const save = useMutation({
    mutationKey: CONTROLLER_URL_SAVE_KEY,
    mutationFn: (url: string) => bridge.controllerUrl.save(url),
    // A rejection means main refused the message or failed: a bug, which the
    // user cannot act on, so it is logged rather than shown.
    onError: (error) => {
      console.error("Could not save the controller URL:", error);
    },
  });

  let line: string | null = null;
  if (save.isSuccess) line = describeOutcome(save.data);
  else if (save.isIdle && problem !== undefined && controller !== null) {
    line = describeProblem(problem, controller.url);
  }

  return (
    <CenteredScreen>
      <form
        className="centered-form"
        onSubmit={(event) => {
          event.preventDefault();
          // Connect stays enabled while main checks the controller, so that
          // it keeps focus, and a second press must do nothing.
          if (isMutationRunning(queryClient, CONTROLLER_URL_SAVE_KEY)) return;
          save.mutate(address);
        }}
      >
        <input
          className="field"
          type="text"
          aria-label="Controller address"
          placeholder="Controller address"
          spellCheck={false}
          autoCapitalize="off"
          autoFocus
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
          }}
        />
        {line === null ? null : (
          <p className="centered-error" role="alert">
            {line}
          </p>
        )}
        <button
          type="submit"
          className="btn btn--accent"
          aria-disabled={save.isPending || undefined}
        >
          {save.isPending ? "Connecting…" : "Connect"}
        </button>
      </form>
    </CenteredScreen>
  );
}
