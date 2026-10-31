import type { HarnessHome } from "@hercule/protocol";
import type { StoredProviderAccount } from "./repository";

/**
 * Returns the Harness Home an account uses for one harness: a path relative to
 * the runner's storage directory, which the runner joins to it and never
 * works out itself (spec 06 section 9.1).
 *
 * - An account made by the upgrade from the previous version (which had
 *   one folder per harness login) keeps that folder,
 *   `providers/<legacyHomeFolder>`, for the harness that login belonged to.
 *   Moving the folder would break Codex's resume and Claude Code's login.
 * - Every other pair of account and harness gets
 *   `providers/homes/<providerAccountId>/<harnessId>`, where the qualified
 *   harness id supplies the two last folder levels.
 *
 * This is the only function that reads the two `legacyHome` fields of an
 * account. Every frame that runs a harness for an account gets its folder
 * here, so no two paths can disagree about where an account's login lives.
 */
export const resolveHarnessHome = (
  account: Pick<StoredProviderAccount, "id" | "legacyHomeFolder" | "legacyHomeHarnessId">,
  harnessId: string,
): HarnessHome =>
  account.legacyHomeFolder !== null && account.legacyHomeHarnessId === harnessId
    ? `providers/${account.legacyHomeFolder}`
    : `providers/homes/${account.id}/${harnessId}`;
