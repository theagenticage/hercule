import type { JSX } from "react";
import type { RepositorySubmission } from "@hercule/client-core";
import { Field, Input, Select } from "@hercule/ui";

/**
 * One source in the New project form. For now the only kind of source is a
 * git repository, so this type is a repository as the form sends it, plus
 * `key`, which React tells the rows apart by.
 *
 * - `message` is the error for this source: from the server, or from the form's
 *   own check before sending.
 * - `createdId` is set once the source is created, so resubmitting after an
 *   error does not create it twice.
 */
export interface SourceSubmission extends RepositorySubmission {
  readonly key: string;
}

/** A GitHub account a source can be cloned and pushed with. */
export interface ConnectionOption {
  readonly id: string;
  readonly label: string;
}

/**
 * The New project dialog: a name and the sources the project works with. It
 * sits over a scrim and uses the project picker's style (a raised card, 520px
 * wide), because it opens from the same place. Repos are set up here, not in
 * the composer.
 *
 * This component is presentational: it receives every value and error as
 * props, and the parent handles every button press.
 */
export function NewProjectDialog({
  name,
  sources,
  accounts,
  pending,
  failure,
  onName,
  onAddSource,
  onChangeSource,
  onRemoveSource,
  onSubmit,
  onClose,
}: {
  readonly name: string;
  readonly sources: readonly SourceSubmission[];
  readonly accounts: readonly ConnectionOption[];
  /** Whether a save is in progress. While it is, Cancel and Create are disabled. */
  readonly pending: boolean;
  /** Why the project itself was not created; each source has its own `message`. */
  readonly failure: string | null;
  readonly onName: (name: string) => void;
  readonly onAddSource: () => void;
  readonly onChangeSource: (key: string, source: Partial<SourceSubmission>) => void;
  readonly onRemoveSource: (key: string) => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-40 flex justify-center overflow-y-auto bg-scrim pt-[12vh] pb-8"
      // Clicking the page behind closes the dialog, as on every other overlay in the app.
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-heading"
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
        className="flex h-fit w-[520px] max-w-[92vw] flex-col rounded-card border border-line bg-raised p-3.5 shadow-lift"
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <span
            id="new-project-heading"
            className="text-label font-emph tracking-[0.1em] text-faint uppercase"
          >
            New project
          </span>
          <Field id="new-project-name" label="Name">
            <Input
              id="new-project-name"
              autoFocus
              value={name}
              placeholder="What it is called"
              onChange={(event) => {
                onName(event.target.value);
              }}
            />
          </Field>

          <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
            <div className="flex items-baseline gap-2">
              <span className="text-label font-emph tracking-[0.1em] text-faint uppercase">
                Sources
              </span>
              <span className="ml-auto font-mono text-[10.5px] text-faint">
                what the project works with
              </span>
            </div>
            {sources.length === 0 ? (
              <p className="text-fine text-faint">
                No source yet. A project without one runs its threads without a workspace.
              </p>
            ) : null}
            {sources.map((source) => (
              <SourceRow
                key={source.key}
                source={source}
                accounts={accounts}
                onChange={(next) => {
                  onChangeSource(source.key, next);
                }}
                onRemove={() => {
                  onRemoveSource(source.key);
                }}
              />
            ))}
            <button
              type="button"
              onClick={onAddSource}
              className="self-start rounded-control px-1 py-0.5 text-meta text-muted hover:text-ink"
            >
              + Git repository
            </button>
          </div>

          {failure === null ? null : (
            <p className="text-fine text-fail" role="alert">
              {failure}
            </p>
          )}
          <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
            <button type="button" disabled={pending} onClick={onClose} className={ACTION}>
              Cancel
            </button>
            <button type="submit" disabled={pending} className={ACTION}>
              Create project
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** One git repository the project would work with. */
function SourceRow({
  source,
  accounts,
  onChange,
  onRemove,
}: {
  readonly source: SourceSubmission;
  readonly accounts: readonly ConnectionOption[];
  readonly onChange: (next: Partial<SourceSubmission>) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const remoteId = `source-${source.key}-remote`;
  const accountId = `source-${source.key}-account`;
  const setupId = `source-${source.key}-setup`;
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line-soft p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-meta text-muted">Git repository</span>
        {source.createdId === null ? (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto text-fine text-faint hover:text-ink"
          >
            Remove
          </button>
        ) : (
          // A source that is already created cannot be removed here. It
          // belongs to the project now, and is removed where resources are edited.
          <span className="ml-auto text-fine text-faint">added</span>
        )}
      </div>
      <Field id={remoteId} label="Remote URL">
        <Input
          id={remoteId}
          value={source.remote}
          placeholder="git@github.com:acme/webshop.git"
          onChange={(event) => {
            onChange({ remote: event.target.value });
          }}
        />
      </Field>
      <Field id={accountId} label="GitHub account">
        <Select
          id={accountId}
          value={source.connectionId ?? ""}
          onChange={(event) => {
            onChange({ connectionId: event.target.value === "" ? null : event.target.value });
          }}
        >
          <option value="">No account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-fine text-faint">A private repo needs one.</p>
      <Field id={setupId} label="Setup command">
        <Input
          id={setupId}
          value={source.setupCommand}
          placeholder="pnpm install"
          onChange={(event) => {
            onChange({ setupCommand: event.target.value });
          }}
        />
      </Field>
      {source.message === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {source.message}
        </p>
      )}
    </div>
  );
}

const ACTION =
  "cursor-pointer rounded-full border border-line bg-raised px-[11px] py-[3px] text-meta text-ink hover:bg-line-soft disabled:cursor-default disabled:text-faint";
