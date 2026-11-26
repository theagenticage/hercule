import { prompt, summarize, autoPermission, sleep, isUpdate, FULL_ACCESS } from "../agy-session.ts";
import { startProxy } from "../proxy.ts";
import { run1283, quotaHit } from "../lib1283.ts";
const proxy = await startProxy();
await run1283("failed-turn-network-watch",
  { flags: FULL_ACCESS, proxy, files: { "one.txt": "File one: apples are red.\n", "two.txt": "File two: bananas are yellow.\n", "three.txt": "File three: grapes are purple.\n" } },
  async (agy, ctx) => {
    autoPermission(agy);
    const start = agy.messages.length;
    let result: any;
    const reply = prompt(agy, ctx.sessionId, "Read the files one.txt, two.txt and three.txt one by one (one read per step), then summarise them in one sentence.").then((m) => { result = m; agy.note(`PROMPT REPLIED ${JSON.stringify(m).slice(0, 500)}`); });
    await agy.waitFor(isUpdate("tool_call"), 120_000, start);
    agy.note("first tool_call arrived; cutting the proxy");
    proxy.cut();
    const early = await Promise.race([reply, sleep(90_000).then(() => undefined)]);
    agy.note(early ? "prompt replied during the 90s" : "90s passed; sending session/cancel");
    if (!early) agy.notify("session/cancel", { sessionId: ctx.sessionId });
    await Promise.race([reply, sleep(10_000)]);
    agy.note("reply seen (or not); keeping agy running 60s");
    await sleep(60_000);
    return `${result ? summarize("p", result) : "no reply"}; replied before cancel=${Boolean(early)} quota=${quotaHit(agy)}`;
  });
await proxy.close();
