import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, FormCard } from "@hercule/ui";

export const Route = createFileRoute("/_shell/settings/system")({
  staticData: { title: "System" },
  component: System,
});

/**
 * Renders the System screen: the controller's operational settings, none of
 * them editable yet, below one policy that never will be. The access-mode
 * fallback policy is a property of the system, not a setting: a thread only
 * ever falls back to a less permissive mode, so there is nothing to choose. The
 * screen describes the policy and offers no way to change it. Spec 06 §8.4 and
 * spec 13 §7 own the policy.
 */
function System(): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <FormCard
        label="Access-mode fallback"
        fine="It is fixed: nothing on this screen or anywhere else changes it."
      >
        <p className="text-row text-muted">
          The four access modes run from least to most permissive:
        </p>
        {/* On its own line and never wrapped: a break between a mode and its
            `<` would make the order read differently. */}
        <span className="block overflow-x-auto font-mono text-row whitespace-nowrap text-ink">
          approval-required &lt; auto-accept-edits &lt; auto &lt; full-access
        </span>
        <p className="text-row text-muted">
          A thread asking for a mode its provider does not support runs at the nearest less
          permissive mode that provider does support. The substitution never goes the other way: a
          thread never runs more permissively than it asked for.
        </p>
      </FormCard>
      <EmptyState
        headline="The controller's settings are not editable yet."
        lead="Retention windows, the daily backup and HTTPS are set on this screen."
      />
    </div>
  );
}
