import type { JSX } from "react";
import { useAgeWords } from "../../../app/age-clock";
import { joinClassNames } from "./join-class-names";
import "../../thread/menus.css";

/** Renders "Updated 3 hours ago", from the time of the last good read of the catalog. */
function CatalogAge({ readAt }: { readonly readAt: string }): JSX.Element {
  return <span>{`Updated ${useAgeWords(readAt, true)}`}</span>;
}

/**
 * Renders how old an account's Model Catalog is and its Refresh button, as
 * one line: "Updated 3 hours ago · Refresh", or "Not read yet · Refresh" when
 * `readAt` is `null`. Both the picker and the model browser start with it.
 * `refreshing` turns the button into "Refreshing…" and disables it.
 *
 * The age text changes through the age clock, which sets a timer only for
 * the moment a label on screen next changes.
 */
export function CatalogHead({
  readAt,
  refreshing,
  className,
  onRefresh,
}: {
  readonly readAt: string | null;
  readonly refreshing: boolean;
  readonly className?: string;
  readonly onRefresh: () => void;
}): JSX.Element {
  return (
    <div className={joinClassNames("q-h", className)}>
      {readAt === null ? <span>Not read yet</span> : <CatalogAge readAt={readAt} />}
      <span aria-hidden="true">·</span>
      <button type="button" className="link" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
