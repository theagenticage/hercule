/**
 * Skills as they travel: the hash that names a Skill Revision, and the
 * uncompressed ustar tar archive that carries a skill's files between a
 * client, the controller and a runner.
 *
 * The controller, the runner and the clients all compute a revision's hash and
 * read or build its archive with these functions, so one skill's content has
 * one hash and one archive everywhere. This file uses no Node built-in: the
 * desktop app's renderer links it too, so sha256 comes from the global
 * `crypto.subtle`.
 */
import { Effect, Schema } from "effect";

/** The largest skill archive a client sends or the controller accepts: 10 MiB. */
export const MAX_SKILL_BYTES = 10 * 1024 * 1024;

/**
 * The hash that identifies a Skill Revision: the sha256 of its file listing
 * (`computeSkillRevisionHash`), in lowercase hex.
 */
export const SkillRevisionHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/, {
    title: "revisionHash",
    description: "the sha256 of a Skill Revision's file listing, in lowercase hex",
  }),
);

export type SkillRevisionHash = Schema.Schema.Type<typeof SkillRevisionHash>;

/**
 * The capability for library skills in a start frame. The runner lists it at
 * hello when it fetches the Skill Revisions a `SessionStart` names and gives
 * them to the harness; the controller lists it when it sends
 * `SessionStart.skills`. A runner without it still gets the start, only
 * without the field, so its session runs with no library skills (spec 03
 * section 2.2).
 */
export const SKILLS_CAPABILITY = "skills";

/**
 * The HTTP resource a runner fetches a Skill Revision from with its
 * credential: `GET <path>/<revisionHash>` answers the revision's archive. It
 * is part of the runner protocol, not the operation table. The controller
 * serves only a revision that has been applied, and answers `404` to any
 * other hash.
 */
export const RUNNER_SKILL_REVISIONS_PATH = "/api/v1/runners/skill-revisions";

/** The most Skills the Skill Library holds, and so the most one session gets. */
export const MAX_SKILLS = 256;

/** The longest Skill name, the limit of the Agent Skills format. */
const MAX_SKILL_NAME_LENGTH = 64;

/**
 * A Skill's name, its identity and its key in every route: lowercase letters
 * and digits in groups joined by single hyphens, at most 64 characters, as the
 * Agent Skills format requires. A runner makes the name a folder name, so the
 * pattern also keeps a name such as `../x` off its disk.
 *
 * The schema does not refuse the built-in skill's name, `hercule`: no Skill
 * has that name, so reading or deleting it is `not_found`, and an import of it
 * is refused by the content rules, beside every other issue the content has.
 */
export const SkillName = Schema.String.check(
  Schema.isMaxLength(MAX_SKILL_NAME_LENGTH),
  Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    expected: "lowercase letters and digits, in groups joined by single hyphens",
  }),
);

/**
 * One skill a session gets from the Skill Library: the Skill's name, which
 * the runner uses as the skill's folder name, and the hash of the Skill
 * Revision to load.
 */
export const SessionSkill = Schema.Struct({
  name: SkillName,
  revisionHash: SkillRevisionHash,
});

export type SessionSkill = Schema.Schema.Type<typeof SessionSkill>;

/**
 * The mode of a file in a skill: `755` for an executable file and `644` for
 * every other file. No other mode is stored.
 */
export const SkillFileMode = Schema.Literals(["644", "755"]);

export type SkillFileMode = Schema.Schema.Type<typeof SkillFileMode>;

/**
 * Converts a file's mode, as `stat` returns it, to the mode a skill stores
 * for the file: `755` when the owner's execute bit is set, `644` otherwise.
 */
export const convertToSkillFileMode = (mode: number): SkillFileMode =>
  (mode & 0o100) === 0 ? "644" : "755";

/** One file of a skill. `path` is relative to the skill's root, with `/` between its segments. */
export interface SkillFile {
  readonly path: string;
  readonly mode: SkillFileMode;
  readonly content: Uint8Array;
}

const utf8Encoder = new TextEncoder();

/**
 * Compares two skill paths by their UTF-8 bytes, for `Array.prototype.sort`.
 * Returns a negative number when `a` sorts first, a positive one when `b`
 * does, and 0 when they are equal.
 *
 * JavaScript's own string comparison orders UTF-16 code units, which puts an
 * emoji before `！` (U+FF01); UTF-8 bytes put it after. The revision hash's
 * listing is sorted by bytes, so every list of a skill's files is too.
 */
