/**
 * Judges a reported harness version against this build's floor. The floor is
 * the CLI version the compiled SDK was built against: both the least a machine
 * may run and the most anyone has tested. It moves only when the dependency
 * does, which is why the verdict is computed at read time rather than stored
 * with the snapshot.
 */
import type { VersionVerdict } from "@hercule/contract";
import { CLAUDE_CODE_VERSION, CODEX_VERSION, PI_VERSION } from "@hercule/home/version";

/** The providers this build pins a version to. The rest are read but not judged. */
const FLOORS: ReadonlyMap<string, string> = new Map([
  ["claude-code", CLAUDE_CODE_VERSION],
  ["codex", CODEX_VERSION],
  ["pi", PI_VERSION],
]);

export const floorFor = (providerId: string): string | null => FLOORS.get(providerId) ?? null;

/** The leading numeric components, so 10 sorts after 9 rather than before it. */
const partsOf = (version: string): ReadonlyArray<number> | undefined => {
  const parts = version.split(".", 3).map((part) => Number.parseInt(part, 10));
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : undefined;
};

export const versionVerdict = (
  harnessVersion: string | null,
  floor: string | null,
): VersionVerdict => {
  if (harnessVersion === null || floor === null) return "unknown";
  const running = partsOf(harnessVersion);
  const least = partsOf(floor);
  // An unparseable version on either side compares to nothing, same as none
  // reported.
  if (running === undefined || least === undefined) return "unknown";
  for (const [index, part] of running.entries()) {
    const against = least[index]!;
    if (part !== against) return part < against ? "below-floor" : "above-tested-max";
  }
  return "ok";
};
