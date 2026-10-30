import { useRef, useState, type DragEvent, type JSX } from "react";
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
  setWorkspaceStartingRevision,
  buildWorkspaceMenu,
  type Thread,
  readErrorMessage,
} from "@hercule/client-core";
import { ImageLightbox } from "@hercule/ui";
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
import { AttachmentShelf, DropOverlay } from "./attachment-shelf";
import { ComposerCard } from "./composer-card";
import { SESSION_STOP_TITLE, StopButton } from "../stop-button";
import { AttachButton, PreviousButton, SendButton, StepButton, VoiceButton } from "./controls";
import { DraftHero } from "./draft-hero";
import { Lip } from "./lip";
import { buildLoginSlot } from "./login-slot";
import { ModelOptionsSelector } from "./model-options-selector";
import { ModelSelector } from "./model-selector";
import { MessageBox } from "./message-box";
import { useComposerAnswer } from "./use-composer-answer";
import { useComposerModel } from "./use-composer-model";
import { useTypingGuard } from "./use-typing-guard";

type SelectorKey = "accessMode" | "options" | "model" | "workspace" | "branch" | "machine";

/** Checks whether a drag carries files, rather than text or a link. */
const isFileDrag = (event: DragEvent): boolean => event.dataTransfer.types.includes("Files");

/**
 * The composer: the thread's settings, and the message about to be sent to it.
 * The same component serves a draft and an active thread. `useComposerModel`
 * handles the difference, and every lock, dimmed row and blocker comes from
 * `buildComposerFields`.
 *
 * While the Request dock shows a question the composer answers, the composer
 * is in answer mode (`useComposerAnswer`): the text field shows and edits the
 * shown question's own answer, and the step button takes the place of Send.
 * Answers are plain text, so Attach is off, the shelf is hidden and a pasted
 * or dropped file is refused. The message, its images and the model and
 * option picks are not touched, and the message comes back when answer mode
 * ends. A question that arrives while the user is typing a message waits for
 * the user to pause (`useTypingGuard`).
 */
