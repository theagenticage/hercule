/**
 * The Office's keyboard, and the order in which the Office walks through its
 * colleagues:
 *
 * - Escape steps back one level: the thread drawer, then the selected
 *   colleague and its card, then the room.
 * - Tab and Shift+Tab select the next and the previous colleague waiting on
 *   the user, the longest waiting first.
 * - Enter opens the selected colleague's thread in the drawer.
 *
 * The Office reads only keys pressed while the focus is in the Office or on
 * nothing at all, so Tab still moves through the sidebar. Keys typed in a
 * field, such as the drawer's composer, are left alone.
 */
import { useEffect } from "react";
import type { ColleagueState } from "../engine/contracts";
import {
  applyColleagueState,
  readColleagueStates,
  readOffice,
  sendOfficeCommand,
  setOffice,
} from "../office-store";
import type { Colleague, Pose, World } from "../world/types";

/** Returns true when `target`, the keyboard's focus, is a field, where keys type text. */
const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Returns the colleagues of `world` in `pose` now, as `states` holds them:
 * in the world's order, except that waiting colleagues come longest waiting
 * first, as the queue in front of the user's desk.
 */
export function listColleaguesInPose(
  world: World,
  states: ReadonlyMap<string, ColleagueState>,
  pose: Pose,
): ReadonlyArray<Colleague> {
  const found = world.colleagues
    .map((colleague) => applyColleagueState(colleague, states))
    .filter((colleague) => colleague.role !== "triage" && colleague.pose === pose);
  if (pose !== "waiting") return found;
  return found.toSorted(
    (a, b) => (b.request?.waitingMinutes ?? 0) - (a.request?.waitingMinutes ?? 0),
  );
}

/**
 * Returns the id of the colleague `step` places after `currentId` in
 * `colleagues`, wrapping at both ends. When `currentId` is not in the list,
 * a step forward returns the first colleague and a step back the last.
 * Returns null for an empty list.
 */
export function findNextColleagueId(
  colleagues: ReadonlyArray<Colleague>,
  currentId: string | null,
  step: 1 | -1,
): string | null {
  if (colleagues.length === 0) return null;
  const index = colleagues.findIndex((colleague) => colleague.id === currentId);
  const next =
    index === -1
      ? step === 1
        ? 0
        : colleagues.length - 1
      : (index + step + colleagues.length) % colleagues.length;
  return colleagues[next]!.id;
}

/** Returns true when `target` sits inside an element that `selector` matches. */
const isInside = (target: EventTarget | null, selector: string): boolean =>
  target instanceof Element && target.closest(selector) !== null;

/** Listens to the window's keys for as long as the office is mounted. */
export function useOfficeKeys(world: World): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isTyping(event.target)) return;
      if (event.target !== document.body && !isInside(event.target, ".office")) return;
      const state = readOffice();
      switch (event.key) {
        case "Escape": {
          // An open menu closes itself on Escape, and the drawer's request
          // dock reads Escape as Deny: neither is the office's to step back.
          if (document.querySelector(":popover-open") !== null) return;
          if (isInside(event.target, ".dock")) return;
          if (state.drawer) setOffice({ drawer: false });
          else if (state.selectedId !== null) setOffice({ selectedId: null });
          else if (state.roomId !== null) sendOfficeCommand({ kind: "overview" });
          else return;
          break;
        }
        case "Enter": {
          // Enter on a button presses that button.
          if (isInside(event.target, "button, a, [role='switch'], .office-drawer")) return;
          if (state.drawer || state.selectedId === null) return;
          setOffice({ drawer: true });
          break;
        }
        case "Tab": {
          // Tab keeps moving the focus inside the drawer and a menu.
          if (isInside(event.target, ".office-drawer, .pop")) return;
          const waiting = listColleaguesInPose(world, readColleagueStates(), "waiting");
          const nextId = findNextColleagueId(waiting, state.selectedId, event.shiftKey ? -1 : 1);
          if (nextId === null) return;
          sendOfficeCommand({ kind: "focus-colleague", colleagueId: nextId });
          break;
        }
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [world]);
}