export const compareSkillPaths = (a: string, b: string): number => {
  const left = utf8Encoder.encode(a);
  const right = utf8Encoder.encode(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

/** Returns the sha256 of `bytes` as 64 lowercase hex characters. */
const computeSha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // `digest` takes only bytes backed by an `ArrayBuffer`. A new view on the
  // same buffer is typed as one without copying the bytes; only bytes on a
  // `SharedArrayBuffer` are copied.
  const view =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", view));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Computes the hash of a Skill Revision from its files. Never fails.
 *
 * The hash is the sha256 of a listing with one line per file, sorted with
 * `compareSkillPaths`. A line is the path, a zero byte, the mode, a zero byte,
 * the sha256 of the content in lowercase hex, and a newline. Only paths,
 * modes and contents count, so the same files always have the same hash,
 * however they arrived (spec 02, Skill Revision, "The hash").
 */
export const computeSkillRevisionHash = (files: ReadonlyArray<SkillFile>): Effect.Effect<string> =>
  Effect.promise(async () => {
    const sorted = [...files].sort((a, b) => compareSkillPaths(a.path, b.path));
    const contentHashes = await Promise.all(sorted.map((file) => computeSha256Hex(file.content)));
    const listing = sorted
      .map((file, index) => `${file.path}\0${file.mode}\0${contentHashes[index]}\n`)
      .join("");
    return computeSha256Hex(utf8Encoder.encode(listing));
  });

/**
 * One entry of a skill archive, as `readSkillArchive` reads it.
 *
 * - `kind` is `file` for a regular file, `directory`, `symlink`, or `other`
 *   for every other entry: a hard link, a device, and the extension headers
 *   of the pax and GNU formats.
 * - `mode` is the entry's permission bits from its header, setuid, setgid and
 *   sticky included, so a check can refuse every mode but `644` and `755`.
 * - `content` holds a file's bytes and is empty for every other kind.
 */
export interface SkillArchiveEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly mode: number;
  readonly content: Uint8Array;
}

/** The bytes are not a ustar tar archive this reader can read. `message` says what is wrong. */
export class SkillArchiveUnreadable extends Schema.TaggedError<SkillArchiveUnreadable>()(
  "SkillArchiveUnreadable",
  { message: Schema.String },
) {}

/** A file's path is too long for a ustar header, so the file cannot go into a skill archive. */
export class SkillPathTooLong extends Schema.TaggedError<SkillPathTooLong>()("SkillPathTooLong", {
  path: Schema.String,
}) {
  override get message(): string {
    return `\`${this.path}\` is too long for a tar archive. Shorten its folder names or its file name.`;
  }
}

/** The size of a tar header, and the unit every entry's content is padded to: 512 bytes. */
export const TAR_BLOCK_SIZE = 512;
const NAME_LENGTH = 100;
const PREFIX_LENGTH = 155;

/** Where each header field this file reads or writes sits in a 512-byte ustar header. */
const field = {
  name: { offset: 0, length: NAME_LENGTH },
  mode: { offset: 100, length: 8 },
  uid: { offset: 108, length: 8 },
  gid: { offset: 116, length: 8 },
  size: { offset: 124, length: 12 },
  mtime: { offset: 136, length: 12 },
  checksum: { offset: 148, length: 8 },
  typeflag: { offset: 156, length: 1 },
  magic: { offset: 257, length: 6 },
  version: { offset: 263, length: 2 },
  prefix: { offset: 345, length: PREFIX_LENGTH },
} as const;

type HeaderField = (typeof field)[keyof typeof field];

const USTAR_MAGIC = utf8Encoder.encode("ustar\0");
const USTAR_VERSION = utf8Encoder.encode("00");
/** The first five bytes of the magic field, which POSIX and GNU tar headers share. */
const TAR_MAGIC_START = utf8Encoder.encode("ustar");

/** Returns the bytes of `header` that hold one field. */
const readField = (header: Uint8Array, at: HeaderField): Uint8Array =>
  header.subarray(at.offset, at.offset + at.length);

/** Returns `size` rounded up to a whole number of 512-byte blocks. */
export const padToTarBlock = (size: number): number =>
  Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

/**
 * Splits a skill path into the `prefix` and `name` fields of a ustar header.
 *
 * A path of at most 100 UTF-8 bytes goes whole into `name`, with an empty
 * `prefix`. A longer path is split at a `/`: the part before it goes into
 * `prefix`, at most 155 bytes, and the part after it into `name`, at most 100
 * bytes and not empty. Returns `null` when no split fits, which means the path
 * cannot go into a skill archive.
 */
export const splitUstarPath = (
  path: string,
): { readonly prefix: string; readonly name: string } | null => {
  const bytes = utf8Encoder.encode(path);
  if (bytes.length <= NAME_LENGTH) return { prefix: "", name: path };
  // A `/` byte never occurs inside a multi-byte UTF-8 character, so a split at
  // a `/` byte is a split between characters. The last `/` the prefix can
  // reach leaves the shortest name.
  const slash = bytes.subarray(0, PREFIX_LENGTH + 1).lastIndexOf(0x2f);
  if (slash < 1 || bytes.length - slash - 1 > NAME_LENGTH || slash === bytes.length - 1) {
    return null;
  }
  // `ignoreBOM` keeps a leading U+FEFF, which a plain decoder would drop, so
  // the prefix would name a different path than the file's.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  return {
    prefix: decoder.decode(bytes.subarray(0, slash)),
    name: decoder.decode(bytes.subarray(slash + 1)),
  };
};

