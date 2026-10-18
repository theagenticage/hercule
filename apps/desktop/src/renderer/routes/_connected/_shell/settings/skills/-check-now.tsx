import type { JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { useAgeWords } from "../../../../../app/age-clock";
import { readSkillsAgain } from "../../../../../app/queries";
import { SettingsHeaderActions } from "../../../../../screens/settings/settings-frame";

/**
 * Renders the header's update check on the page of skill `name`, whose
 * source is on GitHub (spec 17 §Settings, Skills, Updates): "Checked 2 hours
 * ago" from `lastCheckedAt` once a check has run, then Check now, which
 * starts a check of this skill. A refusal shows under the header.
 *
 * The check answers at once and runs on its own. Its result comes with the
 * `skill` topic, which the section's layout holds.
 */
export function CheckNow({
  name,
  lastCheckedAt,
}: {
  readonly name: string;
  readonly lastCheckedAt: string | null;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const check = useMutation({
    mutationFn: () => client.skill.check({ payload: { name } }),
    onSettled: () => readSkillsAgain(queryClient),
  });
  return (
    <>
      <SettingsHeaderActions>
        {lastCheckedAt !== null && <CheckedAge at={lastCheckedAt} />}
        <button
          type="button"
          className="btn btn--sm"
          aria-disabled={check.isPending}
          onClick={() => {
            if (!check.isPending) check.mutate();
          }}
        >
          Check now
        </button>
      </SettingsHeaderActions>
      {check.error !== null && (
        <p className="set-err" role="alert">
          {`Could not check for updates: ${readErrorMessage(check.error)}`}
        </p>
      )}
    </>
  );
}

/** Renders "Checked 2 hours ago" for a check that ended at `at`, kept current by the age clock. */
function CheckedAge({ at }: { readonly at: string }): JSX.Element {
  return <span className="time">{`Checked ${useAgeWords(at, true)}`}</span>;
}
