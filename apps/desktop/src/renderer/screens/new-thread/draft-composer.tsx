import type { JSX, ReactNode, Ref } from "react";
import {
  buildComposerPlaceholder,
  formatAccessMode,
  setWorkspaceStartingRevision,
  type DraftView,
  type RecentModel,
  type SignInTarget,
  type ThreadChoice,
} from "@hercule/client-core";
import { AlertIcon } from "../../icons/alert";
import { BranchIcon } from "../../icons/branch";
import { LaptopIcon } from "../../icons/laptop";
import { ShieldIcon } from "../../icons/shield";
import { SlidersIcon } from "../../icons/sliders";
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

/** The reason line of the access, model and workspace menus, see `DraftComposer`. */
export interface DraftPickReasons {
  readonly accessMode: string | null;
  readonly model: string | null;
  readonly workspace: string | null;
}

/**
 * Renders a Draft Thread's composer, as the Bureau book's `session-empty`
 * page draws it: the card, see `ComposerCard`, with the shelf of attached
 * images, the message field and a row with Attach, the access mode, the model options when the model has
 * any, the model, Dictate and Send; then the lip under it, with the
 * workspace, the branch when there is one to pick, and the machine.
 *
 * When the account cannot run on the machine, the machine's laptop glyph
 * turns into an alert mark, and the machine is followed by Sign in when a
 * sign-in fixes the problem, which calls `onSignIn`, or else by the reason,
 * such as "offline".
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
  canSend,
  error,
  notice,
  attachments,
  skills,
  readRecent,
  fieldRef,
  aboveField,
  replaceMessageRef,
  fieldId,
  lipStart,
  picksOffReason,
  pickReasons,
  onTextChange,
  onChoose,
  onSignIn,
  onSubmit,
  onOpenWorkspaceMenu,
}: {
  readonly view: DraftView;
  readonly text: string;
  readonly canSend: boolean;
  /** The failed start's message, shown under the row, or `null`. */
  readonly error: string | null;
  readonly notice: string | null;
  readonly attachments: ComposerAttachments;
  /** The skills the draft would have, which the message field offers. */
  readonly skills: ComposerSkills;
  /** Returns the models the user picked lately, which the model menu offers first. */
  readonly readRecent: () => readonly RecentModel[];
  readonly fieldRef: Ref<HTMLElement>;
  /** Content inside the card above the field, see `ComposerCard`. */
  readonly aboveField?: ReactNode;
  /** Receives the function that replaces the message as one undoable edit, see `MessageField`. */
  readonly replaceMessageRef?: Ref<(text: string) => void> | undefined;
  /**
   * The id of the message field, `DRAFT_MESSAGE_ID` when left out; a second
   * composer on the page, such as the one in the Inbox's start-thread dialog,
   * passes its own so the ids stay unique.
   */
  readonly fieldId?: string;
  /** Content drawn first in the lip, before the workspace, such as the dialog's project pick. */
  readonly lipStart?: ReactNode;
  /**
   * Why the composer's picks cannot change yet, such as "Choose a project
   * first", or `null` when they can. The access, effort and profile picks
   * then draw as the faint words "Access", "Effort" and "Profile" with this
   * as their tooltip, because the project decides them, and the workspace
   * and branch picks are left out.
   */
  readonly picksOffReason?: string | null;
  /**
   * Why each pick is what it is, one muted line at the top of that pick's
   * menu. A `null` reason draws no line. Left out, no menu has one.
   */
  readonly pickReasons?: DraftPickReasons;
  readonly onTextChange: (text: string) => void;
  readonly onChoose: (choice: ThreadChoice) => void;
  /** Opens the sign-in a dimmed entry of the model menu, or the machine in the lip, offers. */
  readonly onSignIn: (target: SignInTarget) => void;
  readonly onSubmit: () => void;
  readonly onOpenWorkspaceMenu: () => void;
}): JSX.Element {
  const { catalogs, resolved, fields, workspaceMenu, branch, workspaceLabel } = view;
  const offReason = picksOffReason ?? null;
  const placeholder = buildComposerPlaceholder({
    readOnly: null,
    busy: false,
    active: false,
    pick: fields.workspace.value,
    workspaces: catalogs.workspaces,
  });
  // The machine the user picked, or the one the workspace it joins decides, never the one the
  // draft would be placed on by default: the model menu must not dim entries by that one.
  const runnerId = resolved.menuRunnerId;
  const { problem } = fields.machine;
  const signIn = problem?.signIn ?? null;
  const machinePick = (
    <DraftPick
      className="lip-pick"
      label={fields.machine.name}
      glyph={
        problem === null ? (
          <LaptopIcon size={13} />
        ) : (
          <span className="lip-alert">
            <AlertIcon size={13} />
          </span>
        )
      }
      locked={offReason ?? fields.machine.locked}
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
  );
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
        aboveField={aboveField}
        replaceMessageRef={replaceMessageRef}
        skills={skills}
        start={
          offReason === null ? (
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
                    reason={pickReasons?.accessMode ?? null}
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
          ) : (
            <>
              <OffPick reason={offReason} glyph={<ShieldIcon size={14} />} label="Access" />
              <OffPick reason={offReason} glyph={<SlidersIcon size={14} />} label="Effort" />
            </>
          )
        }
        end={
          offReason === null ? (
            <ModelPick
              pill={pill}
              catalogs={catalogs}
              config={config}
              kind="draft"
              runnerId={runnerId}
              disabled={false}
              readRecent={readRecent}
              reason={pickReasons?.model ?? null}
              onChoose={onChoose}
              onSignIn={onSignIn}
            />
          ) : (
            <OffPick reason={offReason} label="Profile" isPill />
          )
        }
        fieldRef={fieldRef}
        fieldId={fieldId ?? DRAFT_MESSAGE_ID}
        // The book's draft field has the focus when the page opens, so the
        // user can type the moment the draft shows.
        autoFocus
        sendTitle="Start thread"
      />
      <div className="lip">
        {lipStart}
        {offReason !== null ? null : (
          <>
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
                  reason={pickReasons?.workspace ?? null}
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
          </>
        )}
        <span className="spacer" />
        {problem === null ? (
          machinePick
        ) : (
          // The machine and its problem read as one item, so they share a
          // span and the lip's wider gap stays between items. A machine with
          // no problem has no span, so the lip is the book's.
          <span className="lip-machine">
            {machinePick}
            <span aria-hidden="true">·</span>
            {signIn === null ? (
              problem.reason
            ) : (
              <button
                type="button"
                className="link"
                aria-label={`Sign in to ${signIn.subject}`}
                onClick={() => {
                  onSignIn(signIn);
                }}
              >
                Sign in
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Renders a pick that waits for a choice made elsewhere, as faint words with
 * `reason` as its tooltip: the Inbox's start-thread dialog shows "Access",
 * "Effort" and "Profile" this way until a project is picked. `isPill` gives it
 * the pill the model pick has.
 */
function OffPick({
  reason,
  label,
  glyph,
  isPill,
}: {
  readonly reason: string;
  readonly label: string;
  readonly glyph?: ReactNode;
  readonly isPill?: boolean | undefined;
}): JSX.Element {
  return (
    <button
      type="button"
      className={isPill === true ? "pick pick--pill is-off" : "pick is-off"}
      aria-disabled="true"
      title={reason}
    >
      {glyph}
      {isPill === true ? <span className="pick-name">{label}</span> : label}
    </button>
  );
}
