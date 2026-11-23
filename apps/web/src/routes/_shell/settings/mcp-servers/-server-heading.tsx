import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { PluginDetail } from "@hercule/contract";
import {
  describeServerPageFields,
  describeSourceChip,
  type McpServerView,
} from "@hercule/client-core/mcp-servers";
import { McpServerMark } from "../../../../screens/mcp-server-mark";

const CHIP_CLASS = "rounded-full border border-line px-2 py-0.5 text-fine text-muted";

/**
 * The top of a server's page: the link back to the list, the server's mark
 * and name with the account its Connection is signed in as, and two chips:
 * where the server comes from, and its address. Which chips and which account
 * show is decided in client-core, as on the desktop.
 */
export function ServerHeading({
  view,
  plugins,
}: {
  readonly view: McpServerView;
  readonly plugins: readonly PluginDetail[];
}): JSX.Element {
  const { address, account } = describeServerPageFields(view, plugins);
  const pluginName = plugins.find((plugin) => plugin.id === view.pluginId)?.displayName;
  return (
    <>
      <Link to="/settings/mcp-servers" className="text-fine text-muted hover:text-ink">
        ← MCP servers
      </Link>

      <div className="flex flex-col gap-2.5">
        <h2 className="flex items-center gap-2.5 text-[17px] font-emph tracking-[-0.01em] text-ink">
          <McpServerMark view={view} plugins={plugins} className="size-5" />
          <span>
            {view.server.name}
            {account === null ? null : (
              <>
                {" "}
                <span className="text-row font-normal text-muted">{account}</span>
              </>
            )}
          </span>
        </h2>
        <div className="flex flex-wrap gap-1.5">
          <span className={CHIP_CLASS}>{describeSourceChip(view, pluginName)}</span>
          {address === null ? null : <span className={CHIP_CLASS}>{address}</span>}
        </div>
      </div>
    </>
  );
}
