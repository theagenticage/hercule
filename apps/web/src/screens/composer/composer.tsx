import { useRef, useState, type JSX } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildBranchField,
  findDraftSubject,
  buildModelMenu,
  buildOptionsLabel,
  buildPendingModelNote,
  listProjectRepos,
  queryKeys,
  withBranch,
  buildWorkspaceMenu,
  buildWorkspacePicks,
  type Thread,
  readErrorMessage,
} from "@hercule/client-core";
import {
  localRunnerQuery,
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionsQuery,
  workspacesQuery,
} from "../../app/queries";
import { AccessModeSelector } from "./access-mode-selector";
import { ComposerCard } from "./composer-card";
import { AttachButton, SendButton, StopButton, VoiceButton } from "./controls";
import { DraftHero } from "./draft-hero";
import { Lip } from "./lip";
import { buildLoginSlot } from "./login-slot";
import { ModelOptionsSelector } from "./model-options-selector";
import { ModelSelector } from "./model-selector";
import { MessageBox } from "./message-box";
import { useComposerModel } from "./use-composer-model";

type SelectorKey = "accessMode" | "options" | "model" | "workspace" | "branch" | "machine";

/**
 * The composer: the thread's settings, and the message about to be sent to it.
 * The same component serves a draft and an active thread. `useComposerModel`
 * handles the difference, and every lock, dimmed row and blocker comes from
 * `buildComposerFields`.
 */
export function Composer({
  thread,
  onSend,
}: {
  readonly thread: Thread;
  /** Called after a message is sent; an active thread uses it to scroll back to the bottom. */
  readonly onSend?: () => void;
}): JSX.Element {
  const { client, live, detectLocalRunner } = useRouteContext({ from: "/_shell" });
  const queryClient = useQueryClient();
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const thisMacRunnerId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  // The catalogs the workspace menu reads. If the controller cannot return
  // them, the composer simply offers no project and no workspace.
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const resources = useQuery(resourcesQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];
  const catalogs = {
    instances,
    runners,
    thisMacRunnerId,
    projects,
    resources,
    workspaces,
    sessions,
  };
  const [open, setOpen] = useState<SelectorKey | null>(null);
  // The model pill's element. The lip's branch menu measures it to stay clear of the pill.
  const pill = useRef<HTMLSpanElement>(null);
  const [filter, setFilter] = useState("");
  const model = useComposerModel(thread, catalogs, client, onSend);
  const fields = model.fields;
  const pending = buildPendingModelNote(model.kind, model.picks);
  const login = buildLoginSlot(client, live, () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
  });
  // A click that opens selector B is also a click outside selector A. So a
  // close request clears the open selector only if that selector asked to close.
  const handleOpenChange = (key: SelectorKey, next: boolean): void => {
    setOpen((current) => (next ? key : current === key ? null : current));
    if (key === "model" && !next) setFilter("");
  };
  // The model menu is built only while it is open.
  const models =
    open === "model"
      ? buildModelMenu(catalogs, model.config, { kind: model.kind, filter, recent: model.recent })
      : null;
  const projectId = model.config.projectId ?? null;
  const pick = fields.workspace.value;
  const menu = buildWorkspaceMenu({
    repos: listProjectRepos(resources, projectId),
    workspaces,
    sessions,
    runners,
    // Use the machine the fields resolved, not the draft's raw pick. The two
    // differ before anything is picked, and the raw pick would make the menu
    // say the repo is not cloned on a machine the draft's sentence never named.
    runnerId: fields.machine.runnerId,
    pick,
  });
  const branch = buildBranchField(pick, { workspaces, runnerId: fields.machine.runnerId });
  const cannotSend = fields.blocked !== null || model.readOnly !== null || model.sending;
  const canSend = !cannotSend && model.message.trim() !== "";
  return (
    // A draft shows its sentence above the card, and the sentence takes the free space.
    <div className={fields.lead === null ? "flex w-full flex-col" : "flex w-full flex-1 flex-col"}>
      {fields.lead === null ? null : (
        <DraftHero
          subject={findDraftSubject(pick, workspaces, projectId, projects)}
          lead={fields.lead}
          blocked={fields.blocked}
          loginSlot={login}
        />
      )}
      <ComposerCard>
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
              handleOpenChange("accessMode", next);
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
                label={buildOptionsLabel(fields.options, model.config.options)}
                modelName={fields.model.pill.name}
                disabled={model.readOnly !== null}
                open={open === "options"}
                onOpenChange={(next) => {
                  handleOpenChange("options", next);
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
                  handleOpenChange("model", next);
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
            {readErrorMessage(model.error)}
          </p>
        )}
      </ComposerCard>
      <Lip
        workspace={fields.workspace}
        menu={menu}
        branch={branch}
        machine={fields.machine}
        pill={pill}
        open={open === "workspace" || open === "branch" || open === "machine" ? open : null}
        onOpenChange={handleOpenChange}
        onPickWorkspace={(picked) => {
          model.pick(...buildWorkspacePicks(picked, workspaces));
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
