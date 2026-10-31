import type { CapabilitySnapshot } from "@hercule/contract";
import { computeVersionVerdict, findVersionFloor } from "../harnesses";
import type { StoredSnapshot } from "./repository";

/**
 * Returns the public form of a stored snapshot: the same facts, plus the
 * verdict on the harness version, which is worked out against the version
 * floors of this build when the snapshot is read and is never stored.
 */
export const describeSnapshot = (snapshot: StoredSnapshot): CapabilitySnapshot => ({
  runnerId: snapshot.runnerId,
  harnessId: snapshot.harnessId,
  probedAt: snapshot.probedAt,
  harnessVersion: snapshot.harnessVersion,
  versionVerdict: computeVersionVerdict(
    snapshot.harnessVersion,
    findVersionFloor(snapshot.harnessId),
  ),
  auth: snapshot.auth,
  models: snapshot.models,
});
