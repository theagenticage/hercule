import type { JSX, ReactNode, Ref } from "react";
import {
  formatAccessMode,
  setWorkspaceStartingRevision,
  type DraftView,
  type RecentModel,
  type SignInTarget,
  type ThreadChoice,
} from "@hercule/client-core";
import { BranchIcon } from "../../icons/branch";
import { LaptopIcon } from "../../icons/laptop";
import { ShieldIcon } from "../../icons/shield";
import { WorkspaceIcon } from "../../icons/workspace";
import { ComposerCard, type ComposerAttachments } from "../session/composer-frame";
import type { ComposerSkills } from "../session/message-field";
import { ComposerMenu } from "../thread/composer-menu";
import { ModelPick, OptionsPick } from "../thread/composer-picks";
import { AccessModeMenu } from "./access-mode-menu";
import { BranchMenuContent, MachineMenuContent, WorkspaceMenuContent } from "./lip-menus";

/**
 * The id of the draft's message field. The shell focuses the field by this
 * id when the user opens the draft that is already open, see `ShellLayout`.
 */
export const DRAFT_MESSAGE_ID = "draft-message";

/**
 * Renders one pick of the draft: its glyph and its label, as a trigger that
 * opens `children` as a menu above it, `width` wide (see `ComposerMenu`).
 * `className` is `pick` for a pick in the composer's row and `lip-pick` for
 * one in the lip. A pick that cannot change on this draft, `locked`, is plain
 * text with the reason as its tooltip.
 */
function DraftPick({
  className,
  label,
  glyph,
  locked,
  menuLabel,
  align,
  width,
  children,
  onOpen,
}: {
  readonly className: "pick" | "lip-pick";
  readonly label: string;
  readonly glyph: ReactNode;
  readonly locked: string | null;
  readonly menuLabel: string;
  readonly align: "start" | "end";
  readonly width: "narrow" | "widest";
  readonly children: (close: () => void) => ReactNode;
  readonly onOpen?: () => void;
}): JSX.Element {
  if (locked !== null) {
    return (
      <span className={className} title={locked}>
        {glyph}
        {label}
      </span>
    );
  }
  return (
    <ComposerMenu
      label={menuLabel}
      align={align}
      width={width}
      disabled={false}
      triggerClassName={className}
      trigger={
        <>
          {glyph}
          {label}
        </>
      }
      onOpen={onOpen}
    >
      {children}
    </ComposerMenu>
  );
}

/**
 * Renders a Draft Thread's composer, as the Bureau book's `session-empty`
 * page draws it: the card, see `ComposerCard`, with the shelf of attached
 * images, the message field and a row with Attach, the access mode, the model options when the model has
 * any, the model, Dictate and Send; then the lip under it, with the
 * workspace, the branch when there is one to pick, and the machine.
 *
 * Every selector makes one choice, which is passed to `onChoose`, and the
 * caller records it in the draft's picks. Joining an existing workspace sets
 * the machine too, because the draft is resolved to the workspace's machine.
 * A starting revision applies only to a new workspace and never switches an
 * existing checkout.
 *
 * ⏎ in the field calls `onSubmit`, and ⇧⏎ starts a new line. Send, and ⏎,
 * do nothing while `canSend` is false. `attachments` and `notice` are the
 * card's: the shelf and the files the user attaches, and the line under the
 * row that says why the images stop the start. `skills` are the skills the
 * thread would have, which the message field offers as `$` and `/` lists. Dictate is drawn but does
 * nothing yet, and carries `aria-disabled`.
 */
