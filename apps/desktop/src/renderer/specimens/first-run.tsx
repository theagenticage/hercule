/**
 * The first-run specimen: the app's real first run, booted as main.tsx boots
 * it, in one state of first-run-states.ts, to compare with the Bureau book's
 * desktop/first-run.html in variant B. `node scripts/capture-first-run.ts`
 * captures every state beside the book's, in both themes.
 *
 * The page takes the state from `?step=` and `?state=`, such as
 * `?step=github&state=code`, and its theme from `?theme=whitehaven` or
 * `?theme=orient-express`.
 *
 * Main and the controller are played by the state's scene in
 * first-run-fixture.ts: a scripted bridge, and a `fetch` that answers from the
 * scene's records. The scene's clicks then bring the first run to the state.
 *
 * Once the page shows the state, every animation is stopped, as the book's
 * page is stopped for its capture (see `stillBookPage`), so a spinner or the
 * room's camera is captured at rest in both.
 */
import "../styles/base-layer.css";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { buildRouterContext } from "../app/context";
import { createAppRouter } from "../app/router";
import { FIRST_RUN_SCENES } from "./first-run-fixture";
import { FIRST_RUN_STATES, type FirstRunStateName } from "./first-run-states";
import { applySheetTheme, markSheetReady } from "./sheet-page";

/** Returns the state the page's `?step=` and `?state=` name. Fails when they name none. */
function readStateName(): FirstRunStateName {
  const search = new URLSearchParams(location.search);
  const name = `${search.get("step") ?? ""}-${search.get("state") ?? ""}`;
  const known = FIRST_RUN_STATES.find((entry) => `${entry.step}-${entry.state}` === name);
  if (known === undefined) {
    throw new Error(
      `Unknown state "${name}" in the URL. Use one of: ${FIRST_RUN_STATES.map((entry) => `?step=${entry.step}&state=${entry.state}`).join(", ")}.`,
    );
  }
  return name as FirstRunStateName;
}

/** Resolves after the browser has drawn two more frames, so the page has caught up with the last click. */
const waitTwoFrames = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

const scene = FIRST_RUN_SCENES[readStateName()]();
applySheetTheme();
// The app's client sends its requests through the global `fetch`, always
// with the URL as a string.
globalThis.fetch = (input, init) => scene.fetch(input as string, init);
const router = createAppRouter(await buildRouterContext(scene.bridge));
router.history.replace("/first-run");
await router.load();
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
await scene.drive?.();
await waitTwoFrames();
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
await document.fonts.ready;
await markSheetReady();
