/**
 * PROTOTYPE (#766). Draws the refusal of a Steer through the real error
 * path of the queued input row, without a line of the app's own code.
 * `buildSteerAnswer` answers the Steer request of an input that a scene
 * gives a refusal with the controller's `invalid_state` error, so the row
 * shows the failure as it shows any failed Steer: a `.queued-error` note
 * under the row, with `role="alert"`. `steerRefusedInputs` presses those
 * inputs' Steer buttons.
 */
import type { FetchLike } from "@hercule/client-core";
import { buildSceneInputId } from "./scene-thread";
import type { Scene } from "./scenes";

/** The most animation frames `steerRefusedInputs` waits for the rows to show their errors. */
const MAX_WAIT_FRAMES = 120;

/** Returns the refusal message of each input of `scene` that has one, by the input's id. */
const readRefusals = (scene: Scene): Map<string, string> =>
  new Map(
    (scene.queuedInputs ?? []).flatMap((each, index) =>
      each.refusal === undefined ? [] : [[buildSceneInputId(index), each.refusal] as const],
    ),
  );

/**
 * Returns the answer to the Steer request of `scene`'s inputs: the
 * controller's `invalid_state` error with the input's refusal message. A
 * Steer of an input with no refusal is refused as any other request is.
 */
export const buildSteerAnswer = (scene: Scene): FetchLike => {
  const refusals = readRefusals(scene);
  return (url) => {
    const inputId = url.split("/").at(-2) ?? "";
    const message = refusals.get(inputId);
    if (message === undefined) {
      return Promise.reject(new Error(`The scene gives the Steer of input ${inputId} no refusal.`));
    }
    return Promise.resolve(
      Response.json({ error: { code: "invalid_state", message } }, { status: 409 }),
    );
  };
};

/**
 * Presses the Steer button of each queued input that `scene` gives a
 * refusal, and returns once every row shows its error. Finds each row by
 * the text of its input. Fails when a row has no Steer button, or when the
 * errors do not show within `MAX_WAIT_FRAMES` frames.
 */
export async function steerRefusedInputs(scene: Scene): Promise<void> {
  const texts = (scene.queuedInputs ?? []).flatMap((each) =>
    each.refusal === undefined ? [] : [each.text],
  );
  const rows = texts.map((text) => {
    const row = [...document.querySelectorAll<HTMLElement>(".queued")].find(
      (each) => each.querySelector(".queued-text")?.getAttribute("title") === text,
    );
    if (row === undefined) throw new Error(`No queued input shows the text "${text}".`);
    return row;
  });
  for (const row of rows) {
    const button = row.querySelector<HTMLElement>(".queued-steer");
    if (button === null) throw new Error("A refused input has no Steer.");
    button.click();
  }
  for (let frame = 0; rows.some((row) => row.querySelector(".queued-error") === null); frame += 1) {
    if (frame === MAX_WAIT_FRAMES) {
      throw new Error(`A refused input did not show its error within ${MAX_WAIT_FRAMES} frames.`);
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}