/**
 * Parses an octal number field of a ustar header: optional leading spaces,
 * octal digits, then only NUL bytes or spaces. Returns `null` for anything
 * else, such as an empty field or the base-256 numbers of GNU tar.
 */
const parseOctalField = (bytes: Uint8Array): number | null => {
  let index = 0;
  while (index < bytes.length && bytes[index] === 0x20) index++;
  let value = 0;
  let digits = 0;
  for (; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (byte < 0x30 || byte > 0x37) break;
    value = value * 8 + (byte - 0x30);
    digits++;
  }
  for (; index < bytes.length; index++) {
    if (bytes[index] !== 0 && bytes[index] !== 0x20) return null;
  }
  return digits === 0 ? null : value;
};

/** Returns the bytes of a text field up to its first NUL byte, or the whole field when it has none. */
const readTextField = (header: Uint8Array, at: HeaderField): Uint8Array => {
  const bytes = readField(header, at);
  const end = bytes.indexOf(0);
  return end === -1 ? bytes : bytes.subarray(0, end);
};

/**
 * Returns the checksum a ustar header should hold: the sum of its 512 bytes,
 * with the eight bytes of the checksum field counted as spaces.
 */
const computeHeaderChecksum = (header: Uint8Array): number => {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index++) {
    const inChecksumField =
      index >= field.checksum.offset && index < field.checksum.offset + field.checksum.length;
    sum += inChecksumField ? 0x20 : header[index]!;
  }
  return sum;
};

/** Checks that `bytes` equal `expected`, byte for byte. */
const hasBytes = (bytes: Uint8Array, expected: Uint8Array): boolean =>
  bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);

/** Checks that every byte of `bytes` is zero, as in the blocks that end an archive. */
const isAllZero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

/** Returns the kind of entry a tar typeflag stands for. */
const readEntryKind = (typeflag: string): SkillArchiveEntry["kind"] => {
  switch (typeflag) {
    case "0":
    case "\0":
      return "file";
    case "5":
      return "directory";
    case "2":
      return "symlink";
    default:
      return "other";
  }
};

/** What `parseUstarHeader` reads from one 512-byte tar header. */
export interface UstarHeader {
  /**
   * `posix` for the `ustar\0` magic and `00` version of POSIX tar, `gnu` for
   * any other magic that starts with `ustar`, such as GNU tar's `ustar  \0`.
   */
  readonly format: "posix" | "gnu";
  /** The typeflag as one character, such as `0` for a file or `x` for a pax header. */
  readonly typeflag: string;
  readonly kind: SkillArchiveEntry["kind"];
  /** The permission bits, setuid, setgid and sticky included. */
  readonly mode: number;
  /** The size of the content that follows the header, before padding. */
  readonly size: number;
  /**
   * The bytes of the `prefix` and `name` fields joined by `/`, or of `name`
   * alone when `prefix` is empty. They are not decoded, so each caller
   * decides what to do with a path that is not UTF-8.
   */
  readonly path: Uint8Array;
}

