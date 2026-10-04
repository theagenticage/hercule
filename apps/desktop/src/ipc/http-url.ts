/**
 * Checks whether `value` is an absolute `http:` or `https:` URL: the only
 * kind of URL the app saves as a controller URL or opens in the browser.
 */
export const isHttpUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
};
