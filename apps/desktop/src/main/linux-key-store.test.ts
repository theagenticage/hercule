import { describe, expect, it } from "vitest";
import { findKeyringProblem } from "./linux-key-store";
import type { ElectronSafeStorageCalls } from "./safe-storage";

/** Returns a fake of Electron's `safeStorage` whose backend is `basic_text`, and the calls made on it. */
const makeFakeElectron = () => {
  const calls: Array<string> = [];
  const electron = {
    isEncryptionAvailable: () => {
      calls.push("isEncryptionAvailable");
      return false;
    },
    getSelectedStorageBackend: () => {
      calls.push("getSelectedStorageBackend");
      return "basic_text" as const;
    },
    setUsePlainTextEncryption: (usePlainText: boolean) => {
      calls.push(`setUsePlainTextEncryption(${String(usePlainText)})`);
    },
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  } satisfies ElectronSafeStorageCalls;
  return { electron, calls };
};

const TEST_ARGS = ["--user-data-dir=/tmp/hercule-e2e", "--use-mock-keychain"];

describe("findKeyringProblem and the mock keychain switch", () => {
  it("allows the fixed key, and looks at nothing else, with the switch and the inspector open", () => {
    const { electron, calls } = makeFakeElectron();
    expect(findKeyringProblem(electron, TEST_ARGS, true)).toBeUndefined();
    expect(calls).toEqual(["setUsePlainTextEncryption(true)"]);
  });

  it("never allows the fixed key with the inspector closed, as in the release package", () => {
    // The release package also refuses the switch before main gets here;
    // this is the second guard.
    const { electron, calls } = makeFakeElectron();
    expect(findKeyringProblem(electron, TEST_ARGS, false)?.message).toContain("no keyring");
    expect(calls).not.toContain("setUsePlainTextEncryption(true)");
  });

  it("never allows the fixed key without the switch, even with the inspector open", () => {
    const { electron, calls } = makeFakeElectron();
    expect(findKeyringProblem(electron, [], true)?.message).toContain("no keyring");
    expect(calls).not.toContain("setUsePlainTextEncryption(true)");
  });
});
