/**
 * PROTOTYPE (#354), throwaway. How the desktop app shows a session's
 * subagents: three variants on the real shell, drawn from fixture records.
 *
 * Open /specimens/subagents-prototype/index.html?variant=A|B|C&state=busy|idle
 * on the renderer's dev server. ← and → switch variant.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "../fixed-clock";
import { createRoot } from "react-dom/client";
import { THREAD_PAGE_RECORDS } from "../thread-fixture";
import { mountPrototypeThreadSpecimen } from "../shell-page";
import { THREAD_ID } from "./fixture";
import { attachCache, SCENARIO, Switcher, VARIANT } from "./shared";
import { VariantAThread } from "./variant-a";
import { VariantBThread } from "./variant-b";
import { VariantCThread } from "./variant-c";
import "./prototype.css";

const Variant = { A: VariantAThread, B: VariantBThread, C: VariantCThread }[VARIANT];

await mountPrototypeThreadSpecimen(
  {
    ...THREAD_PAGE_RECORDS,
    threads: THREAD_PAGE_RECORDS.threads.map((thread) =>
      thread.id === THREAD_ID ? SCENARIO.session : thread,
    ),
  },
  { session: SCENARIO.session, transcript: [...SCENARIO.mainRows], queuedInputs: [] },
  () => <Variant />,
  attachCache,
);

const bar = document.createElement("div");
document.body.append(bar);
createRoot(bar).render(<Switcher />);