/**
 * Why `parseUstarHeader` refused a block:
 *
 * - `notUstar`: the magic does not start with `ustar`;
 * - `badChecksum`: the checksum field does not match the header's bytes;
 * - `notANumber`: the size or mode field is not an octal number.
 */
export type UstarHeaderProblem = "notUstar" | "badChecksum" | "notANumber";

/**
 * Parses one 512-byte tar header, POSIX or GNU. Returns the header's fields,
 * or the problem that makes the block no header. The caller checks for the
 * zero block that ends an archive first, and reads any pax or GNU long path
 * that comes before the header.
 */
export const parseUstarHeader = (block: Uint8Array): UstarHeader | UstarHeaderProblem => {
  const magic = readField(block, field.magic);
  if (!hasBytes(magic.subarray(0, TAR_MAGIC_START.length), TAR_MAGIC_START)) return "notUstar";
  if (parseOctalField(readField(block, field.checksum)) !== computeHeaderChecksum(block)) {
    return "badChecksum";
  }
  const size = parseOctalField(readField(block, field.size));
  const mode = parseOctalField(readField(block, field.mode));
  if (size === null || mode === null) return "notANumber";
  const name = readTextField(block, field.name);
  const prefix = readTextField(block, field.prefix);
  let path = name;
  if (prefix.length > 0) {
    path = new Uint8Array(prefix.length + 1 + name.length);
    path.set(prefix);
    path[prefix.length] = 0x2f;
    path.set(name, prefix.length + 1);
  }
  const typeflag = String.fromCharCode(block[field.typeflag.offset]!);
  return {
    format:
      hasBytes(magic, USTAR_MAGIC) && hasBytes(readField(block, field.version), USTAR_VERSION)
        ? "posix"
        : "gnu",
    typeflag,
    kind: readEntryKind(typeflag),
    // Some writers put the file type bits above the permission bits.
    mode: mode & 0o7777,
    size,
    path,
  };
};

/**
 * Reads a skill archive: an uncompressed ustar tar archive. Returns its
 * entries in archive order, every kind of entry included, so the caller's
 * checks can name a symbolic link or a pax header rather than lose it.
 *
 * Fails with `SkillArchiveUnreadable` when a header is not ustar, has a wrong
 * checksum or a field that is not a number, when an entry runs past the end
 * of the bytes, when a path is not UTF-8, or when bytes other than zeros
 * follow the end of the archive. An archive whose last entry is not followed
 * by the two zero blocks that end an archive is accepted.
 *
 * A file's `content` is a view into `bytes`, not a copy.
 */
export const readSkillArchive = (
  bytes: Uint8Array,
): Effect.Effect<ReadonlyArray<SkillArchiveEntry>, SkillArchiveUnreadable> =>
  Effect.gen(function* () {
    // `ignoreBOM` keeps a leading U+FEFF in a path. Without it the decoder
    // drops the character, and the path read differs from the path written.
    const pathDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const entries: Array<SkillArchiveEntry> = [];
    let offset = 0;
    while (offset < bytes.length) {
      if (offset + TAR_BLOCK_SIZE > bytes.length) {
        if (isAllZero(bytes.subarray(offset))) break;
        return yield* new SkillArchiveUnreadable({
          message: `The skill archive is cut off: the entry at byte ${offset} has an incomplete header.`,
        });
      }
      const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
      if (isAllZero(header)) {
        if (!isAllZero(bytes.subarray(offset))) {
          return yield* new SkillArchiveUnreadable({
            message: `The skill archive has data after its end marker at byte ${offset}.`,
          });
        }
        break;
      }
      const parsed = parseUstarHeader(header);
      if (parsed === "notUstar" || (typeof parsed !== "string" && parsed.format !== "posix")) {
        return yield* new SkillArchiveUnreadable({
          message: `The skill archive is not a ustar tar archive: the entry at byte ${offset} has no ustar header.`,
        });
      }
      if (parsed === "badChecksum") {
        return yield* new SkillArchiveUnreadable({
          message: `The skill archive is damaged: the header of the entry at byte ${offset} has a wrong checksum.`,
        });
      }
      if (parsed === "notANumber") {
        return yield* new SkillArchiveUnreadable({
          message: `The skill archive is damaged: the header of the entry at byte ${offset} has a size or mode that is not an octal number.`,
        });
      }
      const { size, kind } = parsed;
      const contentStart = offset + TAR_BLOCK_SIZE;
      if (contentStart + padToTarBlock(size) > bytes.length) {
        return yield* new SkillArchiveUnreadable({
          message: `The skill archive is cut off: the entry at byte ${offset} holds ${size} bytes, past the end of the archive.`,
        });
      }
      let path: string;
      try {
        path = pathDecoder.decode(parsed.path);
      } catch {
        return yield* new SkillArchiveUnreadable({
          message: `The skill archive has a path that is not UTF-8 text, in the entry at byte ${offset}.`,
        });
      }
      entries.push({
        path,
        kind,
        mode: parsed.mode,
        content:
          kind === "file" ? bytes.subarray(contentStart, contentStart + size) : new Uint8Array(0),
      });
      offset = contentStart + padToTarBlock(size);
    }
    return entries;
  });

