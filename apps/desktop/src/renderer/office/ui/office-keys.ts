/**
 * The Office's keyboard, and the order in which the Office walks through its
 * colleagues:
 *
 * - Escape steps back one level: the thread drawer, then the selected
 *   colleague and its card, then the room.
 * - Tab and Shift+Tab select the next and the previous colleague waiting on
 *   the user, the longest waiting first.
 * - Enter opens the selected colleague's thread in the drawer.
 * - Q and E turn the camera 45 degrees, = and - zoom it, and F finds the
 *   followed colleague again. These keys are left alone in the thread
 *   drawer, which is the thread screen and has keys of its own.
 *
 * The Office reads only keys pressed while the focus is in the Office or on
 * nothing at all, so Tab still moves through the sidebar. Keys typed in a
 * field, such as the drawer's composer, are left alone, and so is a key
 * another handler already used.
 */
import { useEffect } from "react";
import type { ColleagueState } from "../engine/contracts";
import {
  applyColleagueState,
  readColleagueStates,
  readOffice,
  sendOfficeCommand,
  setOffice,
  type OfficeCommand,
} from "../office-store";
import type { Pose } from "@hercule/client-core";
import type { Colleague, World } from "../world/types";

/** Returns true when `target`, the keyboard's focus, is a field, where keys type text. */
const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Returns the colleagues of `world` in `pose` now, as `states` holds them,
 * in the world's order. Waiting colleagues come in the order of the world's
 * queue at the user's desk, the longest waiting first. A colleague the sim
 * shows waiting before the world queues it comes last.
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
  const places = new Map(world.queue.map((id, place) => [id, place]));
  const findPlace = (colleague: Colleague): number => places.get(colleague.id) ?? places.size;
  return found.toSorted((a, b) => findPlace(a) - findPlace(b));
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

/** Returns the camera command a key asks for, or null for a key that moves no camera. */
function decideCameraCommand(key: string): OfficeCommand | null {
  switch (key) {
    case "q":
    case "Q":
      return { kind: "turn-camera", degrees: -45 };
    case "e":
    case "E":
      return { kind: "turn-camera", degrees: 45 };
    case "=":
    case "+":
      return { kind: "zoom-camera", direction: "in" };
    case "-":
    case "_":
      return { kind: "zoom-camera", direction: "out" };
    case "f":
    case "F":
      return { kind: "resume-follow" };
    default:
      return null;
  }
}

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
          setOffice({ selectedId: nextId });
          break;
        }
        default: {
          const command = decideCameraCommand(event.key);
          if (command === null || isInside(event.target, ".office-drawer")) return;
          sendOfficeCommand(command);
          break;
        }
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [world]);
}
