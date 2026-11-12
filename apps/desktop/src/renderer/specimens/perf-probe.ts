/**
 * The counters of the counts check's page (perf-counts.tsx): how many
 * components React rendered, and which timers and animation frames are
 * pending. The page imports this module first, so it runs before React and
 * the app load.
 *
 * Renders are counted through the hook React DevTools uses. React calls the
 * hook's `onCommitFiberRoot` after every commit, in development and in
 * production builds alike. The probe then walks the committed tree the way
 * DevTools does: a subtree whose children are the same objects as before was
 * not rendered, so the walk skips it, and a component counts as rendered when
 * it mounted or its fiber carries React's `PerformedWork` flag.
 */
import type { ProbeReading } from "./perf-counts-page";

/** React's fiber tags of the components that render: function, class, forwardRef, memo and simple memo. */
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);

/** React's flag on a fiber whose component ran in the commit. */
const PERFORMED_WORK = 0b1;

/** The fields of a React fiber the probe reads. React does not export the type. */
interface Fiber {
  readonly tag: number;
  readonly flags: number;
  readonly type: unknown;
  readonly alternate: Fiber | null;
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
}

/** Returns the name a component has in the source, or `"anonymous"`. */
function readComponentName(type: unknown): string {
  if (typeof type === "function") return (type as { name?: string }).name || "anonymous";
  if (typeof type === "object" && type !== null) {
    // memo() and forwardRef() keep the component in `type` and `render`.
    const inner =
      (type as { type?: unknown; render?: unknown }).type ?? (type as { render?: unknown }).render;
    const named = (type as { displayName?: string }).displayName;
    return named ?? readComponentName(inner);
  }
  return "anonymous";
}

/** How many times each component rendered since the counters were last reset, by name. */
const renders = new Map<string, number>();

/**
 * Adds the components of `fiber`'s subtree that rendered in this commit to
 * `renders`. `previous` is the fiber the subtree replaced, `null` when it mounted.
 */
function countRenders(fiber: Fiber, previous: Fiber | null): void {
  if (
    COMPONENT_TAGS.has(fiber.tag) &&
    (previous === null || (fiber.flags & PERFORMED_WORK) !== 0)
  ) {
    const name = readComponentName(fiber.type);
    renders.set(name, (renders.get(name) ?? 0) + 1);
  }
  // React reuses a subtree it did not render: its first child is the same object as before.
  if (previous !== null && fiber.child === previous.child) return;
  for (let child = fiber.child; child !== null; child = child.sibling) {
    countRenders(child, child.alternate);
  }
}

let nextRendererId = 1;
Object.defineProperty(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
  value: {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => nextRendererId++,
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      const { current } = root;
      countRenders(current, current.alternate);
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    checkDCE: () => undefined,
  },
});

/** A pending timer or animation frame, as the probe tracks it. */
interface PendingTimer {
  readonly kind: "interval" | "timeout" | "frame";
  readonly delayMs: number;
}

const pending = new Map<string, PendingTimer>();
const native = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  requestAnimationFrame: globalThis.requestAnimationFrame.bind(globalThis),
  cancelAnimationFrame: globalThis.cancelAnimationFrame.bind(globalThis),
};

// Each wrapper keeps the browser's own timer and only notes when it is pending.
// Timeouts and intervals share one id space in the browser; frames have their own.
globalThis.setTimeout = ((handler: TimerHandler, delay = 0, ...rest: unknown[]) => {
  const id: number = native.setTimeout(
    (...args: unknown[]) => {
      pending.delete(`t${String(id)}`);
      if (typeof handler === "function") (handler as (...a: unknown[]) => void)(...args);
    },
    delay,
    ...rest,
  );
  pending.set(`t${String(id)}`, { kind: "timeout", delayMs: Number(delay) || 0 });
  return id;
}) as typeof setTimeout;
globalThis.clearTimeout = ((id?: number) => {
  pending.delete(`t${String(id)}`);
  native.clearTimeout(id);
}) as typeof clearTimeout;
globalThis.setInterval = ((handler: TimerHandler, delay = 0, ...rest: unknown[]) => {
  const id: number = native.setInterval(handler, delay, ...rest);
  pending.set(`t${String(id)}`, { kind: "interval", delayMs: Number(delay) || 0 });
  return id;
}) as typeof setInterval;
globalThis.clearInterval = globalThis.clearTimeout as typeof clearInterval;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
  const id = native.requestAnimationFrame((time) => {
    pending.delete(`f${String(id)}`);
    callback(time);
  });
  pending.set(`f${String(id)}`, { kind: "frame", delayMs: 0 });
  return id;
};
globalThis.cancelAnimationFrame = (id: number): void => {
  pending.delete(`f${String(id)}`);
  native.cancelAnimationFrame(id);
};

/** Checks whether an animation frame is requested and not yet run. */
export function hasPendingFrame(): boolean {
  return [...pending.values()].some((timer) => timer.kind === "frame");
}

/** Returns what the probe counted, and starts counting renders from zero again. */
export function readProbe(): ProbeReading {
  const timers = [...pending.values()];
  const count = (test: (timer: PendingTimer) => boolean): number => timers.filter(test).length;
  const reading: ProbeReading = {
    renders: Object.fromEntries(renders),
    intervals: count((timer) => timer.kind === "interval"),
    shortTimeouts: count((timer) => timer.kind === "timeout" && timer.delayMs <= 1000),
    longTimeouts: count((timer) => timer.kind === "timeout" && timer.delayMs > 1000),
    frames: count((timer) => timer.kind === "frame"),
  };
  renders.clear();
  return reading;
}
