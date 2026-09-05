import type { JSX } from "react";
import { Button, Group } from "@hydra/ui";

/** The harnesses a runner reports on the machine it runs on. */
const HARNESSES = ["Claude Code", "Codex", "pi"];

/**
 * The fleet before it has a machine in it. No runner has dialled in, so nothing
 * has probed which harnesses are installed anywhere: each one is listed with
 * that said plainly rather than guessed at.
 */
export function NoRunners(): JSX.Element {
  return (
    <>
      <Group>
        <div className="flex items-center gap-2.5 rounded-control px-2.5 py-[7px] text-row">
          <span className="min-w-0 flex-1">
            <b className="font-emph text-ink">this machine</b>
            <small className="ml-1.5 text-fine text-muted">no runner has joined yet</small>
          </span>
          <span className="text-fine text-muted">offline</span>
        </div>
        {HARNESSES.map((harness) => (
          <div
            key={harness}
            className="flex items-center gap-2.5 rounded-control py-1 pr-2.5 pl-9 text-fine text-muted"
          >
            <span className="min-w-0 flex-1">{harness}</span>
            <span className="text-faint">login state unknown</span>
            <Button disabled>Log in</Button>
          </div>
        ))}
      </Group>
      <p className="pt-2 text-fine text-faint">
        A runner probes the machine it runs on and reports what it found. Until one joins, Hydra
        knows nothing about this machine.
      </p>
    </>
  );
}
