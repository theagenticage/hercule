/**
 * The Office's module-level caches, and how they are emptied when the Office
 * closes.
 *
 * The kits build geometry, materials and textures once and keep them in
 * module-level caches, so a rebuilt office reuses them. Leaving the Office
 * must free everything it built (spec 17), so each cache registers how to
 * empty itself, and the director calls `clearCaches` once the Office is gone.
 *
 * Emptying a cache drops what it holds. That matters for more than the
 * memory a cache holds itself: three.js adds a listener to every geometry,
 * material and texture it draws, and the listener holds the renderer, so a
 * cached object would keep a closed office's whole renderer in memory. An
 * object a module keeps for good must be disposed instead, which removes
 * the listener.
 */

const clears: Array<() => void> = [];

/**
 * Registers `clear`, a function that empties one cache: it drops what the
 * cache holds and disposes what the module keeps. `clearCaches` calls it.
 */
export function registerCache(clear: () => void): void {
  clears.push(clear);
}

/**
 * Empties every registered cache. Call it only once nothing draws what the
 * caches hold: the next office builds everything again.
 */
export function clearCaches(): void {
  for (const clear of clears) clear();
}
