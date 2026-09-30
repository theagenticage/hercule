import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createClient,
  createLive,
  createTokenStore,
  buildFetchIdentityProbe,
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
// Reads and writes are sent even when the browser reports no network. The
// controller often runs on this machine, where it is still reachable then, and
// by default TanStack Query would hold every request until the browser is
// back online. A controller that is really out of reach fails the request,
// and the screen shows that failure.
const queryClient = new QueryClient({
  defaultOptions: { queries: { networkMode: "always" }, mutations: { networkMode: "always" } },
});
const router = createAppRouter(
  {
    client,
    queryClient,
    live,
    detectLocalRunner: (runners) =>
      detectLocalRunner(
        runners,
        buildFetchIdentityProbe((url, init) => globalThis.fetch(url, init)),
      ),
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
