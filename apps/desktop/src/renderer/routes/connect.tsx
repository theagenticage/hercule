import { useState, type JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { isMutationRunning } from "@hercule/client-core";
import type { ConnectProblem } from "../app/entry-guard";
import { CenteredScreen } from "../screens/centered-screen";
import {
  describeControllerUrlOutcome,
  LOCAL_CONTROLLER_URL,
} from "../screens/controller-url-outcome";

/** Names the save in the query client's mutation cache, where the submit handler looks for it. */
const CONTROLLER_URL_SAVE_KEY = ["controllerUrl.save"];

export const Route = createFileRoute("/connect")({
  validateSearch: (search: Record<string, unknown>): { readonly problem?: ConnectProblem } =>
    search.problem === "unreachable" ? { problem: search.problem } : {},
  // The app can start on this route, so it is not split into a chunk of its
  // own: a split route costs two more requests (its script and its
  // stylesheet) before the first render.
  codeSplitGroupings: [],
  staticData: { title: "Connect" },
  component: Connect,
});

/**
 * Returns the line that explains why the entry guard sent the user back here
 * from the saved controller at `url`. The guard has one reason: the
 * controller could not be read.
 */
const describeProblem = (url: string): string =>
  `Could not reach ${url}. Check that the controller is running.`;

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
  if (save.isSuccess) line = describeControllerUrlOutcome(save.data);
  else if (save.isIdle && problem !== undefined && controller !== null) {
    line = describeProblem(controller.url);
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
