/**
 * PROTOTYPE, throwaway. Round four of the Inbox for many sources, by session
 * 501370b2: three views on one world, and one way to start work in all of
 * them.
 *
 * - Inbox (`?variant=inbox`): a real inbox, built to find things fast.
 * - Work (`?variant=work`): Tasks and everything not picked up yet, on one
 *   time axis, by whose move it is.
 * - Dashboard (`?variant=dashboard`): blocks tuned for glancing, with filters
 *   that know each source's fields.
 *
 * Cards and filters stay source-agnostic: plugins fill a card's slots
 * (faces.ts) and declare their fields (fields.ts). Workflows are offered
 * wherever their input fits (work.ts, start.tsx). `?load=light|heavy|extreme`
 * picks the size of the world. Start it with
 * `pnpm --filter @hercule/desktop prototype:inbox-views`.
 *
 * The page mounts the Inbox specimen for the shell and the sidebar, hides the
 * real Inbox, and draws the view in its place. Nothing is read from or
 * written to a controller.
 */
import "../fixed-clock";
import { useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { INBOX, INBOX_SIDEBAR_RECORDS } from "../inbox-fixture";
import { mountInboxSpecimen } from "../shell-page";
import { Switcher, type VariantEntry } from "./parts";
import "./prototype.css";
import { resetInbox } from "./inbox-store";
import { ThreadDialog } from "./thread-dialog";
import { CommandPalette, resetWork, SelectionBar, setSelection, Toasts } from "./start";
import { ViewDashboard } from "./view-dashboard";
import { ViewInbox } from "./view-inbox";
import { ViewWork } from "./view-work";
import { buildWorld, type Load, type World } from "./world";

const VARIANTS: readonly (VariantEntry & { readonly draw: (world: World) => JSX.Element })[] = [
  {
    key: "A",
    id: "inbox",
    name: "Inbox",
    idea: "Find things fast: splits, search by any field, keys",
    draw: (w) => <ViewInbox world={w} />,
  },
  {
    key: "B",
    id: "work",
    name: "Work",
    idea: "Tasks and everything not picked up, by whose move",
    draw: (w) => <ViewWork world={w} />,
  },
  {
    key: "C",
    id: "dashboard",
    name: "Dashboard",
    idea: "Blocks for glancing, filters that know each source",
    draw: (w) => <ViewDashboard world={w} />,
  },
];

const params = new URLSearchParams(location.search);
const firstLoad = (params.get("load") as Load | null) ?? "heavy";

function readVariant(): (typeof VARIANTS)[number] {
  const id = new URLSearchParams(location.search).get("variant");
  return VARIANTS.find((v) => v.id === id || v.key === id) ?? VARIANTS[0]!;
}

function writeParam(key: string, value: string): void {
  const next = new URLSearchParams(location.search);
  next.set(key, value);
  history.replaceState(null, "", `${location.pathname}?${next.toString()}`);
}

function Prototype(): JSX.Element {
  const [variant, setVariant] = useState(readVariant);
  const [load, setLoad] = useState<Load>(firstLoad);
  const [world, setWorld] = useState(() => {
    const first = buildWorld(firstLoad);
    resetWork(first);
    resetInbox(first);
    return first;
  });
  return (
    <>
      <div className="pis-host-inner" key={`${variant.id}-${load}`}>
        {variant.draw(world)}
      </div>
      {/* The switcher is not part of any design: shown in development, and in the copy shared on the tailnet. */}
      {import.meta.env.DEV || location.hostname.endsWith(".ts.net") ? (
        <Switcher
          variants={VARIANTS}
          current={variant}
          onVariant={(id) => {
            writeParam("variant", id);
            setVariant(readVariant());
            setSelection([]);
          }}
          load={load}
          onLoad={(next) => {
            writeParam("load", next);
            setLoad(next);
            const built = buildWorld(next);
            resetWork(built);
            resetInbox(built);
            setWorld(built);
          }}
          world={world}
        />
      ) : null}
      <SelectionBar />
      <Toasts />
      <CommandPalette />
      <ThreadDialog world={world} />
    </>
  );
}

// The sidebar's Inbox count follows the invented world, not the fixture.
const asking = buildWorld(firstLoad).things.filter(
  (t) => t.asksYou && !t.settled && !t.lapsed,
).length;
await mountInboxSpecimen(INBOX_SIDEBAR_RECORDS, {
  ...INBOX,
  counts: { ...INBOX.counts, onTheClock: asking },
});
const desk = document.querySelector<HTMLElement>(".inbox-desk");
if (desk === null || desk.parentElement === null)
  throw new Error("The Inbox specimen drew no .inbox-desk.");
desk.style.display = "none";
const host = document.createElement("div");
host.className = "pis-host";
desk.parentElement.appendChild(host);
createRoot(host).render(<Prototype />);
