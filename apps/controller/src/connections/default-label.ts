/**
 * The label a new connection gets when the user gives none: the name of the
 * account it signs in to, such as a GitHub login.
 */
import { MAX_CONNECTION_LABEL_LENGTH } from "@hercule/contract";

/** Checks whether a UTF-16 code unit is the first half of a surrogate pair. */
const isHighSurrogate = (codeUnit: number): boolean => codeUnit >= 0xd800 && codeUnit <= 0xdbff;

/**
 * Builds the label of a new connection the user did not name. Returns the
 * account name the type's `validate` returned, or the type's own display name
 * when the account name is empty or only whitespace, so the label is never
 * blank.
 *
 * A label is at most `MAX_CONNECTION_LABEL_LENGTH` UTF-16 code units, and the
 * account name is the provider's to choose, so a longer name is cut to fit.
 * The cut never splits a surrogate pair: an emoji at the boundary is dropped
 * whole rather than leaving half a character behind. The connection keeps
 * the whole account name in its own field.
 */
export const buildDefaultLabel = (accountName: string, typeDisplayName: string): string => {
  const name = accountName.trim() === "" ? typeDisplayName : accountName;
  if (name.length <= MAX_CONNECTION_LABEL_LENGTH) return name;
  const clipped = name.slice(0, MAX_CONNECTION_LABEL_LENGTH);
  return isHighSurrogate(clipped.charCodeAt(clipped.length - 1)) ? clipped.slice(0, -1) : clipped;
};
