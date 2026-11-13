import type { PluginIdentity } from "@hercule/client-core";
import type { JSX } from "react";
import { PluginMark } from "../../marks";
import "./inbox-pane-head.css";

/**
 * Renders what the open thing came from, for the pane's head: the source's
 * mark and the words that name it, "GitHub · Pull request · storefront-web".
 * `parts` are those words in order. The account is not here: the meta line
 * under the title says it ("in <account>") when the source has several.
 */
export function InboxPaneHead({
  pluginId,
  plugins,
  parts,
}: {
  readonly pluginId: string;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly parts: ReadonlyArray<string>;
}): JSX.Element {
  return (
    <p className="ib-pane-source">
      <span className="ib-pane-source-mark">
        <PluginMark pluginId={pluginId} plugins={plugins} size={14} />
      </span>
      <span className="ib-pane-source-words">{parts.join(" · ")}</span>
    </p>
  );
}
