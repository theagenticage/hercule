// The design tokens, the page base and the controls. Every component's
// stylesheet, imported through the route tree below, overrides them; the
// stylesheet explains how.
import "./styles/base-layer.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { buildRouterContext } from "./app/context";
import { reportFirstScreen } from "./app/presented-frame";
import { createAppRouter } from "./app/router";

const router = createAppRouter(await buildRouterContext(window.bridge));

// Once the first screen has reached the window, reports it to main, which
// shows the window then, and marks it as `first-screen` at the moment its
// frame was presented, for the start-up measurement. The router reports
// `onResolved` once React has committed a navigation, and only for the
// navigation that lands: when the entry guard redirects, it reports the
// screen the redirect settles on, never the route the app first asked for.
//
// The mark names the first screen the app settles on. The "connecting"
// screen, shown while a slow controller keeps the guard waiting, reports
// itself too, so the window shows on it; but it sets no mark, so with a slow
// controller the mark comes later than the show.
const unsubscribe = router.subscribe("onResolved", () => {
  unsubscribe();
  void reportFirstScreen(window.bridge).then((presentedAt) => {
    if (presentedAt !== null) performance.mark("first-screen", { startTime: presentedAt });
  });
});

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html is missing #root");
}

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
