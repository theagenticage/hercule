import type { JSX } from "react";
import { PuzzleIcon } from "../../icons/puzzle";
import { GitHubMark } from "../../logos/brand-mark";
import { LogoMark } from "../../logos/logo-mark";

/**
 * Renders the mark of a signal's source, `size` CSS pixels square: GitHub's
 * mark for the `github` plugin, a puzzle piece for another plugin, and the
 * logo mark for the core, `null`.
 *
 * A plugin declares no mark of its own yet, so only GitHub, the one plugin
 * the app ships a mark for, gets its brand. The mark is hidden from
 * assistive technology, because the row, the pane and the tabs name the
 * source in words.
 */
export function SourceMark({
  pluginId,
  size,
}: {
  /** The plugin the signal comes from, as `readSignalPluginId` returns it, or `null` for the core. */
  readonly pluginId: string | null;
  readonly size: number;
}): JSX.Element {
  if (pluginId === null) return <LogoMark size={size} />;
  if (pluginId === "github") return <GitHubMark size={size} />;
  return <PuzzleIcon size={size} />;
}
