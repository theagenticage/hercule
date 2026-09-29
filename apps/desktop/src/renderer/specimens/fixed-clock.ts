/**
 * Stops the page's clock at `SPECIMEN_NOW`, as soon as this module runs:
 * `Date.now()` and `new Date()` both return that moment from then on. A date
 * built from an explicit value is unchanged.
 *
 * The sidebar's age labels read the time from the app's age clock, which calls
 * `new Date()` and `Date.now()` itself and takes no clock from outside. A
 * fixed clock keeps the labels at "20m" and "1h" however long the capture
 * takes. The age clock reads the time when its module loads, so the sidebar
 * specimen imports this module before any other.
 */
import { SPECIMEN_NOW } from "./sidebar-fixture";

const RealDate = Date;

globalThis.Date = new Proxy(RealDate, {
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length === 0 ? [SPECIMEN_NOW] : args, newTarget) as object,
  get: (target, key, receiver) =>
    key === "now" ? () => SPECIMEN_NOW : (Reflect.get(target, key, receiver) as unknown),
});
