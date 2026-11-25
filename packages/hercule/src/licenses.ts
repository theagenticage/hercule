import acpLicense from "@hercule/acp/LICENSE" with { type: "text" };

/** Third-party code that ships inside the binary, with the licence it came under. */
interface Notice {
  readonly project: string;
  readonly url: string;
  /** Which part of the project the binary contains. */
  readonly what: string;
  /** The full licence text, as the project published it. */
  readonly text: string;
}

const NOTICES: ReadonlyArray<Notice> = [
  {
    project: "T3 Code",
    url: "https://github.com/pingdotgg/t3code",
    what: "the ACP client (packages/effect-acp), copied unchanged",
    text: acpLicense,
  },
];

/**
 * Returns the notice that `hercule licenses` prints: one line of introduction,
 * then for each project its name, its address, what of it the binary contains,
 * and its full licence text.
 */
export function buildLicensesNotice(): string {
  const intro = "The hercule binary contains code from these projects, under these licences.";
  const sections = NOTICES.map(
    (notice) => `${notice.project}\n${notice.url}\n${notice.what}\n\n${notice.text.trimEnd()}`,
  );
  return `${intro}\n\n${sections.join("\n\n---\n\n")}`;
}
