import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  filterGitHubConnections,
  computeInstanceDefaults,
  computeThreadDefaults,
  buildThreadModelField,
  resolveThreadRowsMode,
} from "@hercule/client-core";
import type { AccessMode, ThreadRows, ThreadWorkspace } from "@hercule/contract";
import { Field, FormCard, Row, SegmentedControl, SegmentedControlItem, Select } from "@hercule/ui";
import {
  connectionsQuery,
  localRunnerQuery,
  profilesQuery,
  providersQuery,
  runnersQuery,
  settingsQuery,
} from "../../../app/queries";
import { SaveStatus } from "../../../screens/save-status";
import { useSaveSettings } from "./-form";

const ACCESS_MODES: readonly AccessMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/**
 * The two faces of the workspace default, and what each one stores. None is not
 * one of them (D-20d): a project without a source always runs without a
 * workspace, and a project with one always works in one of its own.
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
      context.queryClient.ensureQueryData(providersQuery(context.client)),
      context.queryClient.ensureQueryData(profilesQuery(context.client)),
      // The GitHub accounts the select below offers. Prefetched rather than
      // ensured: a controller that cannot list them leaves one field empty,
      // not a screen the user cannot reach.
      context.queryClient.prefetchQuery(connectionsQuery(context.client)),
    ]);
    await context.queryClient.ensureQueryData(
      localRunnerQuery(context.detectLocalRunner, runners.items),
    );
  },
  component: Threads,
});

/**
 * What a new thread starts with, and the shell's one display preference. The
 * four defaults prefill the composer and are never written back from a
 * thread; each writes its own `thread.*` key the moment it is picked, the same
 * way the sidebar-rows control below them already does.
 */
function Threads(): JSX.Element {
  const { client, detectLocalRunner } = Route.useRouteContext();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const profiles = useSuspenseQuery(profilesQuery(client)).data.items;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const localId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  const githubs = filterGitHubConnections(useQuery(connectionsQuery(client)).data?.items ?? []);
  const { save, saved, failure } = useSaveSettings(client);

  const rows = resolveThreadRowsMode(settings.user["ui.threadRows"]);

  // Every default below is `computeThreadDefaults`' answer, the same rule the
  // composer prefills a new thread from: a stored id naming an instance that
  // no longer exists falls back, the model is read from the runner that
  // instance would actually be placed on, and "nothing picked" is null.
  const defaults = computeThreadDefaults(settings.user, instances, runners, profiles, localId);
  const instance = instances.find((each) => each.id === defaults.instanceId);
  const modelField =
    instance === undefined
      ? { dimmed: null, options: [] }
      : buildThreadModelField(instance, defaults.runnerId, settings.user["thread.model"]);

  return (
    <div className="flex flex-col gap-4">
      <FormCard
        label="Threads · defaults"
        fine="What a new thread starts with, prefilled on the composer."
      >
        {instances.length === 0 ? (
          <p className="text-fine text-faint">No provider instance yet.</p>
        ) : (
          <>
            <Row label="Provider instance" htmlFor="thread-instance">
              <Select
                id="thread-instance"
                value={defaults.instanceId ?? ""}
                onChange={(event) => {
                  const next = instances.find((each) => each.id === event.target.value);
                  // The model follows the instance, read from the runner that
                  // instance would be placed on - one rule, `computeInstanceDefaults`.
                  const nextModel =
                    next === undefined
                      ? null
                      : computeInstanceDefaults(next, runners, localId).model;
                  save({
                    user: {
                      "thread.instanceId": event.target.value,
                      ...(nextModel === null ? {} : { "thread.model": nextModel }),
                    },
                  });
                }}
              >
                {instances.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.displayName}
                  </option>
                ))}
              </Select>
            </Row>
            <Row label="Model" htmlFor="thread-model">
              {modelField.dimmed !== null ? (
                <p className="py-1.5 text-fine text-faint">{modelField.dimmed}</p>
              ) : (
                <Select
                  id="thread-model"
                  value={defaults.model ?? ""}
                  onChange={(event) => {
                    save({ user: { "thread.model": event.target.value } });
                  }}
                >
                  {modelField.options.map((option) => (
                    <option key={option.slug} value={option.slug}>
                      {option.missing ? `${option.name} (not offered)` : option.name}
                    </option>
                  ))}
                </Select>
              )}
            </Row>
          </>
        )}
        <Row label="Access mode">
          <SegmentedControl
            aria-label="Access mode"
            // Four hyphenated words in the width of one value column: the
            // segments are set at the scale's smaller step and sit closer
            // together, which is what makes them fit without breaking a word.
            className="[&>button]:px-1.5 [&>button]:text-fine"
            value={defaults.accessMode}
            onValueChange={(next) => {
              save({ user: { "thread.accessMode": next as AccessMode } });
            }}
          >
            {ACCESS_MODES.map((mode) => (
              <SegmentedControlItem key={mode} value={mode}>
                {mode}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Row>
        <Row label="Profile" htmlFor="thread-profile">
          <Select
            id="thread-profile"
            value={defaults.profileId ?? ""}
            onChange={(event) => {
              save({ user: { "thread.profileId": event.target.value } });
            }}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </Select>
        </Row>
        <SaveStatus saved={saved} failure={failure} />
      </FormCard>

      <FormCard
        label="Threads · workspace"
        fine="Picked here, it stands whatever the project holds. Left unset, a project with one repo opens in its main workspace and a project with several repos opens in a New workspace. A project with no source always runs without a workspace."
      >
        <Row label="Workspace">
          <SegmentedControl
            aria-label="Workspace"
            // Nothing stored is nothing on: the fine print below says what
            // happens then, and a face lit up would claim a choice nobody made.
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
        label="Threads · git"
        fine="A thread working in a checkout acts through that repo's own Connection; this is what the rest act through."
      >
        {/* A `Row` like its siblings would put this label in the 110px column
            the other rows share, where it wraps to four lines beside a
            one-line select; it is three times longer than any of them. */}
        <Field id="thread-github" label="GitHub account for threads without a checkout">
          <Select
            id="thread-github"
            value={settings.user["thread.githubConnectionId"] ?? ""}
            onChange={(event) => {
              // The setting is nullable, so "no account" clears it rather
              // than storing an empty string the contract's `Id` refuses.
              const picked = event.target.value;
              save({ user: { "thread.githubConnectionId": picked === "" ? null : picked } });
            }}
          >
            <option value="">No account</option>
            {githubs.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label}
              </option>
            ))}
          </Select>
        </Field>
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
            className="w-[220px]"
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
