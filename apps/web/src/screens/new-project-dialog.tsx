import { type JSX } from "react";
import { Field, Input, Select } from "@hydra/ui";

/**
 * One source a new project would hold. Only a git repository for now (D-20b),
 * so the row is that row rather than a kind and a shape behind it.
 *
 * `message` is what came back about this source, or what the form refused
 * before it sent anything; `createdId` is set once it stands, so a second
 * submission after a refusal does not create it twice.
 */
export interface SourceDraft {
  readonly key: string;
  readonly remote: string;
  readonly connectionId: string;
  readonly setupCommand: string;
  readonly message: string | null;
  readonly createdId: string | null;
}

/** A GitHub account a source may be cloned and pushed through. */
export interface ConnectionOption {
  readonly id: string;
  readonly label: string;
}

/**
 * The New project dialog: a name and the sources the project works with
 * (D-20b). It stands over a scrim in the project picker's own register - the
 * raised card, 520px - because it is the same one question asked in the same
 * place, and setting a repo up is no longer something the composer does.
 *
 * Presentational: every value and every refusal is handed to it, and pressing
 * anything is the orchestrator's to answer.
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
  readonly sources: readonly SourceDraft[];
  readonly accounts: readonly ConnectionOption[];
  readonly pending: boolean;
  /** Why the project itself was not made; a source carries its own. */
  readonly failure: string | null;
  readonly onName: (name: string) => void;
  readonly onAddSource: () => void;
  readonly onChangeSource: (key: string, source: Partial<SourceDraft>) => void;
  readonly onRemoveSource: (key: string) => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-40 flex justify-center overflow-y-auto bg-scrim pt-[12vh] pb-8"
      // The page behind it is the way out, as it is on every other overlay here.
      onClick={onClose}
    >
      <form
        aria-label="New project"
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="flex h-fit w-[520px] max-w-[92vw] flex-col gap-3 rounded-card border border-line bg-raised p-3.5 shadow-lift"
      >
        <span className="text-label font-emph tracking-[0.1em] text-faint uppercase">
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
          <button type="button" onClick={onClose} className={ACTION}>
            Cancel
          </button>
          <button type="submit" disabled={pending} className={ACTION}>
            Create project
          </button>
        </div>
      </form>
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
  readonly source: SourceDraft;
  readonly accounts: readonly ConnectionOption[];
  readonly onChange: (next: Partial<SourceDraft>) => void;
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
          // What already stands is not removed from a form: the project holds
          // it, and taking it away is done where resources are edited.
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
          value={source.connectionId}
          onChange={(event) => {
            onChange({ connectionId: event.target.value });
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
