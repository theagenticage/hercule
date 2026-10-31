/** Adds the command that fixes a harness the runner cannot start to the adapter's error. */
import { HarnessLoginMissing, HarnessNotInstalled, type AdapterError } from "@hercule/protocol";
import { endSentence } from "../report";

/** What the commands that set a harness up are written with. */
interface SetupTarget {
  readonly runnerId: string;
  readonly harnessId: string;
  readonly instanceId: string;
}

/**
 * Returns the error of a failed `startSession` with the fix appended to its
 * message, for the two failures a user fixes by setting the harness up on the
 * runner: `HarnessNotInstalled` gets the command that installs it, and
 * `HarnessLoginMissing` the command that logs the instance in. Any other
 * error is returned unchanged.
 *
 * The supervisor adds the fix, not the adapter, because only the supervisor
 * knows the runner's id.
 */
export const appendSetupInstructions = (error: AdapterError, target: SetupTarget): AdapterError => {
  switch (error._tag) {
    case "HarnessNotInstalled":
      return new HarnessNotInstalled({
        message: `${endSentence(error.message)} Install it with: \`hercule runner install-harness ${target.runnerId} --harness ${target.harnessId}\``,
      });
    case "HarnessLoginMissing":
      return new HarnessLoginMissing({
        message: `${endSentence(error.message)} Log in with: \`hercule provider login ${target.instanceId} --runner ${target.runnerId}\``,
      });
    default:
      return error;
  }
};
