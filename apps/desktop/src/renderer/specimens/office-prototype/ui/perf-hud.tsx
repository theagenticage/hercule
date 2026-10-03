/**
 * PROTOTYPE - the performance readout: what drawing the office costs, from
 * the stage's own counters, refreshed twice a second while it shows.
 */
import { useEffect, useState, type JSX } from "react";
import type { StageStats } from "../engine/stage";
import type { OfficeScene } from "../office-scene";

/** Milliseconds between two reads of the stage's counters. */
const REFRESH_INTERVAL = 500;

/** Returns `count` shortened for the readout: 272661 becomes "273k". */
const formatCount = (count: number): string =>
  count >= 10_000 ? `${String(Math.round(count / 1000))}k` : String(count);

/** Renders the readout. Mount it only while it shows: it reads the stage on a timer. */
export function PerfHud({ scene }: { readonly scene: OfficeScene }): JSX.Element {
  const [stats, setStats] = useState<StageStats>(() => scene.stage.readStats());
  useEffect(() => {
    const timer = setInterval(() => setStats(scene.stage.readStats()), REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [scene]);
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["fps", String(stats.fps)],
    ["cpu", `${stats.cpuMs.toFixed(1)} ms`],
    ["calls", String(stats.drawCalls)],
    ["tris", formatCount(stats.triangles)],
    ["geo", String(stats.geometries)],
    ["tex", String(stats.textures)],
    ["buffer", stats.bufferSize],
    ["quality", stats.quality],
  ];
  return (
    <dl className="office-perf glass" aria-label="Performance">
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
