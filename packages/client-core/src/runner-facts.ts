/**
 * What a machine reported about itself, as a reader sees it.
 *
 * A runner's report is raw: byte counts, a provider list carrying the ones that
 * are absent, a boolean for Docker. Turning that into the words a page prints is
 * a reading of the domain, so it lives here with a test rather than in the
 * component that lays it out. `null` is a fact the machine has not reported;
 * saying so is the caller's wording, not this module's.
 */
import type { Runner } from "@hydra/contract";
import { formatBytes } from "./format-bytes";

/** One line each, in the order a page states them. */
export interface RunnerFactsReading {
  readonly machine: string | null;
  readonly memory: string | null;
  readonly diskFree: string | null;
  readonly toolchains: string | null;
  readonly providers: string | null;
  readonly docker: string | null;
  readonly binary: string | null;
}

export const runnerFactsReading = (runner: Runner): RunnerFactsReading => {
  const { facts, watermark } = runner;
  // A machine that answered and found no provider has said something; one that
  // has not answered has not. The two must not read alike.
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
