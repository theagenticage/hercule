/**
 * Formats the facts a runner reported about its machine for display.
 *
 * A runner's report is raw: byte counts, a provider list that includes the
 * providers that are missing, a boolean for Docker. Turning it into text lives
 * here with a test rather than in the component that lays it out. `null`
 * means the runner has not reported that fact; the caller decides how to
 * show that.
 */
import type { Runner } from "@hercule/contract";
import { formatBytes } from "./format-bytes";

/** One line per fact, in the order a page shows them. */
export interface RunnerFactsReading {
  readonly machine: string | null;
  readonly memory: string | null;
  readonly diskFree: string | null;
  readonly toolchains: string | null;
  readonly providers: string | null;
  readonly docker: string | null;
  readonly binary: string | null;
}

export const describeRunnerFacts = (runner: Runner): RunnerFactsReading => {
  const { facts, watermark } = runner;
  // A runner that reported no installed provider is different from one that
  // has not reported yet, so the two must be shown differently.
  const installed = facts?.providers.filter((provider) => provider.present) ?? [];

  return {
    machine: facts === null ? null : `${facts.os} · ${facts.arch}`,
    memory: facts === null ? null : formatBytes(facts.totalMemoryBytes),
    diskFree: watermark === null ? null : formatBytes(watermark.diskFreeBytes),
    toolchains:
      facts === null || facts.toolchains.length === 0
        ? null
        : facts.toolchains.map((tool) => `${tool.name} ${tool.version}`).join(" · "),
    providers:
      facts === null
        ? null
        : installed.length === 0
          ? "none installed"
          : installed.map((provider) => provider.name).join(" · "),
    docker: facts === null ? null : facts.docker ? "installed" : "not installed",
    binary: runner.version,
  };
};