/** Writes `value` into a numeric header field as zero-padded octal digits followed by a NUL byte. */
const writeOctalField = (header: Uint8Array, at: HeaderField, value: number): void => {
  const digits = value.toString(8).padStart(at.length - 1, "0");
  header.set(utf8Encoder.encode(`${digits}\0`), at.offset);
};

/**
 * Builds a skill archive: an uncompressed ustar tar archive with one
 * regular-file entry per file, sorted with `compareSkillPaths`, and no
 * directory entries. Each entry carries its file's mode, `644` or `755`, and
 * nothing else of the machine it came from: owner, group and time are zero.
 *
 * Fails with `SkillPathTooLong` for the first path, in sorted order, that does
 * not fit a ustar header (`splitUstarPath`).
 */
export const buildSkillArchive = (
  files: ReadonlyArray<SkillFile>,
): Effect.Effect<Uint8Array, SkillPathTooLong> =>
  Effect.gen(function* () {
    const sorted = [...files].sort((a, b) => compareSkillPaths(a.path, b.path));
    const headers: Array<Uint8Array> = [];
    for (const file of sorted) {
      const split = splitUstarPath(file.path);
      if (split === null) return yield* new SkillPathTooLong({ path: file.path });
      const header = new Uint8Array(TAR_BLOCK_SIZE);
      header.set(utf8Encoder.encode(split.name), field.name.offset);
      header.set(utf8Encoder.encode(split.prefix), field.prefix.offset);
      writeOctalField(header, field.mode, file.mode === "755" ? 0o755 : 0o644);
      writeOctalField(header, field.uid, 0);
      writeOctalField(header, field.gid, 0);
      writeOctalField(header, field.size, file.content.length);
      writeOctalField(header, field.mtime, 0);
      header[field.typeflag.offset] = 0x30; // "0": a regular file
      header.set(USTAR_MAGIC, field.magic.offset);
      header.set(USTAR_VERSION, field.version.offset);
      // The checksum is six octal digits, a NUL byte and a space, as tar writes it.
      const checksum = computeHeaderChecksum(header).toString(8).padStart(6, "0");
      header.set(utf8Encoder.encode(`${checksum}\0 `), field.checksum.offset);
      headers.push(header);
    }
    // A new array is all zeros, so the padding and the two end blocks need no writing.
    const archive = new Uint8Array(
      computeSkillArchiveByteLength(sorted.map((file) => file.content.length)),
    );
    let offset = 0;
    sorted.forEach((file, index) => {
      archive.set(headers[index]!, offset);
      archive.set(file.content, offset + TAR_BLOCK_SIZE);
      offset += TAR_BLOCK_SIZE + padToTarBlock(file.content.length);
    });
    return archive;
  });

/**
 * Returns the length in bytes of the archive `buildSkillArchive` builds from
 * files of these sizes, in any order: a 512-byte header per file, each
 * file's content padded to a whole 512-byte block, and the two zero blocks
 * that end the archive.
 *
 * The length depends on the sizes alone, so a sender can announce an
 * archive's length before it reads any file's content.
 */
export const computeSkillArchiveByteLength = (fileSizes: ReadonlyArray<number>): number =>
  fileSizes.reduce((total, size) => total + TAR_BLOCK_SIZE + padToTarBlock(size), 0) +
  2 * TAR_BLOCK_SIZE;

