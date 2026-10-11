/**
 * Which of its two faces the sidebar shows: `threads`, the user's threads
 * and assistants, or `orchestration`, the places of Hercule itself, which
 * the switch labels "Hercule" (spec 17 §The Hercule face).
 */
export type SidebarFace = "threads" | "orchestration";

/**
 * Returns the face the screen at `pathname` shows, or `null` when the screen
 * keeps the face that was showing.
 *
 * - A thread, the new-thread screen and an assistant's Conversation show the
 *   threads face.
 * - Intake shows the orchestration face, where its row is.
 * - The Office and Settings keep the face, because their ways in sit on both
 *   faces: the Office in the shared row, Settings at the foot. So nothing on
 *   the sidebar moves when one of them opens.
 */
export const decideScreenFace = (pathname: string): SidebarFace | null => {
  if (pathname === "/" || pathname.startsWith("/threads/") || pathname.startsWith("/assistants/")) {
    return "threads";
  }
  return pathname === "/intake" ? "orchestration" : null;
};
