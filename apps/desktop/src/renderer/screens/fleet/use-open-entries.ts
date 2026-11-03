import { useCallback, useState } from "react";

/** What `useOpenEntries` returns. */
export interface OpenEntries {
  /** The keys of the entries the user has unfolded. */
  readonly openKeys: ReadonlySet<string>;
  /** Unfolds the entry with `entryKey`, or folds it again when it is unfolded. */
  readonly toggle: (entryKey: string) => void;
}

/**
 * Keeps which entries of a machine's activity the user has unfolded, by the
 * entry's key. The list that shows the entries owns this, not the entry's
 * line: a virtual list draws a line only while it is near the view, and an
 * entry that scrolls away and back must still be unfolded.
 */
export const useOpenEntries = (): OpenEntries => {
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((entryKey: string): void => {
    setOpenKeys((current) => {
      const next = new Set(current);
      if (!next.delete(entryKey)) next.add(entryKey);
      return next;
    });
  }, []);
  return { openKeys, toggle };
};
