/** Runs a local Responses API fixture while Codex owns threads, tools and approvals. */
export const startMockModel = (version: "v1" | "v2", stopScenario = false) => {
  const calls = new Map<string, number>();
  const children = new Set<string>();
  const waitingChildren = new Set<string>();
  let followupSteps: Array<Record<string, unknown>> = [];
  let heldChildId: string | undefined;
  let rootThreadId: string | undefined;
  let branchThreadId: string | undefined;
  let sequence = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A held response sends one chunk and then nothing until the test lets it
    // go. Bun closes a connection after 10 idle seconds by default, which
    // would make Codex reconnect in the middle of a test.
    idleTimeout: 0,
    fetch(request) {
      if (request.method !== "POST") return Response.json({ data: [] });
      const threadId = request.headers.get("thread-id")!;
      rootThreadId ??= threadId;
      const child = threadId !== rootThreadId;
      if (child) children.add(threadId);
      if (child && stopScenario) branchThreadId ??= threadId;
      const call = (calls.get(threadId) ?? 0) + 1;
      calls.set(threadId, call);
      const responseId = `response-${++sequence}`;
      const items: Array<Record<string, unknown>> = [];
      if (!child && followupSteps.length > 0) {
        items.push(followupSteps.shift()!);
      } else if (!child && call === 2 && version === "v1") {
        items.push({
          type: "tool_search_call",
          call_id: "discover-subagents",
          execution: "client",
          arguments: { query: "spawn_agent", limit: 1 },
        });
      } else if (!child && call === (version === "v1" ? 3 : 2)) {
        for (const name of ["first", "second"]) {
          items.push({
            type: "function_call",
            namespace: version === "v1" ? "multi_agent_v1" : "collaboration",
            name: "spawn_agent",
            call_id: `spawn-${name}`,
            arguments: JSON.stringify(
              version === "v1"
                ? { message: `Child ${name}: ask approval, then finish.`, fork_context: true }
                : {
                    task_name: name,
                    message: `Child ${name}: ask approval, then finish.`,
                    fork_turns: "all",
                  },
            ),
          });
        }
      } else if (stopScenario && threadId === branchThreadId && version === "v1" && call === 1) {
        items.push({
          type: "tool_search_call",
          call_id: "discover-descendant",
          execution: "client",
          arguments: { query: "spawn_agent", limit: 1 },
        });
      } else if (
        stopScenario &&
        threadId === branchThreadId &&
        call === (version === "v1" ? 2 : 1)
      ) {
        items.push({
          type: "function_call",
          namespace: version === "v1" ? "multi_agent_v1" : "collaboration",
          name: "spawn_agent",
          call_id: "spawn-descendant",
          arguments: JSON.stringify(
            version === "v1"
              ? { message: "Descendant: ask approval, then finish.", fork_context: true }
              : {
                  task_name: "descendant",
                  message: "Descendant: ask approval, then finish.",
                  fork_turns: "all",
                },
          ),
        });
      } else if (
        child &&
        call === (stopScenario && threadId === branchThreadId ? (version === "v1" ? 3 : 2) : 1)
      ) {
        items.push({
          type: "function_call",
          name: "exec_command",
          call_id: `command-${threadId}`,
          arguments: JSON.stringify({
            cmd: "printf approved",
            sandbox_permissions: "require_escalated",
            justification: "Run the isolated fixture command?",
            login: false,
          }),
        });
      } else {
        items.push({
          type: "message",
          role: "assistant",
          id: `message-${sequence}`,
          content: [{ type: "output_text", text: child ? "Child done." : "Root done." }],
        });
      }
      const inputTokens = child ? 300 : call === 1 ? 1_000 : 100;
      const events = [
        { type: "response.created", response: { id: responseId } },
        ...items.map((item) => ({ type: "response.output_item.done", item })),
        {
          type: "response.completed",
          response: {
            id: responseId,
            usage: {
              input_tokens: inputTokens,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 10,
              output_tokens_details: null,
              total_tokens: inputTokens + 10,
            },
          },
        },
      ];
      if (
        threadId === heldChildId ||
        (stopScenario && !child && call > (version === "v1" ? 3 : 2))
      ) {
        waitingChildren.add(threadId);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(events[0])}\n\n`),
              );
            },
            cancel() {
              waitingChildren.delete(threadId);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    children,
    waitingChildren,
    /** Schedules native continuation of one existing child, optionally holding its model response. */
    scheduleFollowup: (childId: string, holdResponse: boolean) => {
      heldChildId = holdResponse ? childId : undefined;
      waitingChildren.clear();
      const callId = `followup-${sequence}`;
      followupSteps =
        version === "v2"
          ? [
              {
                type: "function_call",
                namespace: "collaboration",
                name: "followup_task",
                call_id: callId,
                arguments: JSON.stringify({
                  target: childId,
                  message: "Continue the fixture task.",
                }),
              },
            ]
          : [
              {
                type: "tool_search_call",
                call_id: `discover-${callId}`,
                execution: "client",
                arguments: { query: "resume_agent send_input", limit: 3 },
              },
              {
                type: "function_call",
                namespace: "multi_agent_v1",
                name: "resume_agent",
                call_id: `resume-${callId}`,
                arguments: JSON.stringify({ id: childId }),
              },
              {
                type: "function_call",
                namespace: "multi_agent_v1",
                name: "send_input",
                call_id: callId,
                arguments: JSON.stringify({
                  target: childId,
                  message: "Continue the fixture task.",
                }),
              },
            ];
    },
    config: [
      'model_provider = "fixture"',
      'model = "gpt-5.4"',
      "[features]",
      "multi_agent = true",
      `multi_agent_v2 = ${version === "v2"}`,
      ...(stopScenario ? ["[agents]", "max_depth = 2"] : []),
      "[model_providers.fixture]",
      'name = "Isolated fixture"',
      `base_url = "${server.url.toString()}v1"`,
      'env_key = "HERCULE_CODEX_FIXTURE_KEY"',
      'wire_api = "responses"',
      "supports_websockets = false",
    ].join("\n"),
    stop: () => server.stop(true),
  };
};
