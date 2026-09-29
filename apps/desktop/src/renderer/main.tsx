// The design tokens, the page base and the controls come first, so that every
// component's stylesheet, imported through the route tree below, follows them
// in the cascade.
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/controls.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { buildRouterContext } from "./app/context";
import { createAppRouter } from "./app/router";

const router = createAppRouter(await buildRouterContext(window.bridge));

// Marks the moment the first screen is drawn, so the start-up measurement can
// read it with `performance.getEntriesByName("first-screen")`. The router
// reports `onResolved` once React has committed a navigation, and only for
// the navigation that lands: when the entry guard redirects, it reports the
// screen the redirect settles on, never the route the app first asked for.
// The mark is set in the next animation frame, the one that draws that screen.
const unsubscribe = router.subscribe("onResolved", () => {
  unsubscribe();
  requestAnimationFrame(() => performance.mark("first-screen"));
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