const CONTROL_CHARACTER = /\p{Cc}/u;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
const DEFAULT_IGNORABLE_CODE_POINTS = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * Checks a skill's file paths against the path rules of the content rules
 * (spec 11 section 2 `skill`), and returns the issue messages, or an empty
 * list when every path follows them. The paths are relative to the skill's
 * root. The rules refuse unsafe paths, paths a disk that ignores case could
 * not hold apart, and paths too long for a tar archive.
 *
 * `showPath` formats a path for a message. By default a message shows the
 * path as given, in backticks, with no skill name before it.
 *
 * The controller checks every import with these rules, and so does anything
 * that writes a skill's files to disk: a promotion bundle on the new machine,
 * and a runner that fetched a Skill Revision.
 */
export const listSkillPathIssues = (
  paths: ReadonlyArray<string>,
  showPath: (path: string) => string = (path) => `\`${escapeControlCharacters(path)}\``,
): ReadonlyArray<string> => {
  const issues: Array<string> = [];
  // Only safe paths are compared and measured, so an unsafe path is
  // reported once, as unsafe.
  const safePaths: Array<string> = [];
  for (const path of paths) {
    const issue = findUnsafePathIssue(path, showPath(path));
    if (issue === null) safePaths.push(path);
    else issues.push(issue);
  }
  issues.push(...listPathCollisionIssues(safePaths, showPath));
  for (const path of safePaths) {
    if (splitUstarPath(path) === null) {
      issues.push(
        `${showPath(path)} is too long for a tar archive. Shorten its folder names or its file name.`,
      );
    }
  }
  return issues;
};

/**
 * Returns the issue with a file's path when the path could reach outside the
 * skill's folder or cannot be written safely, or null when it is safe. A safe
 * path is relative, uses `/`, and has no empty, `.` or `..` segment and no
 * control character.
 */
const findUnsafePathIssue = (path: string, shownPath: string): string | null => {
  if (CONTROL_CHARACTER.test(path)) {
    return `${shownPath} has a control character in its path. Rename it without one.`;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `${shownPath} is not a path inside the skill. Paths must stay inside the skill's folder.`;
  }
  return null;
};

/**
 * Returns the issues with paths that a disk which ignores case could not hold
 * apart: two equal paths, a file whose path is a folder of another file's
 * path, and one folder spelled two ways. Paths are compared segment by
 * segment, each folded by `foldPathSegment`.
 */
const listPathCollisionIssues = (
  paths: ReadonlyArray<string>,
  showPath: (path: string) => string,
): ReadonlyArray<string> => {
  // Each segment is folded once. A path's key is its folded segments joined
  // with `/`, so the key of a folder is the start of the key of every path
  // inside it, and is built one segment at a time.
  const splitPaths = paths.map((path) => {
    const segments = path.split("/");
    return { path, segments, foldedSegments: segments.map(foldPathSegment) };
  });

  const issues: Array<string> = [];
  const filesByKey = new Map<string, string>();
  for (const { path, foldedSegments } of splitPaths) {
    const key = foldedSegments.join("/");
    const earlier = filesByKey.get(key);
    if (earlier === undefined) filesByKey.set(key, path);
    else if (earlier === path) {
      issues.push(`${showPath(path)} appears twice in the archive. Each path may appear once.`);
    } else if (earlier.toLowerCase() === path.toLowerCase()) {
      issues.push(
        `${showPath(earlier)} and ${showPath(path)} differ only in case. Rename one of them.`,
      );
    } else {
      issues.push(
        `${showPath(earlier)} and ${showPath(path)} name one file on a disk that ignores case, such as macOS's. Rename one of them.`,
      );
    }
  }

  // Each folder's spelling is the spelling of its last segment, keyed by the
  // folded path of the whole folder, so a clash high up in the tree is
  // reported once and not again for every folder below it.
  const folders = new Map<string, { readonly segment: string; readonly path: string }>();
  const reportedFolderClashes = new Set<string>();
  const reportedFileFolders = new Set<string>();
  for (const { path, segments, foldedSegments } of splitPaths) {
    let key = "";
    for (let depth = 1; depth < segments.length; depth++) {
      key = depth === 1 ? foldedSegments[0]! : `${key}/${foldedSegments[depth - 1]!}`;
      const segment = segments[depth - 1]!;

      const file = filesByKey.get(key);
      if (file !== undefined && !reportedFileFolders.has(key)) {
        reportedFileFolders.add(key);
        issues.push(
          `${showPath(file)} is a file, and ${showPath(path)} needs it to be a folder. Rename one of them.`,
        );
      }

      const first = folders.get(key);
      if (first === undefined) folders.set(key, { segment, path });
      else if (first.segment !== segment && !reportedFolderClashes.has(`${key}\0${segment}`)) {
        reportedFolderClashes.add(`${key}\0${segment}`);
        issues.push(
          `${showPath(first.path)} and ${showPath(path)} spell one folder two ways. Use one spelling.`,
        );
      }
    }
  }
  return issues;
};

