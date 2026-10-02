import type { JSX } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { buildEntryDeps, resolveFirstRunEntry } from "../app/entry-guard";

export const Route = createFileRoute("/first-run")({
  beforeLoad: async ({ context: { bridge, controller, queryClient } }) => {
    const elsewhere = await resolveFirstRunEntry(
      controller === null ? null : buildEntryDeps(controller.client, bridge, queryClient),
    );
    // The router redirects when a `redirect` is thrown. The thrown value is a
    // plain descriptor rather than an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (elsewhere !== null) throw redirect({ ...elsewhere, replace: true });
  },
  staticData: { title: "Welcome" },
  component: FirstRun,
});

function FirstRun(): JSX.Element {
  return <div />;
}
