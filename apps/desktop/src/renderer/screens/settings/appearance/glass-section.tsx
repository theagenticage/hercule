import { useEffect, useEffectEvent, useRef, type JSX } from "react";
import { Mark } from "../../../marks";
import { ProjectTile } from "../../project-tile";
import { SettingRow } from "../setting-row";
// The demo draws real surfaces of the session and thread screens, so it
// takes their styles on purpose.
import "../../session/messages.css";
import "../../thread/thread-header.css";
import "./appearance.css";

/**
 * Renders the Glass section of Settings > Appearance: a demo of a session
 * under a header pill and the composer, the Glass slider, and the Reduce
 * transparency switch.
 *
 * - The slider is named "Glass" and runs from 0 to 100. Each step calls
 *   `onGlassInput`. `onGlassCommit` is called with the level it ends on:
 *   when a drag is let go, when an arrow key or the like is released, or
 *   when the slider loses focus with a key step not yet committed.
 * - The switch is named "Reduce transparency" and calls
 *   `onReduceTransparencyToggle`. While `systemReducesTransparency` is true,
 *   macOS's own Reduce transparency is on: the switch shows as on and is
 *   disabled, because turning it off would change nothing.
 */
export function GlassSection({
  glassPercent,
  reduceTransparency,
  systemReducesTransparency,
  onGlassInput,
  onGlassCommit,
  onReduceTransparencyToggle,
}: {
  readonly glassPercent: number;
  readonly reduceTransparency: boolean;
  readonly systemReducesTransparency: boolean;
  readonly onGlassInput: (percent: number) => void;
  readonly onGlassCommit: (percent: number) => void;
  readonly onReduceTransparencyToggle: () => void;
}): JSX.Element {
  const sliderRef = useRef<HTMLInputElement>(null);
  const commitGlass = useEffectEvent(onGlassCommit);
  useEffect(() => {
    const slider = sliderRef.current!;
    // True from a key that moves the slider until the level it moved to is
    // committed. The native `change` event fires once when a drag ends, but
    // also on every key press, so key steps commit on `keyup` instead: one
    // commit when an arrow key is held down. `blur` commits too, because the
    // keyup of Tab lands on the next element.
    let pending = false;
    const commit = (): void => {
      commitGlass(Number(slider.value));
    };
    const commitDrag = (): void => {
      if (!pending) commit();
    };
    const holdKeyStep = (event: KeyboardEvent): void => {
      if (SLIDER_KEYS.has(event.key)) pending = true;
    };
    const commitKeyStep = (): void => {
      if (!pending) return;
      pending = false;
      commit();
    };
    slider.addEventListener("change", commitDrag);
    slider.addEventListener("keydown", holdKeyStep);
    slider.addEventListener("keyup", commitKeyStep);
    slider.addEventListener("blur", commitKeyStep);
    return () => {
      slider.removeEventListener("change", commitDrag);
      slider.removeEventListener("keydown", holdKeyStep);
      slider.removeEventListener("keyup", commitKeyStep);
      slider.removeEventListener("blur", commitKeyStep);
    };
  }, []);
  return (
    <section className="set-sec">
      <h2>Glass</h2>
      <p>
        The header, the composer, menus and sheets float over the page. Glass sets how much of the
        page shows through them.
      </p>
      <GlassDemo />
      <SettingRow
        label="Glass"
        hint="0% is fully solid. Text on glass always stays readable."
        control={(labels) => (
          <>
            <input
              className="range"
              type="range"
              min={0}
              max={100}
              value={glassPercent}
              aria-valuetext={`${glassPercent}%`}
              {...labels}
              // React calls onChange on every `input` event, so it shows each
              // step. Only the effect above commits a level.
              onChange={(event) => {
                onGlassInput(Number(event.target.value));
              }}
              ref={sliderRef}
            />
            <output className="range-out" aria-hidden="true">
              {/* One text node, as the book writes it: two would be shaped
                  apart, and the digits would sit a fraction of a pixel off. */}
              {`${glassPercent}%`}
            </output>
          </>
        )}
      />
      <SettingRow
        label="Reduce transparency"
        hint={
          systemReducesTransparency
            ? "macOS has Reduce transparency on, so every floating layer is already solid. Turn it off in System Settings to use the Glass level."
            : "Makes every floating layer solid, whatever the Glass level. Follows the macOS setting."
        }
        control={(labels) => (
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={reduceTransparency || systemReducesTransparency}
            disabled={systemReducesTransparency}
            {...labels}
            onClick={onReduceTransparencyToggle}
          />
        )}
      />
    </section>
  );
}

/** The keys that move a range input, each a step the slider commits on keyup. */
const SLIDER_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

/**
 * Renders the book's demo: a few lines of a session, with the thread
 * header's pill over its top and the composer over its bottom, both glass.
 * The glass surfaces take the page's Glass level, so the demo changes as the
 * slider moves. It is a picture, hidden from assistive technology.
 */
function GlassDemo(): JSX.Element {
  return (
    <div className="glass-demo" aria-hidden="true">
      <div className="gd-page">
        <p>
          Found it. Stripe now returns <code>requires_action</code>.
        </p>
        <pre className="codeblock">
          <span className="k">if</span>
          {" (result.status === "}
          <span className="s">"requires_action"</span>
          {") {\n  "}
          <span className="k">return</span> <span className="f">openThreeDSModal</span>
          {"(result.clientSecret);\n}"}
        </pre>
        <p>Tests pass. Ready to push the branch and open a pull request.</p>
      </div>
      <span className="pill gd-pill">
        <span className="pill-crumb">
          <ProjectTile tint="webshop" name="webshop" />
        </span>
        <span className="ptab is-on">
          <Mark state="waiting" />
          {"Fix 3\u2011D Secure checkout for EU cards"}
        </span>
      </span>
      <span className="gd-comp">Reply or steer…</span>
    </div>
  );
}
