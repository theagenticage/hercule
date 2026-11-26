/**
 * How much of the start of a markdown file is read to find its frontmatter.
 * The frontmatter is at the top of the file, and the file can be of any size.
 */
export const MAX_FRONTMATTER_BYTES = 64 * 1024;

/**
 * What `readFrontmatter` found. `missing` means the text does not start with a
 * `---` line, `unclosed` means it does but no later line holds only `---`, and
 * `invalid` means the block between them is not valid YAML (`error` is the
 * parser's error).
 */
export type FrontmatterResult =
  | { readonly status: "found"; readonly value: unknown }
  | { readonly status: "missing" }
  | { readonly status: "unclosed" }
  | { readonly status: "invalid"; readonly error: unknown };

/** Returns `text` without the byte order mark some editors put at the start of a file. */
const withoutByteOrderMark = (text: string): string =>
  text.startsWith("\uFEFF") ? text.slice(1) : text;

/**
 * Parses the YAML frontmatter of a markdown text: the lines between a first
 * line that holds only `---` and the next line that holds only `---`. A byte
 * order mark at the start and Windows line endings are accepted. Never throws.
 * `found` carries whatever the YAML parses to, which is not always a mapping.
 */
export const readFrontmatter = (text: string): FrontmatterResult => {
  const lines = withoutByteOrderMark(text).split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { status: "missing" };
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return { status: "unclosed" };
  try {
    return { status: "found", value: Bun.YAML.parse(lines.slice(1, end).join("\n")) };
  } catch (error) {
    return { status: "invalid", error };
  }
};
