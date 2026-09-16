import { useRef, useState, type JSX } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  branchField,
  draftSubject,
  modelMenu,
  optionsLabel,
  pendingModelNote,
  projectRepos,
  queryKeys,
  runnerForPick,
  withBranch,
  workspaceMenu,
  type Thread,
} from "@hydra/client-core";
import {
  localRunnerQuery,
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionsQuery,
  workspacesQuery,
} from "../../app/queries";
import { messageOf } from "../save-status";
import { AccessModeSelector } from "./access-mode-selector";
import { AttachButton, SendButton, StopButton, VoiceButton } from "./controls";
import { DraftHero } from "./draft-hero";
import { Lip } from "./lip";
import { loginSlot } from "./login-slot";
import { ModelOptionsSelector } from "./model-options-selector";
import { ModelSelector } from "./model-selector";
import { MessageBox } from "./message-box";
import { useComposerModel } from "./use-composer-model";

type SelectorKey = "accessMode" | "options" | "model" | "workspace" | "branch" | "machine";

/**
 * The composer: what the thread runs with, and the message about to go to it. One
 * component for a draft and an active thread - `useComposerModel` holds the
 * difference, and every lock, dimming and blocker comes from `composerFields`.
 */
export function Composer({
  thread,
  onSend,
}: {
  readonly thread: Thread;
  /** An active thread's way to rejoin the tail as a message goes out. */
  readonly onSend?: () => void;
}): JSX.Element {
  const { client, detectLocalRunner } = useRouteContext({ from: "/_shell" });
  const queryClient = useQueryClient();
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const localRunnerId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  // The three catalogs the workspace menu reads. A controller that cannot
  // answer them leaves the composer with no project and no workspace to offer,
  // which is exactly what it shows before #72's records exist.
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const resources = useQuery(resourcesQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];
  const catalogs = {
    instances,
    runners,
    localRunnerId,
    projects,
    resources,
    workspaces,
    sessions,
  };
  const [open, setOpen] = useState<SelectorKey | null>(null);
  // Where the model pill begins: what the lip's branch menu keeps clear of.
  const pill = useRef<HTMLSpanElement>(null);
  const [filter, setFilter] = useState("");
  const model = useComposerModel(thread, catalogs, client, onSend);
  const fields = model.fields;
  const pending = pendingModelNote(model.kind, model.picks);
  const login = loginSlot(client, () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
  });
  // A click opening B is also a click outside A, so closing clears only the selector asking to.
  const openChange = (key: SelectorKey, next: boolean): void => {
    setOpen((current) => (next ? key : current === key ? null : current));
    if (key === "model" && !next) setFilter("");
  };
  // The catalog behind the model pill is worth resolving only while it is on show.
  const models =
    open === "model"
      ? modelMenu(catalogs, model.config, { kind: model.kind, filter, recent: model.recent })
      : null;
  const projectId = model.config.projectId ?? null;
  const project = projects.find((each) => each.id === projectId);
  const pick = fields.workspace.value;
  const menu = workspaceMenu({
    project,
    repos: projectRepos(resources, projectId),
    workspaces,
    sessions,
    runners,
    // The machine the fields resolved, never the draft's raw pick: those two
    // differ before anything is selectable, and the menu would then say the
    // repo is not cloned on a machine the sentence above it never named.
    runnerId: fields.machine.runnerId,
    pick,
  });
  const branch = branchField(pick, { workspaces, runnerId: fields.machine.runnerId });
  const cannotSend = fields.blocked !== null || model.readOnly !== null || model.sending;
  const canSend = !cannotSend && model.message.trim() !== "";
  return (
    // A draft stands under its own sentence, which takes the room above the card.
    <div className={fields.lead === null ? "flex w-full flex-col" : "flex w-full flex-1 flex-col"}>
      {fields.lead === null ? null : (
        <DraftHero
          subject={draftSubject(pick, workspaces, projectId, projects)}
          lead={fields.lead}
          blocked={fields.blocked}
          loginSlot={login}
        />
      )}
      {/* The card is the same box whatever is docked to it: the lip below and
          the permission dock above both tuck under it, so its own radius,
          border and lift never change (spec 14 §Measurements, amended
          2026-09-14). It sits above both of them. */}
      <div className="relative z-[1] flex flex-col gap-2 rounded-[14px] border border-line bg-raised px-3.5 pt-3 pb-2.5 shadow-lift">
        <MessageBox
          value={model.message}
          placeholder={model.placeholder}
          disabled={model.readOnly !== null}
          onChange={model.setMessage}
          onSubmit={() => {
            if (canSend) model.submit();
          }}
        />
        <div className="flex items-center gap-1.5">
          <AttachButton />
          <AccessModeSelector
            mode={fields.accessMode.value}
            items={fields.accessMode.rows}
            locked={fields.accessMode.locked}
            open={open === "accessMode"}
            onOpenChange={(next) => {
              openChange("accessMode", next);
            }}
            onPick={(mode) => {
              model.pick({ kind: "accessMode", value: mode });
            }}
          />
          {pending === null ? null : (
            <span className="ml-1 font-mono text-[11px] text-attn">{pending}</span>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {fields.options === null ? null : (
              <ModelOptionsSelector
                descriptors={fields.options}
                selected={model.config.options}
                label={optionsLabel(fields.options, model.config.options)}
                modelName={fields.model.pill.name}
                disabled={model.readOnly !== null}
                open={open === "options"}
                onOpenChange={(next) => {
                  openChange("options", next);
                }}
                onPick={(id, value) => {
                  model.pick({ kind: "option", id, value });
                }}
              />
            )}
            <span ref={pill} className="inline-flex min-w-0">
              <ModelSelector
                menu={models}
                filter={filter}
                onFilter={setFilter}
                pill={fields.model.pill}
                disabled={model.readOnly !== null}
                open={open === "model"}
                onOpenChange={(next) => {
                  openChange("model", next);
                }}
                onPick={model.pick}
                loginSlot={login}
              />
            </span>
          </div>
          <VoiceButton />
          {model.busy ? <StopButton onStop={model.stop} /> : null}
          <SendButton tip={model.sendTip} disabled={!canSend} onSend={model.submit} />
        </div>
        {model.error === null ? null : (
          <p className="text-fine text-fail" role="alert">
            {messageOf(model.error)}
          </p>
        )}
      </div>
      <Lip
        workspace={fields.workspace}
        menu={menu}
        branch={branch}
        machine={fields.machine}
        pill={pill}
        open={open === "workspace" || open === "branch" || open === "machine" ? open : null}
        onOpenChange={openChange}
        onPickWorkspace={(picked) => {
          // A workspace that already stands settles the machine too, which is
          // `runnerForPick`'s to say rather than this component's.
          const settled = runnerForPick(picked, workspaces);
          if (settled === null) model.pick({ kind: "workspace", value: picked });
          else
            model.pick({ kind: "workspace", value: picked }, { kind: "runnerId", value: settled });
        }}
        onPickBranch={(picked) => {
          model.pick({ kind: "workspace", value: withBranch(pick, picked) });
        }}
        onPickRunner={(runnerId) => {
          model.pick({ kind: "runnerId", value: runnerId });
        }}
      />
    </div>
  );
}
