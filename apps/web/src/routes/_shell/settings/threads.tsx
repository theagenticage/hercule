import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  buildIdOptions,
  computeThreadDefaults,
  buildThreadModelField,
  resolveThreadRowsMode,
} from "@hercule/client-core";
import type { ThreadRows, ThreadWorkspace } from "@hercule/contract";
import { FormCard, Row, SegmentedControl, SegmentedControlItem, Select } from "@hercule/ui";
import {
  ensureProviderAccountReads,
  localRunnerQuery,
  harnessesQuery,
  modelProfilesQuery,
  profilesQuery,
  providerAccountsQuery,
  providersQuery,
  runnersQuery,
  settingsQuery,
} from "../../../app/queries";
import { AccessModeControl } from "../../../screens/access-mode-control";
import { SaveStatus } from "../../../screens/save-status";
import { useSaveSettings } from "./-form";

/**
 * The two choices for the workspace default, and the value each one stores.
 * There is no "no workspace" choice: a project without a source always runs
 * without a workspace, and a project with a source always works in one of its
 * own workspaces.
 */
const WORKSPACES: ReadonlyArray<{ readonly value: ThreadWorkspace; readonly label: string }> = [
  { value: "primary", label: "Main workspace" },
  { value: "ephemeral", label: "New workspace" },
];

export const Route = createFileRoute("/_shell/settings/threads")({
  staticData: { title: "Threads" },
  loader: async ({ context }) => {
    const [runners] = await Promise.all([
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      ensureProviderAccountReads(context.queryClient, context.client),
      context.queryClient.ensureQueryData(profilesQuery(context.client)),
    ]);
    await context.queryClient.ensureQueryData(
      localRunnerQuery(context.detectLocalRunner, runners.items),
    );
  },
  component: Threads,
});

/**
 * The Threads settings screen: the defaults a new thread starts with, and the
 * shell's one display preference. The four defaults prefill the composer, and
 * a thread never writes them back. Each control saves its own `thread.*` key
 * as soon as the user picks a value, like the sidebar-rows control below.
 */
function Threads(): JSX.Element {
  const { client, detectLocalRunner } = Route.useRouteContext();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const modelProfiles = useSuspenseQuery(modelProfilesQuery(client)).data;
  const profiles = useSuspenseQuery(profilesQuery(client)).data.items;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const localId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  const { save, saved, failure } = useSaveSettings(client);

  const rows = resolveThreadRowsMode(settings.user["ui.threadRows"]);

  // Every default below comes from `computeThreadDefaults`, the same function
  // the composer uses to prefill a new thread:
  // - a stored id of an account that no longer exists falls back to the open
  //   profile's default entry;
  // - "nothing picked" is null.
  const defaults = computeThreadDefaults(
    settings.user,
    accounts,
    runners,
    profiles,
    localId,
    modelProfiles,
  );
  const modelField = buildThreadModelField(
    { accounts, providers, harnesses, modelProfiles, runners, thisMacRunnerId: localId },
    defaults,
  );

  return (
    <div className="flex flex-col gap-4">
      <FormCard
        label="Threads · defaults"
        fine="What a new thread starts with, prefilled on the composer."
      >
        {accounts.length === 0 ? (
          <p className="text-fine text-faint">No account yet.</p>
        ) : (
          <Row label="Model" htmlFor="thread-model">
            <div className="flex flex-col gap-1">
              {modelField.dimmed !== null ? (
                <p className="py-1.5 text-fine text-faint">{modelField.dimmed}</p>
              ) : (
                <Select
                  id="thread-model"
                  value={modelField.selectedKey ?? ""}
                  onChange={(event) => {
                    const option = modelField.options.find(
                      (each) => each.key === event.target.value,
                    );
                    if (option === undefined) return;
                    // The account, the harness and the model are one entry of
                    // the profile, so they are saved together.
                    save({
                      user: {
                        "thread.providerAccountId": option.providerAccountId,
                        "thread.harnessId": option.harnessId,
                        "thread.model": option.model,
                      },
                    });
                  }}
                >
                  {modelField.selectedKey === null ? (
                    <option value="" disabled>
                      No model chosen
                    </option>
                  ) : null}
                  {modelField.groups.map((group) => {
                    const options = group.options.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.missing
                          ? `${option.label} (not offered)`
                          : option.problem === null
                            ? option.label
                            : `${option.label} (${option.problem})`}
                      </option>
                    ));
                    return group.label === null ? (
                      options
                    ) : (
                      <optgroup key={group.label} label={group.label}>
                        {options}
                      </optgroup>
                    );
                  })}
                </Select>
              )}
              <p className="text-fine text-faint">
                A project with its own model profile starts there.
              </p>
            </div>
          </Row>
        )}
        <Row label="Access mode">
          <AccessModeControl
            value={defaults.accessMode}
            onChange={(mode) => {
              save({ user: { "thread.accessMode": mode } });
            }}
          />
        </Row>
        <Row label="Profile" htmlFor="thread-profile">
          <Select
            id="thread-profile"
            value={defaults.profileId ?? ""}
            onChange={(event) => {
              save({ user: { "thread.profileId": event.target.value } });
            }}
          >
            {buildIdOptions(
              profiles.map((profile) => ({ id: profile.id, label: profile.name })),
              defaults.profileId,
            ).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Row>
        <SaveStatus saved={saved} failure={failure} />
      </FormCard>

      <FormCard
        label="Threads · workspace"
        fine="When set here, it applies to every project with a source. When unset, coding threads open in a New workspace with separate files. Use the main workspace to share existing files explicitly. A project with no source runs without a workspace."
      >
        <Row label="Workspace">
          <SegmentedControl
            aria-label="Workspace"
            compact
            // With nothing stored, no segment is selected: the fine print
            // explains what happens then, and a selected segment would show a
            // choice nobody made.
            value={settings.user["thread.workspace"] ?? ""}
            onValueChange={(next) => {
              save({ user: { "thread.workspace": next as ThreadWorkspace } });
            }}
          >
            {WORKSPACES.map((each) => (
              <SegmentedControlItem key={each.value} value={each.value}>
                {each.label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Row>
      </FormCard>

      <FormCard
        label="Threads · display"
        fine={
          rows === "plain"
            ? "Plain rows show a thread's title and its age."
            : "Meta rows add a second line with the model. The workspace is the group's own label."
        }
      >
        <Row label="Sidebar rows">
          <SegmentedControl
            aria-label="Sidebar rows"
            compact
            value={rows}
            onValueChange={(next) => {
              save({ user: { "ui.threadRows": next as ThreadRows } });
            }}
          >
            <SegmentedControlItem value="meta">meta</SegmentedControlItem>
            <SegmentedControlItem value="plain">plain</SegmentedControlItem>
          </SegmentedControl>
        </Row>
      </FormCard>
    </div>
  );
}
