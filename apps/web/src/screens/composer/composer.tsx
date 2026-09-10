/**
 * The composer: the thread's own configuration, in new-thread mode (nothing
 * started yet - every selector live) and inside a started thread (workspace,
 * checkout, branch, runner, profile and access mode locked to plain values;
 * only the model stays live, within the instance it started in).
 *
 * One component for both, per spec 14 §The composer ("Creating a thread is
 * one step"): a started thread reads its locked fields straight off the
 * `Session` prop rather than from any state of its own, so there is nothing
 * here to keep in sync with it.
 */
import { useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  accessModeMenu,
  instanceDefaults,
  modelMenu,
  modelPillLabel,
  queryKeys,
  referenceRunner,
  runnerMenu,
  threadDefaults,
  type HydraClient,
  type RunnerMenuRow,
} from "@hydra/client-core";
import type {
  AccessMode,
  Profile,
  ProviderInstance,
  Runner,
  Session,
  SettingsState,
} from "@hydra/contract";
import { Button, cn, ListRow, Textarea } from "@hydra/ui";
import { messageOf } from "../save-status";
import { MenuRow } from "./menu-row";
import { ModelMenuContent } from "./model-menu-content";
import { PopoverSelector } from "./popover-selector";
import { QueuedInputs } from "./queued-inputs";
import { SetupField } from "./setup-field";

type SelectorKey =
  "workspace" | "checkout" | "branch" | "runner" | "profile" | "accessMode" | "model";

/**
 * Once a thread has started, the provider instance is where its login and its
 * User Material live - switching it would need a new thread, so every other
 * instance's group is locked shut regardless of what `modelMenu` itself would
 * otherwise dim it with.
 */
const SWITCH_LOCK_REASON = "switching accounts starts a new thread";

/** Only `online` and `unreachable` carry a doctrine hue (live, failed); the rest are neutral. */
const RUNNER_STATE_HUE: Record<RunnerMenuRow["state"], string> = {
  online: "text-live",
  draining: "text-muted",
  retired: "text-muted",
  unreachable: "text-fail",
  offline: "text-muted",
};

/**
 * The runner menu's own first line: name, its state word in the state's hue,
 * then what else is true of it. The separating " · " is a text character in
 * every segment, not a flex gap, so the row's own text - and a test reading
 * it - carries the same spacing the eye sees.
 */
const runnerRowLabel = (row: RunnerMenuRow): JSX.Element => (
  <span className="flex min-w-0 items-center">
    <span className="truncate">{row.name}</span>
    <span className={cn("shrink-0", RUNNER_STATE_HUE[row.state])}>{` · ${row.state}`}</span>
    {row.isLocal ? <span className="shrink-0 text-faint"> · this machine</span> : null}
    {row.reserved ? <span className="shrink-0 text-faint"> · reserved</span> : null}
  </span>
);

