import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createClient,
  createLive,
  createTokenStore,
  detectLocalRunner,
} from "@hercule/client-core";
import { createAppRouter } from "./app/router";
import { followLiveStatus } from "./app/live-status";
import "./styles.css";

// The controller serves the app at its own origin, so that origin is the API's
// too, and it is also what the stored token is keyed by.
const baseUrl = window.location.origin;

const client = createClient({ baseUrl, tokenStore: createTokenStore(baseUrl) });
const live = createLive({ client, baseUrl });
const queryClient = new QueryClient();
const router = createAppRouter(
  {
    client,
    queryClient,
    live,
    detectLocalRunner: (runners) =>
      detectLocalRunner(runners, (url, init) => globalThis.fetch(url, init)),
  },
  createBrowserHistory(),
);
followLiveStatus(live, router);

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html is missing #root");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
