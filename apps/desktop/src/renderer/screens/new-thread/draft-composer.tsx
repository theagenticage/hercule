import type { JSX, ReactNode, Ref } from "react";
import {
  buildWorkspacePicks,
  formatAccessMode,
  withBranch,
  type ComposerPick,
  type DraftView,
  type RecentModel,
} from "@hercule/client-core";
import { BranchIcon } from "../../icons/branch";
import { LaptopIcon } from "../../icons/laptop";
import { ShieldIcon } from "../../icons/shield";
import { WorkspaceIcon } from "../../icons/workspace";
import { ComposerCard } from "../session/composer-frame";
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
}: {
  readonly className: "pick" | "lip-pick";
  readonly label: string;
  readonly glyph: ReactNode;
  readonly locked: string | null;
  readonly menuLabel: string;
  readonly align: "start" | "end";
  readonly width: "narrow" | "widest";
  readonly children: (close: () => void) => ReactNode;
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
    >
      {children}
    </ComposerMenu>
  );
}

/**
 * Renders a Draft Thread's composer, as the Bureau book's `session-empty`
 * page draws it: the card, see `ComposerCard`, with the message field and a
 * row with Attach, the access mode, the model options when the model has
 * any, the model, Dictate and Send; then the lip under it, with the
 * workspace, the branch when there is one to pick, and the machine.
 *
 * Every pick is passed to `onPick`, which the caller applies to the draft.
 * Picking a workspace that exists also picks the machine it is on, and
 * picking a branch changes the picked workspace's branch.
 *
 * ⏎ in the field calls `onSubmit`, and ⇧⏎ starts a new line. Send, and ⏎,
 * do nothing while `canSend` is false. Attach and Dictate are drawn but do
 * nothing yet, and carry `aria-disabled`.
 */
export function DraftComposer({
  view,
  text,
  placeholder,
  canSend,
  error,
  readRecent,
  fieldRef,
  onTextChange,
  onPick,
  onSubmit,
}: {
  readonly view: DraftView;
  readonly text: string;
  readonly placeholder: string;
  readonly canSend: boolean;
  /** The failed start's message, shown under the row, or `null`. */
  readonly error: string | null;
  /** Returns the models the user picked lately, which the model menu offers first. */
  readonly readRecent: () => readonly RecentModel[];
  readonly fieldRef: Ref<HTMLTextAreaElement>;
  readonly onTextChange: (text: string) => void;
  readonly onPick: (steps: readonly ComposerPick[]) => void;
  readonly onSubmit: () => void;
}): JSX.Element {
  const { catalogs, config, fields, workspaceMenu, branch, workspaceLabel, machineLabel } = view;
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
                    onPick([{ kind: "accessMode", value: mode }]);
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
                onPick={onPick}
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
            disabled={false}
            readRecent={readRecent}
            onPick={onPick}
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
        >
          {(close) => (
            <WorkspaceMenuContent
              menu={workspaceMenu}
              onPick={(picked) => {
                onPick(buildWorkspacePicks(picked, catalogs.workspaces));
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
          >
            {(close) => (
              <BranchMenuContent
                field={branch}
                onPick={(picked) => {
                  onPick([{ kind: "workspace", value: withBranch(workspace, picked) }]);
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
                onPick([{ kind: "runnerId", value: runnerId }]);
                close();
              }}
            />
          )}
        </DraftPick>
      </div>
    </div>
  );
}
