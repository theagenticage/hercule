/**
 * PROTOTYPE - throwaway. Three variants of the Fleet screen, switchable with
 * `?variant=` and the floating bar at the bottom.
 *
 * Three variants of a Fleet screen in the main pane, on the Hercule face,
 * where the sidebar's Fleet row is:
 *
 * - A, Board: every machine in one table, the open one in a pane beside it.
 * - B, Rooms: a tile per machine; a tile opens the machine's own page.
 * - C, By concern: capacity, storage and software, each across every machine.
 *
 * Round 2 combines B's cards and machine pages with C's concerns, and adds
 * room for more, trends, the software baseline and activity (fleet-blocks.tsx):
 *
 * - D, Cards, then concerns: the cards on top, the three concerns below.
 * - E, Lenses: only the cards; a lens changes what every card shows.
 * - F, Scope and concern: a rail of small cards picks the scope, tabs pick
 *   the concern.
 *
 * Round 3:
 *
 * - G, Grid or list: the machines as cards or rows, with a toggle, and the
 *   software matrix under them. A machine's details are on its own page.
 */
import { useEffect, useState, type JSX } from "react";
import { ChevronLeftIcon } from "../../icons/chevron-left";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { VariantA } from "./variant-a";
import { VariantB } from "./variant-b";
import { VariantC } from "./variant-c";
import { VariantD } from "./variant-d";
import { VariantE } from "./variant-e";
import { VariantF } from "./variant-f";
import { VariantG } from "./variant-g";
import { FleetToast } from "./fleet-atoms";
import "./fleet-prototype.css";

const VARIANTS = [
  { key: "A", name: "Board", Component: VariantA },
  { key: "B", name: "Rooms", Component: VariantB },
  { key: "C", name: "By concern", Component: VariantC },
  { key: "D", name: "Cards, then concerns", Component: VariantD },
  { key: "E", name: "Lenses", Component: VariantE },
  { key: "F", name: "Scope and concern", Component: VariantF },
  { key: "G", name: "Grid or list", Component: VariantG },
] as const;

const THEMES = ["whitehaven", "styles", "orient-express", "nile", "end-house"] as const;

const readParam = (name: string): string | null => new URLSearchParams(location.search).get(name);

const writeParam = (name: string, value: string): void => {
  const search = new URLSearchParams(location.search);
  search.set(name, value);
  history.replaceState(null, "", `${location.pathname}?${search.toString()}`);
};

export function FleetPrototypeScreen(): JSX.Element {
  const [variant, setVariant] = useState(() => {
    const index = VARIANTS.findIndex((each) => each.key === readParam("variant")?.toUpperCase());
    // Round 3 opens on G.
    return index === -1 ? 6 : index;
  });
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "whitehaven");
  const [audit, setAudit] = useState(() => readParam("audit") === "1");

  // The data check marks what the controller cannot show today.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-audit", audit);
  }, [audit]);

  const go = (step: number) => {
    const next = (variant + step + VARIANTS.length) % VARIANTS.length;
    setVariant(next);
    writeParam("variant", VARIANTS[next]!.key);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]") != null) return;
      if (document.querySelector("dialog[open]") !== null) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") go(-1);
      if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const { Component, key, name } = VARIANTS[variant]!;
  return (
    <>
      <Component key={key} />
      <FleetToast />
      {import.meta.env.DEV && audit && <DataKey />}
      {import.meta.env.DEV && (
        <div className="fp-switcher" role="toolbar" aria-label="Prototype variants">
          <button type="button" onClick={() => go(-1)} aria-label="Previous variant">
            <ChevronLeftIcon size={14} />
          </button>
          <span className="fp-switcher-label">
            <b>{key}</b> {name}
          </span>
          <button type="button" onClick={() => go(1)} aria-label="Next variant">
            <ChevronRightIcon size={14} />
          </button>
          <i className="fp-switcher-rule" />
          <button
            type="button"
            className="fp-switcher-audit"
            aria-pressed={audit}
            onClick={() => {
              setAudit(!audit);
              writeParam("audit", audit ? "0" : "1");
            }}
          >
            Data check
          </button>
          <select
            value={theme}
            aria-label="Theme"
            onChange={(event) => {
              const next = event.target.value;
              document.documentElement.dataset.theme = next;
              setTheme(next);
              writeParam("theme", next);
            }}
          >
            {THEMES.map((each) => (
              <option key={each} value={each}>
                {each}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

/** What each mark of the data check means, and what showing it would take. */
const NEEDS: ReadonlyArray<readonly [string, string]> = [
  [
    "disk total",
    "The runner reads the disk's size, but sends only its free space. One more field.",
  ],
  [
    "history",
    "The controller keeps only the latest reading. Graphs and forecasts need it to store a reading every few minutes, for 14 days.",
  ],
  [
    "workspace sizes",
    "Nothing measures a workspace's size. The runner would have to walk its workspaces now and then, which costs disk reads.",
  ],
  ["workspace changes", "Uncommitted files are only found when a removal is refused."],
  ["CPU", "Not read today. One more field, the load average."],
  ["new probe", "The runner probes git and gh. Each other tool needs adding to the probe."],
  ["API: filter the log by machine", "The log can be read one kind at a time, not by machine."],
];

function DataKey(): JSX.Element {
  const [shown, setShown] = useState(true);
  if (!shown) {
    return (
      <button type="button" className="fp-datakey-show" onClick={() => setShown(true)}>
        What the marks mean
      </button>
    );
  }
  return (
    <aside className="fp-datakey" aria-label="Data check">
      <button type="button" className="fp-datakey-hide" onClick={() => setShown(false)}>
        Hide
      </button>
      <b>Data check</b>
      <p>
        Marked parts need data the controller does not have today. Everything else can be shown now.
      </p>
      <dl>
        {NEEDS.map(([key, text]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
