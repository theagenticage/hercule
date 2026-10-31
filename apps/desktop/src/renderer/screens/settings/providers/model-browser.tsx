import { useEffect, useRef, type JSX, type ReactNode, type RefObject } from "react";
import {
  MODEL_SORT_CHOICES,
  type ModelBrowserQuery,
  type ModelMaker,
  type ModelSort,
} from "@hercule/client-core";
import type { ModelCatalogItem } from "@hercule/contract";
import { CloseIcon } from "../../../icons/close";
import { PlusIcon } from "../../../icons/plus";
import { SearchIcon } from "../../../icons/search";
import { GlassDialog } from "../../glass-dialog";
import { CatalogHead } from "./catalog-head";
import { ModelBrowserFacets } from "./model-browser-facets";
import { ModelBrowserList, NoModelMatches } from "./model-browser-list";
import "./model-browser.css";

/**
 * Renders the model browser's dialog: a glass dialog over one account's Model Catalog,
 * for the open profile. From the top:
 *
 * - the head: the account's `mark` and name with how old the catalog is and
 *   Refresh, the search field, the sort and a close button;
 * - the catalog's last failed read (`readError`) when there is one;
 * - the facets and the table of the models that match `query` (`ModelBrowserList`);
 * - the tray at the foot: a chip for each model in `picks`, and "Add <n> to
 *   <profile>", which calls `onSave`.
 *
 * It draws what it is given and reads nothing. `status` is `loading` while
 * the catalog is first read, `failed` when that read failed (`failure` says
 * why) and `ready` once `models`, the matches of `query`, are known. `held`
 * holds the slugs the profile has already, which cannot be picked.
 * `onQueryChange` is called with the whole new query. While `saving`, the
 * dialog does not close, the Add button keeps focus, and the picks cannot
 * change: the rows and the chips ignore presses, because the save has already
 * taken the picks it was given. `saveError` is the
 * controller's refusal, shown above the foot.
 *
 * `dialogRef` is the dialog element, which the caller closes after a save;
 * `onClose` is called whenever the dialog closes. The search field takes the
 * focus when the dialog opens, because the user is here to search.
 */
export function ModelBrowserDialog({
  dialogRef,
  accountName,
  mark,
  profileName,
  status,
  failure,
  readAt,
  readError,
  refreshing,
  makers,
  query,
  models,
  held,
  picks,
  saving,
  saveError,
  onQueryChange,
  onTogglePick,
  onRefresh,
  onSave,
  onClose,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly accountName: string;
  readonly mark: ReactNode;
  readonly profileName: string;
  readonly status: "loading" | "failed" | "ready";
  readonly failure: string | null;
  readonly readAt: string | null;
  readonly readError: string | null;
  readonly refreshing: boolean;
  readonly makers: readonly ModelMaker[];
  readonly query: ModelBrowserQuery;
  readonly models: readonly ModelCatalogItem[];
  readonly held: ReadonlySet<string>;
  readonly picks: readonly ModelCatalogItem[];
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly onQueryChange: (query: ModelBrowserQuery) => void;
  readonly onTogglePick: (model: ModelCatalogItem) => void;
  readonly onRefresh: () => void;
  readonly onSave: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null);
  // A modal dialog focuses its first control, the sort or the close button,
  // when it opens. This effect runs after the one in GlassDialog that opens
  // the dialog, because that one is a child's.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  const picked = new Set(picks.map(({ slug }) => slug));
  const close = (): void => dialogRef.current?.close();
  const whenEmpty =
    status === "loading" ? (
      <p className="mb-status">Reading models…</p>
    ) : status === "failed" ? (
      <p className="mb-status is-failed">{failure}</p>
    ) : models.length === 0 ? (
      <NoModelMatches />
    ) : null;
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="model-browser"
      label={`Browse ${accountName} models`}
      locked={saving}
      onClose={onClose}
    >
      <div className="mb-h">
        <span className="mb-mark">{mark}</span>
        <span className="mb-t">
          <b>{accountName}</b>
          <CatalogHead
            className="mb-age"
            readAt={readAt}
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        </span>
        <label className="field mb-search">
          <SearchIcon size={15} />
          <input
            ref={searchRef}
            type="text"
            aria-label="Search models"
            placeholder="Search by name, maker or id"
            spellCheck={false}
            autoComplete="off"
            value={query.search}
            onChange={(event) => {
              onQueryChange({ ...query, search: event.target.value });
            }}
          />
        </label>
        <span className="field field--select mb-sort">
          <select
            aria-label="Sort models"
            value={query.sort}
            onChange={(event) => {
              onQueryChange({ ...query, sort: event.target.value as ModelSort });
            }}
          >
            {MODEL_SORT_CHOICES.map(({ label, value }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close"
          title="Close"
          disabled={saving}
          onClick={close}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      {readError === null ? null : <p className="mb-read-error">{readError}</p>}
      <div className="mb-body">
        <ModelBrowserFacets
          makers={makers}
          facets={query.facets}
          onChange={(facets) => {
            onQueryChange({ ...query, facets });
          }}
        />
        <ModelBrowserList
          models={models}
          held={held}
          picked={picked}
          frozen={saving}
          profileName={profileName}
          whenEmpty={whenEmpty}
          onToggle={onTogglePick}
        />
      </div>
      {saveError === null ? null : (
        <p className="mb-save-error" role="alert">
          {saveError}
        </p>
      )}
      <div className="mb-foot">
        <ul className="mb-tray" aria-label="Models to add">
          {picks.length === 0 ? (
            <li className="mb-tray-empty">
              {`Pick models with +. They join ${profileName}'s menu at the end of ${accountName}'s part.`}
            </li>
          ) : (
            picks.map((model) => (
              <li key={model.slug} className="mb-chip">
                <PlusIcon size={10} />
                {model.name}
                <button
                  type="button"
                  aria-label={`Do not add ${model.name}`}
                  aria-disabled={saving ? true : undefined}
                  onClick={() => {
                    if (!saving) onTogglePick(model);
                  }}
                >
                  <CloseIcon size={9} />
                </button>
              </li>
            ))
          )}
        </ul>
        <button type="button" className="btn" disabled={saving} onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--accent"
          disabled={picks.length === 0}
          aria-disabled={saving ? true : undefined}
          aria-busy={saving ? true : undefined}
          onClick={() => {
            if (!saving) onSave();
          }}
        >
          {saving
            ? "Adding…"
            : picks.length === 0
              ? "Add"
              : `Add ${String(picks.length)} to ${profileName}`}
        </button>
      </div>
    </GlassDialog>
  );
}