export function DraftComposer({
  view,
  text,
  placeholder,
  canSend,
  error,
  notice,
  attachments,
  skills,
  runnerId,
  readRecent,
  fieldRef,
  onTextChange,
  onChoose,
  onSignIn,
  onSubmit,
  onOpenWorkspaceMenu,
}: {
  readonly view: DraftView;
  readonly text: string;
  readonly placeholder: string;
  readonly canSend: boolean;
  /** The failed start's message, shown under the row, or `null`. */
  readonly error: string | null;
  readonly notice: string | null;
  readonly attachments: ComposerAttachments;
  /** The skills the draft would have, which the message field offers. */
  readonly skills: ComposerSkills;
  /**
   * The machine the user picked, or the one the workspace it joins decides;
   * `null` while any machine will do. The model menu dims an entry by this
   * machine, not by the one the draft would be placed on by default.
   */
  readonly runnerId: string | null;
  /** Returns the models the user picked lately, which the model menu offers first. */
  readonly readRecent: () => readonly RecentModel[];
  readonly fieldRef: Ref<HTMLElement>;
  readonly onTextChange: (text: string) => void;
  readonly onChoose: (choice: ThreadChoice) => void;
  /** Opens the sign-in a dimmed entry of the model menu offers. */
  readonly onSignIn: (target: SignInTarget) => void;
  readonly onSubmit: () => void;
  readonly onOpenWorkspaceMenu: () => void;
}): JSX.Element {
  const { catalogs, resolved, fields, workspaceMenu, branch, workspaceLabel, machineLabel } = view;
  const { config } = resolved;
  const { pill } = fields.model;
  const descriptors = fields.options;
  const workspace = fields.workspace.value;

  return (
    <div className="composer">
      <ComposerCard
        text={text}
        onTextChange={onTextChange}
        placeholder={placeholder}
        readOnly={false}
        canSend={canSend}
        onSend={onSubmit}
        error={error}
        notice={notice}
        attachments={attachments}
        skills={skills}
        start={
          <>
            <DraftPick
              className="pick"
              label={formatAccessMode(fields.accessMode.value)}
              glyph={<ShieldIcon size={14} />}
              locked={fields.accessMode.locked}
              menuLabel="Access mode"
              align="start"
              width="narrow"
            >
              {(close) => (
                <AccessModeMenu
                  value={fields.accessMode.value}
                  rows={fields.accessMode.rows}
                  onPick={(mode) => {
                    onChoose({ kind: "accessMode", value: mode });
                    close();
                  }}
                />
              )}
            </DraftPick>
            {descriptors === null ? null : (
              <OptionsPick
                descriptors={descriptors}
                selected={config.options}
                modelName={pill.name}
                disabled={false}
                onChoose={onChoose}
              />
            )}
          </>
        }
        end={
          <ModelPick
            pill={pill}
            catalogs={catalogs}
            config={config}
            kind="draft"
            runnerId={runnerId}
            disabled={false}
            readRecent={readRecent}
            onChoose={onChoose}
            onSignIn={onSignIn}
          />
        }
        fieldRef={fieldRef}
        fieldId={DRAFT_MESSAGE_ID}
        // The book's draft field has the focus when the page opens, so the
        // user can type the moment the draft shows.
        autoFocus
        sendTitle="Start thread"
      />
      <div className="lip">
        <DraftPick
          className="lip-pick"
          label={workspaceLabel}
          glyph={<WorkspaceIcon size={13} />}
          locked={fields.workspace.locked}
          menuLabel="Workspace"
          align="start"
          // The workspace's and the machine's rows carry a second line; the
          // branch menu's rows are short.
          width="widest"
          onOpen={onOpenWorkspaceMenu}
        >
          {(close) => (
            <WorkspaceMenuContent
              menu={workspaceMenu}
              onPick={(picked) => {
                onChoose({ kind: "workspace", workspace: picked });
                close();
              }}
            />
          )}
        </DraftPick>
        {branch === null ? null : (
          <DraftPick
            className="lip-pick"
            label={branch.label}
            glyph={<BranchIcon size={13} />}
            locked={branch.locked}
            menuLabel="Branch"
            align="start"
            width="narrow"
            onOpen={onOpenWorkspaceMenu}
          >
            {(close) => (
              <BranchMenuContent
                field={branch}
                onPick={(picked) => {
                  onChoose({
                    kind: "workspace",
                    workspace: setWorkspaceStartingRevision(workspace, picked),
                  });
                  close();
                }}
              />
            )}
          </DraftPick>
        )}
        <span className="spacer" />
        <DraftPick
          className="lip-pick"
          label={machineLabel}
          glyph={<LaptopIcon size={13} />}
          locked={fields.machine.locked}
          menuLabel="Machine"
          align="end"
          width="widest"
        >
          {(close) => (
            <MachineMenuContent
              rows={fields.machine.rows}
              onPick={(runnerId) => {
                onChoose({ kind: "runner", runnerId });
                close();
              }}
            />
          )}
        </DraftPick>
      </div>
    </div>
  );
}
