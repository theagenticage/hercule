/**
 * The props a link adds while the screen it leads to is open, for its
 * `activeProps`: the `is-on` class, which draws it as selected. The router
 * also sets `aria-current="page"` on it then.
 */
export const SELECTED_LINK_PROPS = { className: "is-on" } as const;
