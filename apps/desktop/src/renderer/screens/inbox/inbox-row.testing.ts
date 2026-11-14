import type { PluginIdentity } from "@hercule/client-core";
import type { InboxRowView } from "@hercule/client-core/inbox";
import type { InboxRowActions } from "./inbox-row";

/** The plugins the tests' rows draw their marks from. */
export const TEST_PLUGINS: ReadonlyArray<PluginIdentity> = [
  { id: "github", displayName: "GitHub" },
];

/** Builds a row for a test: a review request that has waited five days, with the parts overridden by `overrides`. */
export const buildInboxRowView = (
  ref: string,
  overrides: Partial<InboxRowView> = {},
): InboxRowView => ({
  ref,
  title: `Title of ${ref}`,
  pluginId: "github",
  time: { kind: "wait", text: "5d", tone: "over", words: "Waiting 5 days, overdue" },
  reason: { who: "Mei", rest: "asked for your review", more: 0, quiet: false },
  place: "storefront-web",
  identifier: "#6244",
  label: `Title of ${ref}. Mei asked for your review`,
  handOff: null,
  isOnTask: false,
  ...overrides,
});

/** Builds the row callbacks for a test, each one recording what it was called with. */
export const buildInboxRowActions = (): InboxRowActions & {
  readonly calls: Array<readonly [string, string]>;
} => {
  const calls: Array<readonly [string, string]> = [];
  const record = (name: string) => (ref: string) => {
    calls.push([name, ref]);
  };
  return {
    calls,
    onPick: (ref, modifiers) => {
      calls.push([modifiers.shiftKey ? "pick-shift" : "pick", ref]);
    },
    onToggleSelect: record("toggle"),
    onStartThread: record("start"),
    onTakeOn: record("take"),
    onHandOff: record("hand"),
    onGoToTask: record("goto"),
    onDismiss: record("dismiss"),
  };
};
