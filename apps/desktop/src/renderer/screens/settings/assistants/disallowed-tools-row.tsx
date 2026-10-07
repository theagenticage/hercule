import type { JSX } from "react";
import { TOOL_FAMILIES, type DisallowedTool } from "@hercule/contract";
import { CloseIcon } from "../../../icons/close";
import { ComposeIcon } from "../../../icons/compose";
import { FileIcon } from "../../../icons/file";
import { GlobeIcon } from "../../../icons/globe";
import { PlusIcon } from "../../../icons/plus";
import { SearchIcon } from "../../../icons/search";
import { TerminalIcon } from "../../../icons/terminal";
import type { IconProps } from "../../../icons/icon-frame";
import { SettingRow } from "../setting-row";
import "./disallowed-tools-row.css";

/** The icon each tool family's chip draws before its name. */
const FAMILY_ICONS: { readonly [Family in DisallowedTool]: (props: IconProps) => JSX.Element } = {
  edit: FileIcon,
  write: ComposeIcon,
  shell: TerminalIcon,
  "web-search": SearchIcon,
  "web-fetch": GlobeIcon,
};

/**
 * Renders the Disallowed tools row of an assistant (spec 17 §Settings,
 * Assistants): one chip per tool family its sessions may never use, each
 * with an × that removes it, and Add, which offers the families not chosen
 * yet. Add is hidden once all five are chosen, because it would offer
 * nothing.
 *
 * Every change calls `onChange` with the family and whether it is now
 * disallowed. When `unenforced`
 * is true, the assistant's provider ignores the list, and the hint says so.
 */
export function DisallowedToolsRow({
  assistantName,
  tools,
  unenforced,
  error,
  onChange,
}: {
  readonly assistantName: string;
  readonly tools: readonly DisallowedTool[];
  readonly unenforced: boolean;
  readonly error: string | null;
  readonly onChange: (family: DisallowedTool, disallowed: boolean) => void;
}): JSX.Element {
  const missing = TOOL_FAMILIES.filter((family) => !tools.includes(family));
  const hint =
    `Tools ${assistantName}’s sessions may never use.` +
    (unenforced ? " Its provider does not enforce this list, so they stay available." : "");
  return (
    <SettingRow
      label="Disallowed tools"
      hint={hint}
      error={error}
      control={(labels) => (
        <div className="disallowed-tools" role="group" {...labels}>
          {tools.map((family) => {
            const Icon = FAMILY_ICONS[family];
            return (
              <span key={family} className="chip">
                <Icon size={12} />
                {family}
                <button
                  type="button"
                  aria-label={`Remove ${family}`}
                  onClick={() => {
                    onChange(family, false);
                  }}
                >
                  <CloseIcon size={12} />
                </button>
              </span>
            );
          })}
          {missing.length > 0 && (
            <span className="btn btn--quiet btn--sm disallowed-tools-add">
              <PlusIcon size={13} />
              Add
              <select
                aria-label="Add a disallowed tool"
                value=""
                onChange={(event) => {
                  const family = missing.find((tool) => tool === event.target.value);
                  if (family !== undefined) onChange(family, true);
                }}
              >
                <option value="" disabled hidden>
                  Add
                </option>
                {missing.map((family) => (
                  <option key={family} value={family}>
                    {family}
                  </option>
                ))}
              </select>
            </span>
          )}
        </div>
      )}
    />
  );
}
