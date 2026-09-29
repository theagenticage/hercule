/**
 * The files of the renderer's build that the packaged app serves on the `app`
 * scheme. Main lists them once, at start, in a table, and serves the files in
 * the table and nothing else: a request for any other path is answered with
 * 404 without touching the disk.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { isOnRendererOrigin } from "./renderer-origin";

/**
 * The content type of each kind of file the renderer's build holds. A file
 * of any other kind is left out of the table; a new kind of asset needs a
 * line here.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

/** A file of the renderer's build, found for a request. */
export interface RendererFile {
  /** The file's absolute path on disk. */
  readonly path: string;
  readonly contentType: string;
}

/**
 * The files of the renderer's build, keyed by the path a request on the `app`
 * scheme names them with, such as `/assets/index-7KNUBZzn.js`. The build names
 * its files with letters, digits, `-`, `_` and `.` only, so that path is the
 * file's path inside the build, spelled the same way in a URL.
 */
export type RendererFileTable = ReadonlyMap<string, RendererFile>;

/**
 * Lists the files of the renderer's build in `rendererFolder` and returns
 * them as a table. It lists the regular files, in the folder and every folder
 * below it, that are of a kind in `CONTENT_TYPES`. Symbolic links are left
 * out, so the table never leads outside the folder. Fails when the folder
 * cannot be read.
 *
 * It reads the disk synchronously: the build holds a handful of files, and
 * listing them takes well under a millisecond.
 */
export const buildRendererFileTable = (rendererFolder: string): RendererFileTable => {
  const table = new Map<string, RendererFile>();
  const listFolder = (folder: string, requestPath: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const entryPath = path.join(folder, entry.name);
      const entryRequestPath = `${requestPath}/${entry.name}`;
      const contentType = CONTENT_TYPES[path.extname(entry.name)];
      if (entry.isDirectory()) {
        listFolder(entryPath, entryRequestPath);
      } else if (entry.isFile() && contentType !== undefined) {
        table.set(entryRequestPath, { path: entryPath, contentType });
      }
    }
  };
  listFolder(rendererFolder, "");
  return table;
};

/**
 * Finds the file in `table` that `requestUrl`, a URL on the `app` scheme,
 * asks for. `/` means `/index.html`; the query string is ignored. Returns
 * null, which the scheme answers with 404, when the URL is not on the
 * renderer's origin or its path is not in the table.
 */
export const findRendererFile = (
  table: RendererFileTable,
  requestUrl: string,
): RendererFile | null => {
  if (!isOnRendererOrigin(requestUrl)) return null;
  const { pathname } = new URL(requestUrl);
  return table.get(pathname === "/" ? "/index.html" : pathname) ?? null;
};
