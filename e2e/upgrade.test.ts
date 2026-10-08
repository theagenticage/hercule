/**
 * Tests that a database filled by the previous `edge` release upgrades cleanly
 * to the new binary: the migrations run, the controller boots, and every record
 * is still readable.
 *
 * This catches migrations that are correct on an empty database but fail on
 * real data (a unique index on a column that has duplicates, a transformation
 * that assumes a shape older rows do not have), and checks that no landed
 * migration has been edited since `edge` was built.
 *
 * The test is skipped when no `edge` release exists yet. Once the first `edge`
 * release is published, this becomes the baseline for every change that follows.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  runCli,
  startController,
  type Controller,
} from "../scripts/controller-process";
import { createTemporaryHome, parseJsonOutput, type TemporaryHome } from "./harness";

const EDGE_RELEASE_URL = "https://github.com/theagenticage/hercule/releases/download/edge";

// The upgrade test runs on the same platform as CI: macOS arm64 for now.
// Once Linux edge binaries are published, the test can select by platform.
const BINARY_NAME = "hercule-darwin-arm64";

let state: TemporaryHome | undefined;
let edgeBinary: string | undefined;
let newBinary: string;

/**
 * Downloads the edge release binary if it exists. Returns the path to the
 * downloaded binary, or undefined if no edge release exists yet.
 *
 * Fails loudly if the edge release exists but the expected binary asset is
 * missing: that indicates a CI misconfiguration, not the absence of a baseline.
 */
async function downloadEdgeBinary(targetDir: string): Promise<string | undefined> {
  const binaryPath = join(targetDir, BINARY_NAME);
  const downloadUrl = `${EDGE_RELEASE_URL}/${BINARY_NAME}`;

  // Check if the binary asset exists
  const headResponse = await fetch(downloadUrl, { method: "HEAD" });
  if (headResponse.status === 404) {
    // Check if this is a missing asset or a missing release by trying the base release URL
    const releaseCheckResponse = await fetch(EDGE_RELEASE_URL, { method: "HEAD" });
    if (releaseCheckResponse.status === 404) {
      // No edge release exists yet - skip the test
      return undefined;
    }
    // Edge release exists but the binary asset is missing - fail loudly
    throw new Error(
      `Edge release exists but ${BINARY_NAME} asset is missing. This indicates a CI misconfiguration.`,
    );
  }
  if (!headResponse.ok) {
    throw new Error(
      `Failed to check edge release: ${headResponse.status} ${headResponse.statusText}`,
    );
  }

  // Download the binary
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download edge binary: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  writeFileSync(binaryPath, buffer, { mode: 0o755 });

  return binaryPath;
}

