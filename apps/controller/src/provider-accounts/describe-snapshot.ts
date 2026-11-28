import type { CapabilitySnapshot } from "@hercule/contract";
import { computeHarnessVersionVerdict } from "../harnesses";
import type { StoredSnapshot } from "./repository";

/**
 * Returns the public form of a stored snapshot: the same facts, plus the
 * verdict on the harness version, which is worked out against the version
 * limits of this build when the snapshot is read and is never stored.
 */
export const describeSnapshot = (snapshot: StoredSnapshot): CapabilitySnapshot => ({
  runnerId: snapshot.runnerId,
  harnessId: snapshot.harnessId,
  probedAt: snapshot.probedAt,
  harnessVersion: snapshot.harnessVersion,
  versionVerdict: computeHarnessVersionVerdict(snapshot.harnessId, snapshot.harnessVersion),
  auth: snapshot.auth,
  models: snapshot.models,
});
