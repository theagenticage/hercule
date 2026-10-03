/**
 * PROTOTYPE - walking through the office. STUB: paths are straight lines,
 * until the nav part replaces this with a grid and A*. Keep the exported
 * signature.
 */
import type { NavBuilder, NavGraph } from "./contracts";

export function createNavBuilder(): NavBuilder {
  const graph: NavGraph = {
    findPath(from, to) {
      return [
        { position: from.position.clone(), floor: from.floor, kind: "walk" },
        { position: to.position.clone(), floor: to.floor, kind: "walk" },
      ];
    },
  };
  return {
    addFloor() {},
    block() {},
    blockObject() {},
    open() {},
    link() {},
    build: () => graph,
  };
}
