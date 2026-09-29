// The design tokens and the page base come first, so that every component's
// stylesheet, imported through the route tree below, follows them in the
// cascade.
import "./styles/tokens.css";
import "./styles/base.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createAppRouter } from "./app/router";

const router = createAppRouter();

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html is missing #root");
}

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