export function Composer({
  client,
  instances,
  runners,
  profiles,
  localRunnerId,
  settingsUser,
  session,
  onSend,
}: {
  readonly client: HydraClient;
  readonly instances: readonly ProviderInstance[];
  readonly runners: readonly Runner[];
  readonly profiles: readonly Profile[];
  /** Which runner is on this machine - the composer's own default, not its selection. */
  readonly localRunnerId: string | null;
  readonly settingsUser: SettingsState["user"];
  /** Undefined is new-thread mode; a Session is a started thread. */
  readonly session?: Session;
  /** A started thread's own way to rejoin the transcript's tail the moment a message goes out. */
  readonly onSend?: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const started = session !== undefined;

  // The composer's own draft selection, live only until a thread starts - a
  // started thread reads the same five values off `session` instead (below)
  // and never reads a draft, which is why the defaults are only resolved in
  // new-thread mode. Nothing picked is `null`, never an empty string: the
  // spawn payload below omits what is null and lets the server's own fallback
  // decide, rather than posting an id-shaped value it would refuse.
  const [defaults] = useState(() =>
    session === undefined
      ? threadDefaults(settingsUser, instances, runners, profiles, localRunnerId)
      : null,
  );
  const [draftInstanceId, setDraftInstanceId] = useState(defaults?.instanceId ?? null);
  const [draftModel, setDraftModel] = useState(defaults?.model ?? null);
  const [draftAccessMode, setDraftAccessMode] = useState<AccessMode>(
    defaults?.accessMode ?? "approval-required",
  );
  const [draftRunnerId, setDraftRunnerId] = useState(defaults?.runnerId ?? null);
  const [draftProfileId, setDraftProfileId] = useState(defaults?.profileId ?? null);
  const [modelOptions, setModelOptions] = useState<Record<string, string | boolean>>({});
  const [openSelector, setOpenSelector] = useState<SelectorKey | null>(null);
  const [prompt, setPrompt] = useState("");

  const instanceId: string | null = started ? session.instanceId : draftInstanceId;
  const model: string | null = started ? session.modelSelection.model : draftModel;
  const accessMode = started ? session.accessMode : draftAccessMode;
  const runnerId: string | null = started ? session.runnerId : draftRunnerId;
  const profileId: string | null = started ? session.permissionProfileId : draftProfileId;

  const pickModel = (nextModel: string): void => {
    setModelOptions({});
    setDraftModel(nextModel);
  };

  const switchInstance = (nextInstanceId: string): void => {
    const next = instances.find((each) => each.id === nextInstanceId);
    if (next === undefined) return;
    // A catalog is scoped instance x runner, and the runner that hosts the
    // instance just left need not host this one - so the runner is resolved
    // for the new instance first and the model read from that runner, the
    // same order `threadDefaults` prefills in.
    const forInstance = instanceDefaults(next, runners, localRunnerId);
    setDraftInstanceId(nextInstanceId);
    setModelOptions({});
    setDraftRunnerId(forInstance.runnerId);
    setDraftModel(forInstance.model);
  };

  const instance = instances.find((each) => each.id === instanceId);
  const accessModeItems =
    instance === undefined ? [] : accessModeMenu(instance.declared.accessModes);
  const runnerRows =
    instance === undefined ? [] : runnerMenu(runners, localRunnerId, instance).rows;
  // The runner the model menu and the runner selector's own trigger speak
  // about when nothing is actually selectable: the selection itself when
  // there is one, else the local machine, else the first runner at all -
  // never the empty, unnamed runner a plain lookup on `runnerId` would leave
  // when no runner is picked.
  const pickedRunner = referenceRunner(runners, runnerId, localRunnerId);
  const pickedRunnerRow = runnerRows.find((row) => row.runnerId === pickedRunner?.id);
  const pickedProfile = profiles.find((each) => each.id === profileId);

  const rawGroups =
    instance === undefined ? [] : modelMenu(instances, pickedRunner ?? null, { instanceId, model });
  const groups = started
    ? rawGroups.map((group) =>
        group.instanceId === instanceId ? group : { ...group, dimmed: SWITCH_LOCK_REASON },
      )
    : rawGroups;
  const currentModelRow = groups
    .find((group) => group.instanceId === instanceId)
    ?.models.find((row) => row.slug === model);
  const currentOptions = currentModelRow?.options ?? [];
  // A started thread has no way to change an option in this build (only
  // `model` rides `session.update`), so its pill and its options block both
  // read the session's own recorded choice rather than the draft state a
  // new thread picks from.
  const selectedOptions = started ? session.modelSelection.options : modelOptions;
  const pillText =
    instance === undefined
      ? "Model"
      : modelPillLabel(instance, model, currentOptions, selectedOptions);

  // Once a thread starts the runner is a plain committed fact, never dimmed
  // in its own right - the reason only matters while it is still a live pick.
  const runnerLabel =
    pickedRunner === undefined
      ? "Runner"
      : started || pickedRunnerRow === undefined || pickedRunnerRow.dimmed === null
        ? pickedRunner.name
        : `${pickedRunner.name} · ${pickedRunnerRow.dimmed}`;

  const rereadProviders = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
  };

  // Read only where `started` already guards it, so the mutations below never
  // reach for a session that is not there.
  const sessionId = session?.id ?? "";

  const spawn = useMutation({
    mutationFn: () =>
      client.session.spawn({
        payload: {
          prompt,
          accessMode,
          workspaceId: null,
          // Omitted, never sent empty: the server has its own fallback for
          // each of these, and `Id` refuses an empty string outright.
          ...(instanceId === null ? {} : { instanceId }),
          ...(model === null ? {} : { model }),
          ...(runnerId === null ? {} : { runnerId }),
          ...(profileId === null ? {} : { permissionProfileId: profileId }),
        },
      }),
    onSuccess: (created) => {
      void navigate({ to: "/threads/$sessionId", params: { sessionId: created.id } });
    },
  });

  const updateModel = useMutation({
    mutationFn: (nextModel: string) =>
      client.session.update({ params: { id: sessionId }, payload: { model: nextModel } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.session(updated.id), updated);
    },
  });

  const sendInput = useMutation({
    mutationFn: (text: string) =>
      client.session.input({ params: { id: sessionId }, payload: { text } }),
    onSuccess: () => {
      setPrompt("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sessionId) });
    },
  });

  const interrupt = useMutation({
    mutationFn: () => client.session.interrupt({ params: { id: sessionId } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.session(updated.id), updated);
    },
  });

  // What stops a new thread from starting at all, said in the words the user
  // would need to fix it. A started thread has nothing to resolve, and every
  // other field the server has a fallback for is omitted rather than blocking.
  const blocked =
    started || instance !== undefined
      ? null
      : instances.length === 0
        ? "no provider instance is set up"
        : "no provider instance can be resolved";
  const noRunner =
    started || instance === undefined || runnerRows.some((row) => row.dimmed === null)
      ? null
      : `no runner is logged in to ${instance.displayName}`;
  const blockedReason = blocked ?? noRunner;

  const send = (): void => {
    if (prompt.trim() === "" || blockedReason !== null) return;
    if (started) {
      sendInput.mutate(prompt);
      onSend?.();
    } else {
      spawn.mutate();
    }
  };

  const exited = started && session.status === "exited";
  const busy = started && session.status === "busy";
  const composerError = spawn.error ?? sendInput.error ?? updateModel.error ?? interrupt.error;
  const sending = spawn.isPending || sendInput.isPending;

  // A click that opens selector B is also, to Radix, a click outside selector
  // A - so A's own dismiss-on-outside-click fires in the same event, and can
  // land after B's own open call in the same batch. Closing only clears the
  // selector that is still the one asking to close, so B's open never gets
  // clobbered by A's own dismissal racing behind it.
  const toggle =
    (key: SelectorKey) =>
    (open: boolean): void =>
      setOpenSelector((current) => (open ? key : current === key ? null : current));

  return (
    <div className="sticky bottom-0 mt-auto flex flex-col gap-2">
      {started ? <QueuedInputs client={client} sessionId={session.id} /> : null}

      <div className="rounded-card border border-line bg-raised p-3 shadow-card">
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter is a newline. An IME's own Enter -
            // the one that commits a composition - is not a send: React
            // reports it as `isComposing`, and swallowing it would cut a
            // Japanese or Chinese sentence off mid-word.
            if (event.key !== "Enter" || event.shiftKey) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
          disabled={exited}
          placeholder={
            exited
              ? "this thread has exited"
              : started
                ? "Type a message…"
                : "What should the agent do?"
          }
        />
        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            disabled
            title="attachments are not built"
            aria-label="Attach"
            className="rounded-control px-2 py-1 text-fine text-faint"
          >
            +
          </button>

          {started ? (
            <span className="rounded-control px-2 py-1 text-fine text-muted">{accessMode}</span>
          ) : (
            <PopoverSelector
              open={openSelector === "accessMode"}
              onOpenChange={toggle("accessMode")}
              trigger={accessMode}
            >
              {accessModeItems.map((item) => (
                <MenuRow
                  key={item.mode}
                  label={item.mode}
                  secondLine={item.meaning}
                  dimmed={item.dimmed}
                  blocking={false}
                  selected={item.mode === accessMode}
                  onClick={() => {
                    setDraftAccessMode(item.mode);
                    setOpenSelector(null);
                  }}
                />
              ))}
            </PopoverSelector>
          )}

          <PopoverSelector
            open={openSelector === "model"}
            onOpenChange={toggle("model")}
            trigger={pillText}
            triggerClassName="flex-1 text-center font-emph text-ink"
            contentClassName="w-80"
          >
            <ModelMenuContent
              groups={groups}
              onPickModel={(slug) => {
                // A model row only ever renders inside the expanded group,
                // which is always the current instance - so there is no
                // instance to resolve here, only the slug.
                if (started) {
                  if (slug !== model) updateModel.mutate(slug);
                  return;
                }
                pickModel(slug);
              }}
              onSwitchInstance={(nextInstanceId) => {
                if (!started) switchInstance(nextInstanceId);
              }}
              options={currentOptions}
              selectedOptions={selectedOptions}
              onOptionChange={
                started
                  ? undefined
                  : (id, value) => setModelOptions((prev) => ({ ...prev, [id]: value }))
              }
              client={client}
              loginRunner={pickedRunner}
              onLoggedIn={rereadProviders}
            />
          </PopoverSelector>

          <button
            type="button"
            disabled
            title="dictation is not built"
            aria-label="Voice"
            className="rounded-control px-2 py-1 text-fine text-faint"
          >
            ●
          </button>

          {busy ? (
            <Button onClick={() => interrupt.mutate()} disabled={interrupt.isPending}>
              Stop
            </Button>
          ) : null}

          <Button
            variant="primary"
            aria-label="Send"
            disabled={prompt.trim() === "" || exited || sending || blockedReason !== null}
            title={blockedReason ?? undefined}
            onClick={send}
            className="rounded-full"
          >
            <span aria-hidden="true">↑</span>
          </Button>
        </div>
        {composerError === null || composerError === undefined ? (
          blockedReason === null ? null : (
            <p className="mt-2 text-fine text-faint">{blockedReason}</p>
          )
        ) : (
          <p className="mt-2 text-fine text-fail" role="alert">
            {messageOf(composerError)}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between text-fine text-faint">
        <div className="flex items-center gap-1">
          <SetupField
            started={started}
            lockedText="No workspace"
            open={openSelector === "workspace"}
            onOpenChange={toggle("workspace")}
            trigger="No workspace"
          >
            <MenuRow label="No workspace" selected onClick={() => setOpenSelector(null)} />
            <MenuRow label="Adopt a folder on this machine…" dimmed="not built yet" />
            <MenuRow label="Add a repo →" dimmed="not built yet" />
          </SetupField>
          <SetupField
            started={started}
            lockedText="—"
            open={openSelector === "checkout"}
            onOpenChange={toggle("checkout")}
            trigger="Checkout"
          >
            <ListRow dimmed disabled>
              <span className="truncate text-fine text-faint">no workspace</span>
            </ListRow>
          </SetupField>
          <SetupField
            started={started}
            lockedText="—"
            open={openSelector === "branch"}
            onOpenChange={toggle("branch")}
            trigger="Branch"
          >
            <ListRow dimmed disabled>
              <span className="truncate text-fine text-faint">no workspace</span>
            </ListRow>
          </SetupField>
        </div>
        <div className="flex items-center gap-1">
          <SetupField
            started={started}
            lockedText={pickedRunner?.name ?? ""}
            open={openSelector === "runner"}
            onOpenChange={toggle("runner")}
            trigger={runnerLabel}
            align="end"
          >
            {runnerRows.map((row) => (
              <MenuRow
                key={row.runnerId}
                label={runnerRowLabel(row)}
                secondLine={[row.identity, row.planLabel]
                  .filter((each) => each !== null)
                  .join(" · ")}
                dimmed={row.dimmed}
                selected={row.runnerId === runnerId}
                onClick={() => {
                  setDraftRunnerId(row.runnerId);
                  setOpenSelector(null);
                }}
              />
            ))}
          </SetupField>
          <SetupField
            started={started}
            lockedText={pickedProfile?.name ?? ""}
            open={openSelector === "profile"}
            onOpenChange={toggle("profile")}
            trigger={pickedProfile?.name ?? "Profile"}
            align="end"
          >
            {profiles.map((each) => (
              <MenuRow
                key={each.id}
                label={each.name}
                selected={each.id === profileId}
                onClick={() => {
                  setDraftProfileId(each.id);
                  setOpenSelector(null);
                }}
              />
            ))}
          </SetupField>
        </div>
      </div>
    </div>
  );
}
