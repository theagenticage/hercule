import { useEffect, useEffectEvent, useId, useRef, useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describePose, isAbsentPose, type SessionTab } from "@hercule/client-core";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { Mark } from "../../marks";
import { AgentLabel, StatusSlot } from "../session-status";
import { usePopoverMenu } from "../use-popover-menu";
import "./menus.css";
import "./tab-overflow-menu.css";

/**
 * Renders the "+n" button at the end of a header's tabs, and the menu it
 * opens. `tabs` are the tabs that did not fit in the header, in start order,
 * and the menu lists exactly those. `openId` is the id of the open session,
 * whose row, if it is in the list, is drawn as the current one.
 *
 * - The button carries `data-tab-overflow`, which the header's fitting finds
 *   it by (`useTabOverflow`).
 * - While a hidden tab waits on the user, the button starts with the waiting
 *   mark, so a question never hides without a sign.
 * - With no tab in `tabs` the button is drawn as "+1", out of flow and
 *   invisible, so the fitting can measure the room it needs. It takes no
 *   focus and is hidden from assistive technology then.
 * - The menu is a popover, opened and stepped through as `usePopoverMenu`
 *   describes. Taking a row closes the menu and opens that session.
 * - The rows' ages run on the age clock only while the menu is open.
 * - When the list of tabs changes while the menu is open, the menu closes,
 *   because the row the focus was on may be gone. The focus goes back to the
 *   button, or, when the button is no longer shown, to the open tab.
 */
export function TabOverflowMenu({
  tabs,
  openId,
}: {
  readonly tabs: readonly SessionTab[];
  readonly openId: string | null;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  const headingId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const idle = tabs.length === 0;
  const count = tabs.length;
  const hasWaiting = tabs.some((tab) => tab.pose === "waiting");
  const hiddenIds = tabs.map((tab) => tab.sessionId).join(" ");

  const closeForNewList = useEffectEvent(() => {
    if (!open) return;
    close();
    const focused = document.activeElement;
    const menu = menuProps.ref.current;
    const focusLost = focused === null || focused === document.body || menu?.contains(focused);
    if (!focusLost) return;
    const button = buttonRef.current;
    const target = idle
      ? button
          ?.closest("nav")
          ?.querySelector<HTMLElement>('[data-tab][aria-current="page"], [data-tab].is-on')
      : button;
    target?.focus({ preventScroll: true });
  });
  useEffect(() => {
    closeForNewList();
  }, [hiddenIds]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={idle ? "ptab tab-overflow is-idle" : "ptab tab-overflow"}
        data-tab-overflow=""
        {...triggerProps}
        aria-expanded={open}
        aria-label={`${count} more ${count === 1 ? "thread" : "threads"}`}
        {...(idle ? { "aria-hidden": true, tabIndex: -1 } : {})}
      >
        {hasWaiting ? <Mark state="waiting" /> : null}
        <span>+{idle ? 1 : count}</span>
        <span className="tab-overflow-chevron">
          <ChevronRightIcon size={12} />
        </span>
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        aria-labelledby={headingId}
        className="pop popover-menu tab-overflow-menu"
        onToggle={(event) => {
          menuProps.onToggle(event);
          setOpen(event.newState === "open");
        }}
      >
        <div className="tab-overflow-heading" id={headingId}>
          {count} more
        </div>
        {tabs.map((tab) => (
          <TabOverflowRow
            key={tab.sessionId}
            tab={tab}
            current={tab.sessionId === openId}
            onScreen={open}
            itemProps={buildItemProps(tab.sessionId)}
            onTake={close}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Renders one hidden tab as a row of the menu: its mark, its label, its
 * agent and its state, as a link to the session.
 *
 * The row is named "<label>, <title>, <state words>", or "<title>, <state
 * words>" when the label is the title because the session has no role. A
 * Thread marked Done reads "done". The title is also the row's tooltip. A
 * title-only label is drawn lighter than a role.
 */
function TabOverflowRow({
  tab,
  current,
  onScreen,
  itemProps,
  onTake,
}: {
  readonly tab: SessionTab;
  readonly current: boolean;
  readonly onScreen: boolean;
  /** What `usePopoverMenu` returns for this row. */
  readonly itemProps: ReturnType<ReturnType<typeof usePopoverMenu>["buildItemProps"]>;
  readonly onTake: () => void;
}): JSX.Element {
  const statusId = useId();
  const titleOnly = tab.label === tab.title;
  const state = tab.done ? "done" : describePose(tab.pose);
  const classes = [
    "tab-overflow-row",
    itemProps.className,
    current ? "is-current" : undefined,
  ].filter((name) => name !== undefined);
  return (
    <Link
      to="/threads/$sessionId"
      params={{ sessionId: tab.sessionId }}
      {...itemProps}
      className={classes.join(" ")}
      title={tab.title}
      aria-label={titleOnly ? `${tab.title}, ${state}` : `${tab.label}, ${tab.title}, ${state}`}
      aria-describedby={statusId}
      onClick={onTake}
    >
      {tab.done ? (
        <Mark state="done" />
      ) : isAbsentPose(tab.pose) ? (
        <span className="tab-overflow-no-mark" />
      ) : (
        <Mark state={tab.pose} />
      )}
      <span className={titleOnly ? "tab-overflow-name is-title" : "tab-overflow-name"}>
        {tab.label}
      </span>
      <AgentLabel providerId={tab.providerId} model={tab.model} />
      <StatusSlot
        id={statusId}
        status={tab.status}
        activityAt={tab.activityAt}
        onScreen={onScreen}
      />
    </Link>
  );
}