export function Composer({
  thread,
  onSend,
}: {
  readonly thread: Thread;
  /** Called after a message is sent; an active thread uses it to scroll back to the bottom. */
  readonly onSend?: () => void;
}): JSX.Element {
  const { client, live, uploads, detectLocalRunner } = useRouteContext({ from: "/_shell" });
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
  const [dragging, setDragging] = useState(false);
  // The position of the shelf image shown large, or null when none is.
  const [preview, setPreview] = useState<number | null>(null);
  const model = useComposerModel(thread, catalogs, client, uploads, onSend);
  const guard = useTypingGuard();
  const answer = useComposerAnswer(
    client,
    thread.kind === "active" ? thread.session : null,
    guard.holding,
  );
  const fields = model.fields;
  const { config } = model.resolved;
  const pending = buildPendingModelNote(model.resolved);
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
      ? buildModelMenu(catalogs, config, { kind: model.kind, filter, recent: model.recent })
      : null;
  const projectId = config.projectId ?? null;
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
  const shelf = model.message.attachments;
  const canSend =
    !cannotSend &&
    model.attachmentBlock === null &&
    (model.message.text.trim() !== "" || shelf.length > 0);
  const attachDisabledReason =
    model.readOnly ??
    (fields.model.imageInput !== null ? null : `${fields.model.modelName} does not accept images`);
  const submitMessage = (): void => {
    // Even a send that fails ends the typing guard: the user has finished the message.
    guard.release();
    model.submit();
  };
  const notice = answer === null ? (model.refusal ?? model.attachmentBlock) : answer.notice;
  const noticeFailed = answer === null ? model.refusal !== null : answer.refusedFile;
  // Each mode shows its own failure. A message that failed to send is shown
  // when the message comes back, and a failed answer is not shown beside the
  // message. A failure to stop the agent belongs to both.
  const stopFailure = model.stopError === null ? null : readErrorMessage(model.stopError);
  const sendFailure = model.sendError === null ? null : readErrorMessage(model.sendError);
  const errorText =
    answer === null ? (sendFailure ?? stopFailure) : (answer.failure ?? stopFailure);
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
      <div
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0 || model.readOnly !== null) return;
          event.preventDefault();
          if (answer === null) model.attachFiles(files);
          else answer.attachments.onFiles();
        }}
        onDragEnter={(event) => {
          // An answer takes no files, so it offers no place to drop them.
          if (isFileDrag(event) && model.readOnly === null && answer === null) setDragging(true);
        }}
        onDragOver={(event) => {
          // Without this the browser refuses the drop and opens the file instead.
          if (isFileDrag(event) && model.readOnly === null) event.preventDefault();
        }}
        onDragLeave={(event) => {
          // A drag moving between the card's own children leaves one of them,
          // not the card.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          setDragging(false);
          if (!isFileDrag(event) || model.readOnly !== null) return;
          event.preventDefault();
          if (answer === null) model.attachFiles([...event.dataTransfer.files]);
          else answer.attachments.onFiles();
        }}
      >
        <ComposerCard>
          {dragging ? <DropOverlay /> : null}
          {answer === null ? (
            <AttachmentShelf
              shelf={shelf}
              model={fields.model}
              onPreview={setPreview}
              onRemove={model.removeAttachment}
              onRetry={model.retryAttachment}
            />
          ) : null}
          <MessageBox
            value={answer === null ? model.message.text : answer.text}
            placeholder={answer === null ? model.placeholder : answer.placeholder}
            readOnly={model.readOnly !== null || (answer?.locked ?? false)}
            onChange={(text) => {
              if (answer !== null) {
                answer.onTextChange(text);
                return;
              }
              guard.holdAfterEdit();
              model.setMessage(text);
            }}
            onSubmit={() => {
              if (answer !== null) answer.step.onStep();
              else if (canSend) submitMessage();
              else guard.release();
            }}
            onBlur={guard.release}
            // Only a composition in the Message Draft holds off a question.
            // While answering, the hold would make the composer show the
            // Message Draft instead of the answer being composed.
            onCompositionStart={
              answer === null
                ? () => {
                    guard.reportComposing(true);
                  }
                : undefined
            }
            onCompositionEnd={
              answer === null
                ? () => {
                    guard.reportComposing(false);
                  }
                : undefined
            }
          />
          {/* The controls on the right (dictation, Stop, Previous, the step or
              send button) never shrink. When the row is too narrow, the
              access mode and the model pill are cut with an ellipsis first. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <AttachButton
              disabledReason={
                answer === null ? attachDisabledReason : answer.attachments.attachBlockedReason
              }
              // The picker can come back after a question took the composer
              // over, so the mode is read when the files arrive, as for paste.
              onFiles={(files) => {
                if (answer === null) model.attachFiles(files);
                else answer.attachments.onFiles();
              }}
            />
            <AccessModeSelector
              mode={fields.accessMode.value}
              items={fields.accessMode.rows}
              locked={fields.accessMode.locked}
              open={open === "accessMode"}
              onOpenChange={(next) => {
                handleOpenChange("accessMode", next);
              }}
              onPick={(mode) => {
                model.recordThreadChoice({ kind: "accessMode", value: mode });
              }}
            />
            {pending === null ? null : (
              <span className="ml-1 min-w-0 truncate font-mono text-[11px] text-attn">
                {pending}
              </span>
            )}
            <div className="ml-auto flex min-w-0 shrink items-center gap-1.5">
              {fields.options === null ? null : (
                <ModelOptionsSelector
                  descriptors={fields.options}
                  selected={config.options}
                  label={buildOptionsLabel(fields.options, config.options)}
                  modelName={fields.model.pill.name}
                  disabled={model.readOnly !== null}
                  open={open === "options"}
                  onOpenChange={(next) => {
                    handleOpenChange("options", next);
                  }}
                  onPick={(id, value) => {
                    model.recordThreadChoice({ kind: "option", id, value });
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
                  onChoose={model.recordThreadChoice}
                  loginSlot={login}
                />
              </span>
            </div>
            <VoiceButton />
            {model.busy ? <StopButton title={SESSION_STOP_TITLE} onStop={model.stop} /> : null}
            {answer === null ? (
              <SendButton tip={model.sendTip} disabled={!canSend} onSend={submitMessage} />
            ) : (
              <>
                {answer.step.showsPrevious ? (
                  <PreviousButton
                    disabled={!answer.step.canGoBack}
                    onPrevious={answer.step.onPrevious}
                  />
                ) : null}
                <StepButton
                  label={answer.step.label}
                  disabled={!answer.step.ready || model.readOnly !== null}
                  onStep={answer.step.onStep}
                />
              </>
            )}
          </div>
          {errorText === null ? null : (
            <p className="text-fine text-fail" role="alert">
              {errorText}
            </p>
          )}
          {notice === null ? null : (
            <p
              className={noticeFailed ? "text-fine text-fail" : "text-fine text-muted"}
              role="status"
            >
              {notice}
            </p>
          )}
        </ComposerCard>
      </div>
      {preview === null ? null : (
        <ImageLightbox
          images={shelf.map((item) => ({ key: item.key, name: item.name, blob: item.file }))}
          index={Math.min(preview, shelf.length - 1)}
          onIndexChange={setPreview}
          onClose={() => {
            setPreview(null);
          }}
        />
      )}
      <Lip
        workspace={fields.workspace}
        menu={menu}
        branch={branch}
        machine={fields.machine}
        pill={pill}
        open={open === "workspace" || open === "branch" || open === "machine" ? open : null}
        onOpenChange={handleOpenChange}
        onPickWorkspace={(picked) => {
          model.recordThreadChoice({ kind: "workspace", workspace: picked });
        }}
        onPickBranch={(picked) => {
          model.recordThreadChoice({
            kind: "workspace",
            workspace: setWorkspaceStartingRevision(pick, picked),
          });
        }}
        onPickRunner={(runnerId) => {
          model.recordThreadChoice({ kind: "runner", runnerId });
        }}
      />
    </div>
  );
}
