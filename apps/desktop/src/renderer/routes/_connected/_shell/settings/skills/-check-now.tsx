import type { JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { useAgeWords } from "../../../../../app/age-clock";
import { SettingsHeaderActions } from "../../../../../screens/settings/settings-frame";

/**
 * Renders the header's Check now (spec 17 §Settings, Skills, Updates), which
 * starts an update check with `skill.check`: of skill `name`, on its page, or
 * of every skill with a GitHub source, on the list, when `name` is left out.
 * Before the button, a skill's page shows "Checked 2 hours ago" from
 * `lastCheckedAt` once a check has run. A refusal shows under the header.
 *
 * The check answers at once and runs on its own, so nothing is read again
 * when it answers: its result comes with the `skill` topic, which the
 * section's layout holds.
 */
export function CheckNow({
  name,
  lastCheckedAt = null,
}: {
  readonly name?: string;
  readonly lastCheckedAt?: string | null;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const check = useMutation({
    mutationFn: () => client.skill.check({ payload: name === undefined ? {} : { name } }),
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
