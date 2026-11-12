import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { InboxClause } from "@hercule/client-core/inbox";
import { ChevronLeftIcon } from "../../icons/chevron-left";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { PluginMark } from "../../marks/plugin-mark";
import "./inbox-narrow-menu.css";

/** One value of a facet, with how many things of the list hold it. */
export interface NarrowValue {
  /** What the clause matches: the value or its ref. */
  readonly value: string;
  /** What the menu shows. */
  readonly label: string;
  readonly count: number;
}

/**
 * One facet of what the list holds, of one source and one account: the field
 * a Narrow pick filters on, and the values the list holds for it.
 */
export interface NarrowFacet {
  /** The source's plugin id, such as `linear`. */
  readonly source: string;
  /** The source's name, as the menu's group heading shows it. */
  readonly sourceName: string;
  readonly connectionId?: string;
  /** The field the clause filters on. */
  readonly key: string;
  /** The field's name, such as "Project". */
  readonly label: string;
  readonly values: ReadonlyArray<NarrowValue>;
}

/** The menu's width, in pixels. */
const WIDTH = 280;

/** The gap between the menu and its button, in pixels. */
const GAP = 6;

/** The gap the menu keeps to the window's edges, in pixels. */
const WINDOW_MARGIN = 8;

/** Returns the words that name a facet beside its source, such as "Linear project": the back row's text and the facet row's name for assistive technology. */
const describeFacet = (facet: NarrowFacet): string =>
  `${facet.sourceName} ${facet.label.toLowerCase()}`;

/**
 * Renders Narrow, the menu over what the list holds, as a popover anchored to
 * the Narrow button `anchor`. The parent renders it only while it is open and
 * removes it when `onPick` or `onClose` is called.
 *
 * - `facets` are the facets of the first page of results, one per source and
 *   account. The menu groups them by source, in the order given, so a source
 *   that holds nothing is not there. A facet opens its values with their
 *   counts, under a back row.
 * - A pick calls `onPick` with a clause tied to its source and account, which
 *   the caller adds to the search. The clause matches the value only for that
 *   source's things.
 * - The open menu owns the keyboard: the arrow keys move, Return picks, Esc
 *   calls `onClose` and Tab leaves. No key reaches the page behind it. A press
 *   outside the menu and the button calls `onClose` too.
 * - `plugins` draws the mark of each source.
 *
 * It gives the focus to its first row and gives it back to `anchor` when it
 * goes. It is placed under `anchor`, its right edges level with the button's.
 */
export function InboxNarrowMenu({
  facets,
  plugins,
  anchor,
  onPick,
  onClose,
}: {
  readonly facets: ReadonlyArray<NarrowFacet>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly anchor: HTMLElement;
  readonly onPick: (clause: InboxClause) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<NarrowFacet | null>(null);
  const [active, setActive] = useState(0);

  // Opening a facet or going back puts the focus on the first row of the new list.
  const show = (facet: NarrowFacet | null): void => {
    setOpened(facet);
    setActive(0);
  };

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    menu.showPopover();
    const button = anchor.getBoundingClientRect();
    menu.style.left = `${String(Math.max(WINDOW_MARGIN, button.right - WIDTH))}px`;
    menu.style.top = `${String(button.bottom + GAP)}px`;
    // A short window scrolls the menu instead of cutting it.
    menu.style.maxHeight = `${String(Math.min(420, window.innerHeight - button.bottom - 18))}px`;
    return () => {
      anchor.focus({ preventScroll: true });
    };
  }, [anchor]);

  // The row that is active has the focus, so Return and a screen reader both act on it.
  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLElement>(`[data-row="${String(active)}"]`)?.focus({
      preventScroll: true,
    });
  }, [active, opened]);

  useEffect(() => {
    const close = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
    };
  }, [anchor, onClose]);

  const pick = (facet: NarrowFacet, value: NarrowValue): void => {
    const clause: InboxClause = {
      key: facet.key,
      op: "is",
      value: value.value,
      source: facet.source,
    };
    onPick(
      facet.connectionId === undefined ? clause : { ...clause, connectionId: facet.connectionId },
    );
  };

  // The facets in the order they are drawn: grouped by source.
  const sources = [...new Set(facets.map((facet) => facet.source))];
  const drawn = sources.flatMap((source) => facets.filter((facet) => facet.source === source));

  // What each row does, in the order it is drawn.
  const actions: Array<() => void> =
    opened === null
      ? drawn.map((facet) => () => {
          show(facet);
        })
      : [
          () => {
            show(null);
          },
          ...opened.values.map((value) => () => {
            pick(opened, value);
          }),
        ];

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The menu owns the keyboard: the page behind it never sees a key.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : actions.length - 1;
      setActive((active + step) % Math.max(actions.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      actions[active]?.();
    }
  };

  return (
    <div
      ref={menuRef}
      popover="manual"
      role="menu"
      aria-label="Narrow what the list holds"
      className="ib-narrow"
      onKeyDown={handleKeyDown}
    >
      {opened === null ? (
        <>
          <p className="ib-narrow-heading">Narrow what the list holds</p>
          {sources.map((source) => {
            const own = facets.filter((facet) => facet.source === source);
            return (
              <div key={source} role="group" aria-label={own[0]!.sourceName}>
                <p className="ib-narrow-source" aria-hidden="true">
                  <PluginMark pluginId={source} plugins={plugins} size={12} />
                  {own[0]!.sourceName}
                </p>
                {own.map((facet) => {
                  const row = drawn.indexOf(facet);
                  return (
                    <NarrowRow
                      key={`${facet.connectionId ?? ""}:${facet.key}`}
                      index={row}
                      active={row === active}
                      label={describeFacet(facet)}
                      onActivate={actions[row]!}
                      onHover={setActive}
                    >
                      <span>{facet.label}</span>
                      <ChevronRightIcon size={12} />
                    </NarrowRow>
                  );
                })}
              </div>
            );
          })}
        </>
      ) : (
        <>
          <NarrowRow
            index={0}
            active={active === 0}
            back
            onActivate={actions[0]!}
            onHover={setActive}
          >
            <ChevronLeftIcon size={12} />
            <span>{describeFacet(opened)}</span>
          </NarrowRow>
          <i className="ib-narrow-line" />
          {opened.values.map((value, index) => (
            <NarrowRow
              key={value.value}
              index={index + 1}
              active={index + 1 === active}
              onActivate={actions[index + 1]!}
              onHover={setActive}
            >
              <span>{value.label}</span>
              <small>{value.count.toLocaleString("en-US")}</small>
            </NarrowRow>
          ))}
        </>
      )}
    </div>
  );
}

/** Renders one row of the menu: a button the arrow keys reach by moving the focus to it. */
function NarrowRow({
  index,
  active,
  back,
  label,
  onActivate,
  onHover,
  children,
}: {
  readonly index: number;
  readonly active: boolean;
  readonly back?: boolean;
  readonly label?: string;
  readonly onActivate: () => void;
  readonly onHover: (index: number) => void;
  readonly children: JSX.Element[] | JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="ib-narrow-row"
      data-row={index}
      data-active={active ? "" : undefined}
      data-back={back === true ? "" : undefined}
      aria-label={label}
      onPointerEnter={() => {
        onHover(index);
      }}
      onClick={onActivate}
    >
      {children}
    </button>
  );
}
