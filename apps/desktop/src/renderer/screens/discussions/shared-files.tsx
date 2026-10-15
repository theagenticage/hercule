/**
 * The Shared files of an open Discussion: each file that two or more
 * sessions edited, with the sessions that edited it and when it was shared
 * (spec 19 section 8.2). The list is drawn whole, because a Discussion holds
 * at most 500 files.
 */
import { memo, type JSX } from "react";
import type { SharedFile } from "@hercule/contract";
import { usePostTime } from "./post-time";
import { SessionMark } from "../actor/actor-mark";
import { SessionNames } from "../actor/sender-names";
import "../list-pane/open-item.css";
import "./discussions.css";

/** The size of a session's face in a file's row, in CSS pixels. */
const FACE_SIZE = 18;

/** Renders one file's row: its path, the faces and names of the sessions that edited it, and when it was shared. */
const SharedFileRow = memo(function SharedFileRow({
  file,
  timezone,
}: {
  readonly file: SharedFile;
  readonly timezone: string;
}): JSX.Element {
  const sharedAt = usePostTime(file.sharedAt, timezone);
  return (
    <div className="table-row tbl-files" role="listitem">
      <span className="table-path">{file.path}</span>
      <span className="who">
        <span className="faces">
          {file.sessionIds.map((sessionId) => (
            <SessionMark key={sessionId} sessionId={sessionId} size={FACE_SIZE} />
          ))}
        </span>
        <span>
          <SessionNames sessionIds={file.sessionIds} />
        </span>
      </span>
      <span className="table-num">{sharedAt}</span>
    </div>
  );
});

/**
 * Renders the section of `files` under a heading with their count. Draws
 * nothing for a Discussion without shared files, such as a general one that
 * no overlap opened.
 */
export function SharedFiles({
  files,
  timezone,
}: {
  readonly files: readonly SharedFile[];
  readonly timezone: string;
}): JSX.Element | null {
  if (files.length === 0) return null;
  return (
    <>
      <h2 className="sec-h">
        <span>Shared files</span>
        <b className="count">{files.length}</b>
      </h2>
      <div className="shared-files">
        <div className="table-rows" role="list" aria-label="Shared files">
          {files.map((file) => (
            <SharedFileRow key={file.path} file={file} timezone={timezone} />
          ))}
        </div>
      </div>
    </>
  );
}
