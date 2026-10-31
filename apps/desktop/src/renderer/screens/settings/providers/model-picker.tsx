import { useId, useState, type JSX, type ReactNode } from "react";
import type { ModelCatalogItem } from "@hercule/contract";
import { PlusIcon } from "../../../icons/plus";
import { SearchIcon } from "../../../icons/search";
import { MenuLine } from "../../thread/menu-line";
import { CatalogHead } from "./catalog-head";
import "../../thread/menus.css";
import "./models.css";

/**
 * Renders "Browse 466 models", the button that takes the place of "Add a
 * model" for an account whose catalog is too large for the picker. It opens
 * the model browser through `onBrowse`.
 *
 * `name` is the account's name, which tells this button from the other
 * sections'.
 */
export function BrowseModelsButton({
  name,
  modelCount,
  onBrowse,
}: {
  readonly name: string;
  readonly modelCount: number;
  readonly onBrowse: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="pm-add"
      aria-haspopup="dialog"
      aria-label={`Browse ${String(modelCount)} models from ${name}`}
      onClick={onBrowse}
    >
      <SearchIcon size={12} />
      {`Browse ${String(modelCount)} models`}
    </button>
  );
}

/**
 * Renders "Add a model" and the popover it opens, which holds `children`
 * only while it is open. What the children read, such as the account's
 * catalog, is therefore read when the popover opens and gone when it closes.
 * The browser closes the popover on Esc and on a click outside it.
 *
 * `name` is the account's name, which tells this button from the other
 * sections'. The popover's foot holds "Browse all <n>" when `browseAll` is
 * given: it closes the popover and calls `onBrowse`, which opens the model
 * browser.
 */
export function AddModelPopover({
  name,
  browseAll,
  children,
}: {
  readonly name: string;
  readonly browseAll?: { readonly modelCount: number; readonly onBrowse: () => void } | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  return (
    <>
      <button
        type="button"
        className="pm-add"
        popoverTarget={menuId}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Add a model from ${name}`}
      >
        <PlusIcon size={12} />
        Add a model
      </button>
      <div
        id={menuId}
        popover="auto"
        role="dialog"
        aria-label={`Add a model from ${name}`}
        className="pop menu menu--wide pm-picker"
        onToggle={(event) => {
          setOpen(event.newState === "open");
        }}
      >
        {open ? (
          <>
            {children}
            <div className="pop-sec pm-done">
              {browseAll === undefined ? null : (
                <button
                  type="button"
                  className="link pm-browse-all"
                  popoverTarget={menuId}
                  popoverTargetAction="hide"
                  onClick={browseAll.onBrowse}
                >
                  {`Browse all ${String(browseAll.modelCount)}`}
                </button>
              )}
              <button
                type="button"
                className="btn btn--sm"
                popoverTarget={menuId}
                popoverTargetAction="hide"
              >
                Done
              </button>
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * Renders the inside of the picker: a head with how old the catalog is and
 * Refresh, the reason the last read failed when it did, a "Search models"
 * field, and the account's models with a check on each one the profile has.
 * Picking a model calls `onToggle` with its slug, which adds it or takes it
 * out; the popover stays open.
 *
 * - `readAt` is when the catalog was last read, or `null` when it never was.
 * - `readError` is why the last read failed, in the controller's words.
 * - `status` is `loading` while the catalog is read, `failed` when that read
 *   failed (`failure` says why), and `ready` when `models` holds it. `models`
 *   are the ones that match the search, and `hiddenCount` is how many more
 *   match but are not listed.
 */
export function ModelPicker({
  status,
  failure,
  readAt,
  readError,
  models,
  hiddenCount,
  query,
  held,
  refreshing,
  onQueryChange,
  onToggle,
  onRefresh,
}: {
  readonly status: "loading" | "failed" | "ready";
  readonly failure: string | null;
  readonly readAt: string | null;
  readonly readError: string | null;
  readonly models: readonly ModelCatalogItem[];
  readonly hiddenCount: number;
  readonly query: string;
  readonly held: ReadonlySet<string>;
  readonly refreshing: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onToggle: (slug: string) => void;
  readonly onRefresh: () => void;
}): JSX.Element {
  return (
    <>
      <div className="pop-sec">
        <CatalogHead readAt={readAt} refreshing={refreshing} onRefresh={onRefresh} />
        {readError === null ? null : <p className="menu-note pm-error">{readError}</p>}
      </div>
      <div className="pop-sec">
        <input
          className="field menu-filter"
          aria-label="Search models"
          placeholder="Search models"
          // The search is what the user came to the picker for.
          autoFocus
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
          }}
        />
      </div>
      <div className="pop-sec pm-models">
        {status === "loading" ? <p className="menu-note">Reading models…</p> : null}
        {status === "failed" ? <p className="menu-note pm-error">{failure}</p> : null}
        {status === "ready" && models.length === 0 ? (
          <p className="menu-note">
            {query.trim() === "" ? "This account lists no models yet." : "No model matches."}
          </p>
        ) : null}
        {models.map((model) => (
          <MenuLine
            key={model.slug}
            name={model.name}
            detail={model.isLegacy === true ? "older" : null}
            current={held.has(model.slug)}
            multiple
            onPick={() => {
              onToggle(model.slug);
            }}
          />
        ))}
        {hiddenCount > 0 ? (
          <p className="menu-note">{`${hiddenCount} more match. Type a little more.`}</p>
        ) : null}
      </div>
    </>
  );
}
