/**
 * Tests how a runtime note draws the command in its message: each word stays
 * whole, except a word too long to always fit a line, which is left as plain
 * text so it can break anywhere.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ThreadNotice } from "@hercule/client-core";
import { RuntimeNote } from "./runtime-note";

afterEach(cleanup);

const noticeOf = (message: string): ThreadNotice => ({
  key: "runtime.error:0",
  severity: "error",
  message,
  at: "2026-09-08T10:00:00.000Z",
});

describe("RuntimeNote", () => {
  it("keeps the words of a command whole, except a word too long to always fit a line", () => {
    const path = `/home/${"very-long-directory-name-".repeat(7)}file.ts`;
    const { container } = render(
      <RuntimeNote notice={noticeOf(`Could not read \`cat ${path}\`.`)} />,
    );

    const code = container.querySelector("code")!;
    expect(code.textContent).toBe(`cat ${path}`);
    expect([...code.querySelectorAll("span")].map((word) => word.textContent)).toEqual(["cat"]);
  });
});
