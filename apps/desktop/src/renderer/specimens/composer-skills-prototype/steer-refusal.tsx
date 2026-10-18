/**
 * PROTOTYPE (#766). Draws the refusal of a Steer through the real error
 * path of the queued input row, without a line of the app's own code. The
 * page's client refuses every request, so `SteerRefusals` makes its Steer
 * call fail with the scene's message for the inputs that have one, and
 * `steerRefusedInputs` presses those inputs' Steer buttons. The row then
 * shows the failure as it shows any failed Steer: a `.queued-error` note
 * under the row, with `role="alert"`.
 */
import { useLayoutEffect, type JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import { FIX_THREAD } from "../thread-fixture";
import { buildSceneInputId } from "./scene-thread";
import type { Scene } from "./scenes";

/** The request a Steer sends: the session and the input it names. */
interface SteerRequest {
  readonly params: { readonly id: string; readonly inputId: string };
}

/**
 * Renders nothing. While mounted, the page's client fails a Steer of an
 * input that `scene` gives a refusal, with that message. A Steer of any
 * other input goes to the client as before.
 */
export function SteerRefusals({ scene }: { readonly scene: Scene }): JSX.Element | null {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { input } = controller.client;
  useLayoutEffect(() => {
    const steer = input.steer;
    const refusals = new Map(
      (scene.queuedInputs ?? []).flatMap((each, index) =>
        each.refusal === undefined ? [] : [[buildSceneInputId(index), each.refusal] as const],
      ),
    );
    const steerOrRefuse = ((request: SteerRequest) => {
      const refusal = refusals.get(request.params.inputId);
      return refusal === undefined ? steer(request) : Promise.reject(new Error(refusal));
    }) as typeof steer;
    // The client is a plain object that this page owns, so replacing its
    // method is safe. `Object.assign` states that to the hooks lint rule.
    Object.assign(input, { steer: steerOrRefuse });
    return () => {
      Object.assign(input, { steer });
    };
  }, [input, scene]);
  return null;
}

/**
 * Presses the Steer button of each queued input that `scene` gives a
 * refusal, and returns once every row shows its error. The rows are in
 * the order of the queue: the thread's own inputs, then the scene's.
 * Fails when a row has no Steer button.
 */
export async function steerRefusedInputs(scene: Scene): Promise<void> {
  const rows = [...document.querySelectorAll<HTMLElement>(".queued")];
  const refused = (scene.queuedInputs ?? []).flatMap((each, index) =>
    each.refusal === undefined ? [] : [rows[FIX_THREAD.queuedInputs.length + index]],
  );
  for (const row of refused) {
    const button = row?.querySelector<HTMLElement>(".queued-steer");
    if (button === null || button === undefined) throw new Error("A refused input has no Steer.");
    button.click();
  }
  while (refused.some((row) => row?.querySelector(".queued-error") === null)) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}