/**
 * Returns the form of one path segment under which every two names that a
 * disk which ignores case may treat as one name are equal.
 *
 * Disks fold names in different ways, so this fold is wider than any one of
 * them, and a name refused here is refused on every disk:
 *
 * - NFKD maps compatibility forms to plain letters: `ﬀ` to `ff`, `ſ` to `s`.
 * - Upper case then lower case maps `ß` to `ss` and `ς` to `σ`, which a
 *   lower case alone keeps apart.
 * - Default-ignorable code points, such as a zero-width space or a leading
 *   byte order mark, are dropped, because some disks ignore them.
 */
const foldPathSegment = (segment: string): string =>
  segment
    .normalize("NFKD")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKD")
    .replace(DEFAULT_IGNORABLE_CODE_POINTS, "");

/**
 * Replaces every control character in a text with its `\u` escape, so a
 * message that shows a path or a name stays on one readable line.
 */
export const escapeControlCharacters = (text: string): string =>
  text.replace(
    CONTROL_CHARACTERS,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** A skill archive failed `verifySkillRevisionArchive`. `message` gives the reason. */
export class SkillRevisionArchiveRefused extends Schema.TaggedError<SkillRevisionArchiveRefused>()(
  "SkillRevisionArchiveRefused",
  { message: Schema.String },
) {}

/** The names of the archive entries a skill may not hold, for the message that refuses one. */
const ENTRY_KIND_NAMES: Record<Exclude<SkillArchiveEntry["kind"], "file">, string> = {
  directory: "a directory",
  symlink: "a symbolic link",
  other: "a special entry, such as a hard link or an extension header",
};

/**
 * Reads the archive of a Skill Revision and checks it. Returns the files of
 * the revision. Fails with `SkillRevisionArchiveRefused` when:
 *
 * - the archive cannot be read (`readSkillArchive`);
 * - an entry is not a regular file, or a file's mode is not `644` or `755`;
 * - a path breaks the path rules (`listSkillPathIssues`);
 * - the files do not hash to `revisionHash`.
 *
 * Anything that writes a revision's files to disk from an archive it
 * received runs this check first: a runner that fetched the revision, and a
 * controller receiving a promotion transfer. The caller checks the size of
 * the archive before it reads it into memory.
 */
export const verifySkillRevisionArchive = (
  archive: Uint8Array,
  revisionHash: string,
): Effect.Effect<ReadonlyArray<SkillFile>, SkillRevisionArchiveRefused> =>
  Effect.gen(function* () {
    const refuse = (message: string) => Effect.fail(new SkillRevisionArchiveRefused({ message }));
    const entries = yield* readSkillArchive(archive).pipe(
      Effect.mapError((error) => new SkillRevisionArchiveRefused({ message: error.message })),
    );
    const files: Array<SkillFile> = [];
    for (const entry of entries) {
      const shownPath = `\`${escapeControlCharacters(entry.path)}\``;
      if (entry.kind !== "file") {
        return yield* refuse(
          `${shownPath} is ${ENTRY_KIND_NAMES[entry.kind]}, and a skill holds only regular files`,
        );
      }
      if (entry.mode !== 0o644 && entry.mode !== 0o755) {
        return yield* refuse(
          `${shownPath} has mode ${entry.mode.toString(8)}, and a skill's files have mode 644 or 755`,
        );
      }
      files.push({
        path: entry.path,
        mode: convertToSkillFileMode(entry.mode),
        content: entry.content,
      });
    }
    const issues = listSkillPathIssues(files.map((file) => file.path));
    if (issues.length > 0) return yield* refuse(issues.join(" "));
    if ((yield* computeSkillRevisionHash(files)) !== revisionHash) {
      return yield* refuse("the archive's files do not match the revision's hash");
    }
    return files;
  });