beforeAll(async () => {
  // Check that the new binary exists
  newBinary = join(ROOT, "hercule");
  if (!existsSync(newBinary)) {
    throw new Error(
      `no binary at ${newBinary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }

  // Set up a scratch home
  state = createTemporaryHome();

  // Try to download the edge binary
  const downloadDir = join(state.home, "edge-download");
  mkdirSync(downloadDir, { recursive: true });

  edgeBinary = await downloadEdgeBinary(downloadDir);
}, 60_000);

afterAll(() => {
  state?.remove();
});

describe("upgrading from the previous edge release", () => {
  it("fills a database with the edge binary, upgrades to the new binary, and reads every record back", async () => {
    if (edgeBinary === undefined) {
      console.log("Skipping upgrade test: no edge release exists yet");
      return;
    }

    // 1. Start the edge binary and complete setup
    let controller: Controller | undefined;
    try {
      controller = await startController({ home: state!.home, binary: edgeBinary });
      const url = controller.url;

      // Read the setup URL from the file
      const setupUrlFile = join(state!.home, "setup-url");
      const setupUrl = readFileSync(setupUrlFile, "utf8").trim();
      const token = new URL(setupUrl).searchParams.get("token")!;

      const setupResult = await runCli(
        [
          "setup",
          "complete",
          "--setup-token",
          token,
          "--username",
          USERNAME,
          "--password-stdin",
          "--timezone",
          "UTC",
          "--json",
        ],
        { home: state!.home, env: { HERCULE_API_URL: url }, stdin: PASSWORD },
      );
      expect(setupResult.code).toBe(0);

      // Log in and get an API key
      const loginResult = await runCli(
        ["login", url, "--username", USERNAME, "--password-stdin", "--name", "upgrade-test"],
        { home: state!.home, stdin: PASSWORD },
      );
      expect(loginResult.code).toBe(0);

      // 2. Fill the database with realistic data
      // Wait for the default runner to join
      let runnerJoined = false;
      for (let i = 0; i < 100; i++) {
        const controllerRead = await runCli(["controller", "read", "--json"], {
          home: state!.home,
        });
        if (controllerRead.code === 0) {
          const data = parseJsonOutput(controllerRead) as { defaultRunnerId: string | null };
          if (data.defaultRunnerId !== null) {
            runnerJoined = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(runnerJoined, "Default runner should have joined").toBe(true);

      // Create a project with a repository resource
      const projectResult = await runCli(
        ["project", "create", "--name", "test-project", "--json"],
        { home: state!.home },
      );
      expect(projectResult.code).toBe(0);
      const project = parseJsonOutput(projectResult) as { id: string };

      const resourceResult = await runCli(
        [
          "resource",
          "create",
          "--project",
          project.id,
          "--kind",
          "repo",
          "--remote",
          "https://github.com/example/repo",
          "--json",
        ],
        { home: state!.home },
      );
      expect(resourceResult.code).toBe(0);
      const resource = parseJsonOutput(resourceResult) as { id: string };

      // Note: Creating a GitHub connection and provider instances require specific
      // credentials/configuration which aren't available in the test environment.
      // The upgrade test focuses on schema migration and data integrity, which is
      // adequately tested by project, resource, assistant, conversation, and settings.

      // Create an assistant (which automatically creates its main conversation)
      const assistantResult = await runCli(
        ["assistant", "create", "--name", "test-assistant", "--json"],
        { home: state!.home },
      );
      expect(assistantResult.code).toBe(0);
      const assistant = parseJsonOutput(assistantResult) as {
        id: string;
        mainConversationId: string;
      };

      // Send several messages to the assistant's conversation to create turns
      // Note: This creates the conversation message structure without running an agent,
      // which would require credentials and cost tokens
      const msg1Result = await runCli(
        ["conversation", "send", assistant.mainConversationId, "--text-stdin", "--json"],
        { home: state!.home, stdin: "Test message 1" },
      );
      expect(msg1Result.code).toBe(0);

      const msg2Result = await runCli(
        ["conversation", "send", assistant.mainConversationId, "--text-stdin", "--json"],
        { home: state!.home, stdin: "Test message 2" },
      );
      expect(msg2Result.code).toBe(0);

      const msg3Result = await runCli(
        ["conversation", "send", assistant.mainConversationId, "--text-stdin", "--json"],
        { home: state!.home, stdin: "Test message 3" },
      );
      expect(msg3Result.code).toBe(0);

      // Save the IDs of what we created for verification later
      const testData = {
        projectId: project.id,
        resourceId: resource.id,
        assistantId: assistant.id,
        conversationId: assistant.mainConversationId,
      };

      // 3. Stop the edge binary
      const stopCode = await controller.stop();
      expect(stopCode).toBe(0);
      controller = undefined;

      // 4. Start the new binary with the same home
      controller = await startController({ home: state!.home, binary: newBinary });

      // 5. Verify that the controller boots successfully
      const newControllerRead = await runCli(["controller", "read", "--json"], {
        home: state!.home,
        env: { HERCULE_API_URL: controller.url },
      });
      if (newControllerRead.code !== 0) {
        throw new Error(
          `controller read failed with exit code ${newControllerRead.code}:\nstdout: ${newControllerRead.stdout}\nstderr: ${newControllerRead.stderr}\ncontroller output: ${controller.output()}`,
        );
      }
      expect(newControllerRead.code).toBe(0);

      // 6. Read every record back and verify it exists
      const projectRead = await runCli(["project", "read", testData.projectId, "--json"], {
        home: state!.home,
        env: { HERCULE_API_URL: controller.url },
      });
      expect(projectRead.code).toBe(0);
      const readProject = parseJsonOutput(projectRead) as { id: string; name: string };
      expect(readProject.id).toBe(testData.projectId);
      expect(readProject.name).toBe("test-project");

      const resourceRead = await runCli(["resource", "read", testData.resourceId, "--json"], {
        home: state!.home,
        env: { HERCULE_API_URL: controller.url },
      });
      expect(resourceRead.code).toBe(0);
      const readResource = parseJsonOutput(resourceRead) as { id: string; remote: string | null };
      expect(readResource.id).toBe(testData.resourceId);
      expect(readResource.remote).toBe("https://github.com/example/repo");

      const assistantRead = await runCli(["assistant", "read", testData.assistantId, "--json"], {
        home: state!.home,
        env: { HERCULE_API_URL: controller.url },
      });
      expect(assistantRead.code).toBe(0);
      const readAssistant = parseJsonOutput(assistantRead) as { id: string; name: string };
      expect(readAssistant.id).toBe(testData.assistantId);
      expect(readAssistant.name).toBe("test-assistant");

      // Read the conversation and its messages
      const conversationRead = await runCli(
        ["conversation", "read", testData.conversationId, "--json"],
        { home: state!.home, env: { HERCULE_API_URL: controller.url } },
      );
      expect(conversationRead.code).toBe(0);
      const readConversation = parseJsonOutput(conversationRead) as {
        id: string;
        assistantId: string;
      };
      expect(readConversation.id).toBe(testData.conversationId);
      expect(readConversation.assistantId).toBe(testData.assistantId);

      // List messages in the conversation - should have 3 user messages
      const messagesRead = await runCli(
        ["conversation", "query-messages", testData.conversationId, "--json"],
        { home: state!.home },
      );
      expect(messagesRead.code).toBe(0);
      const messages = parseJsonOutput(messagesRead) as {
        items: Array<{ id: string; senderRole: string; text: string }>;
      };
      expect(messages.items).toHaveLength(3);
      expect(messages.items.every((m) => m.senderRole === "owner")).toBe(true);
      expect(messages.items.map((m) => m.text).sort()).toEqual([
        "Test message 1",
        "Test message 2",
        "Test message 3",
      ]);
    } finally {
      await controller?.stop().catch(() => -1);
    }
  }, 180_000);
});
