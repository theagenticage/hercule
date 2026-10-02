/**
 * Reads the answer to a login code the user pasted back, in a provider login
 * where the vendor's page shows the code and the user pastes it into Hercule.
 */
import { readValidationIssues } from "./errors";

/**
 * Returns true when `error` says the vendor did not accept the pasted code.
 * The controller answers such a code with a `validation` error whose issue
 * points at the `code` field. Any other error, such as a runner that cannot
 * be reached, returns false: the code itself may be fine.
 */
export const isLoginCodeRejected = (error: unknown): boolean =>
  (readValidationIssues(error) ?? []).some(
    (issue) => issue.path.length === 1 && issue.path[0] === "code",
  );
