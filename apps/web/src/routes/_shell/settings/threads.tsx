import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { defaultInstanceId, threadModelField, threadRowsMode } from "@hydra/client-core";
import type { AccessMode, ProviderInstance, ThreadRows } from "@hydra/contract";
import { FormCard, Row, SegmentedControl, SegmentedControlItem, Select } from "@hydra/ui";
import {
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

export const Route = createFileRoute("/_shell/settings/threads")({
  staticData: { title: "Threads" },
  loader: async ({ context }) => {
    const [runners] = await Promise.all([
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
      context.queryClient.ensureQueryData(profilesQuery(context.client)),
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
  const { save, saved, failure } = useSaveSettings(client);

  const rows = threadRowsMode(settings.user["ui.threadRows"]);

  // A stored id naming an instance that no longer exists falls back the same
  // way an unset one does, so the model field always has a picked instance to
  // read - never the empty, unexplained field a stale id would otherwise leave.
  // The fallback is the same rule the composer prefills a new thread from.
  const fallbackInstanceId = defaultInstanceId(instances);
  const instance =
    instances.find((each) => each.id === settings.user["thread.instanceId"]) ??
    instances.find((each) => each.id === fallbackInstanceId);
  const instanceId = instance?.id ?? "";
  const modelField =
    instance === undefined
      ? { dimmed: null, options: [] }
      : threadModelField(instance, localId, settings.user["thread.model"]);
  // The default model of whichever instance is picked, reading the same
  // runner-scoped snapshot rule as the field itself - what a fresh instance
  // starts on before the user has chosen a model of its own.
  const defaultModelOf = (target: ProviderInstance): string | undefined => {
    const field = threadModelField(target, localId, undefined);
    return field.options.find((option) => option.isDefault)?.slug ?? field.options[0]?.slug;
  };
  const model =
    settings.user["thread.model"] ??
    modelField.options.find((option) => option.isDefault)?.slug ??
    modelField.options[0]?.slug ??
    "";
  const accessMode = settings.user["thread.accessMode"] ?? "approval-required";
  const profileId =
    settings.user["thread.profileId"] ??
    profiles.find((profile) => profile.name === "unrestricted")?.id ??
    profiles[0]?.id ??
    "";

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
                value={instanceId}
                onChange={(event) => {
                  const next = instances.find((each) => each.id === event.target.value);
                  const nextModel = next === undefined ? undefined : defaultModelOf(next);
                  save({
                    user: {
                      "thread.instanceId": event.target.value,
                      ...(nextModel === undefined ? {} : { "thread.model": nextModel }),
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
                  value={model}
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
            value={accessMode}
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
            value={profileId}
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
        label="Threads · display"
        fine={
          rows === "plain"
            ? "Plain rows show a thread's title and its age."
            : "Meta rows add a second line with the checkout or branch, the pull request and the model."
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
