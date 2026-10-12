import { isIgnoreRuleOffer, parsePluginId, type PluginIdentity } from "@hercule/client-core";
import type { Signal } from "@hercule/contract";
import type { JSX } from "react";
import { Face, HERCULE_LOOK } from "../../faces";
import { LogoMark } from "../../logos/logo-mark";
import { PluginMark } from "../../marks";

/**
 * Renders the mark of a signal's source, `size` CSS pixels square: the logo
 * mark for the core, `null`, or otherwise the plugin's mark as `PluginMark`
 * draws it. The mark is hidden from assistive technology, because the row,
 * the pane and the tabs name the source in words.
 */
export function SourceMark({
  pluginId,
  plugins,
  size,
}: {
  /** The plugin the signal comes from, as `parsePluginId` returns it, or `null` for the core. */
  readonly pluginId: string | null;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly size: number;
}): JSX.Element {
  if (pluginId === null) return <LogoMark size={size} />;
  return <PluginMark pluginId={pluginId} plugins={plugins} size={size} />;
}

/**
 * How much larger than a source's mark Hercule's face is drawn. A face's
 * body fills only part of its square, so at the same size it looks smaller
 * than the logos beside it; at 1.4 times, a 14px mark draws the 20px face
 * the design book draws beside Hercule's offer.
 */
const FACE_SCALE = 1.4;

/**
 * Renders the mark of the signal `signal`, `size` CSS pixels square: its
 * source's mark, as `SourceMark` draws it, except on Hercule's offer of an
 * Ignore Rule, which carries Hercule's face (spec 17 §The list on To do).
 * The face is drawn `FACE_SCALE` times larger and overflows its square on
 * every side, so the row and the line it sits in keep their layout.
 */
export function SignalMark({
  signal,
  plugins,
  size,
}: {
  readonly signal: Signal;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly size: number;
}): JSX.Element {
  if (isIgnoreRuleOffer(signal)) {
    const faceSize = Math.round(size * FACE_SCALE);
    return (
      <span className="signal-face" style={{ margin: (size - faceSize) / 2 }}>
        <Face look={HERCULE_LOOK} pose="idle" size={faceSize} />
      </span>
    );
  }
  return <SourceMark pluginId={parsePluginId(signal.kind)} plugins={plugins} size={size} />;
}
