import type { JSX } from "react";
import { FormCard } from "@hercule/ui";
import type { McpServerTool } from "@hercule/contract";
import { CardHeading } from "./-card-heading";

/**
 * The "Tools" card of a server's page: what the server offered when it was
 * last checked, read only. Agents get every tool, so there is nothing to
 * switch off here.
 */
export function Tools({ tools }: { readonly tools: readonly McpServerTool[] }): JSX.Element {
  return (
    <FormCard label={<CardHeading title="Tools" aside={String(tools.length)} />}>
      <p className="text-fine text-faint">
        What the server offered when it was last checked. Agents get all of them: a tool cannot be
        switched off here.
      </p>
      {tools.length === 0 ? (
        <p className="text-fine text-faint">The tools show here once the check is done.</p>
      ) : (
        <ul className="flex flex-col">
          {tools.map((tool) => (
            <li
              key={tool.name}
              className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 border-t border-line-soft py-1.5 text-fine first:border-t-0"
            >
              <code className="font-mono break-words text-ink">{tool.name}</code>
              <span className="text-muted">{tool.description}</span>
            </li>
          ))}
        </ul>
      )}
    </FormCard>
  );
}
