import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
import { startProxy } from "../proxy.ts";

const proxy = await startProxy();
await runScenario(
  "failed-turn-network",
  { "one.txt": "File one: apples are red.\n", "two.txt": "File two: bananas are yellow.\n", "three.txt": "File three: grapes are purple.\n" },
  { proxy },
  async (agy, ctx) => {
    const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
    autoPermission(agy);
    const start = agy.messages.length;
    let result: any;
    const reply = prompt(agy, sessionId, "Read the files one.txt, two.txt and three.txt one by one (one read per step), then summarise them in one sentence.").then((m) => (result = m));
    await agy.waitFor(isUpdate("tool_call"), 120_000, start);
    agy.note("first tool_call arrived; cutting the proxy");
    proxy.cut();
    const early = await Promise.race([reply, sleep(90_000).then(() => undefined)]);
    agy.note(early ? "prompt replied during the 90s" : "90s passed; sending session/cancel");
    if (!early) agy.notify("session/cancel", { sessionId });
    await Promise.race([reply, sleep(10_000)]);
    return `${result ? summarize("failed-turn-network", result) : "failed-turn-network: prompt never replied, even after cancel + 10s"}; replied before cancel=${Boolean(early)}; tunnelled hosts: ${[...new Set(proxy.hosts)].join(", ")}`;
  },
);
await proxy.close();
