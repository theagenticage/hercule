import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("model-switch", {}, {}, async (agy, ctx) => {
  const { sessionId, session } = await openSession(agy, { cwd: ctx.cwd });
  autoPermission(agy);
  const options: any[] = session.result.configOptions ?? [];
  const model = options.find((o) => o.id === "model");
  const other = model?.options?.find((o: any) => o.value !== model.currentValue)?.value;
  if (!other) throw new Error("no other model offered");
  const a = await agy.request("session/set_config_option", { sessionId, configId: "model", value: other });
  const b = await agy.request("session/set_config_option", { sessionId, configId: "thought_level", value: "low" });
  const c = await agy.request("session/set_config_option", { sessionId, configId: "model", value: "no-such-model-123" });
  agy.note("unknown model replied; prompting");
  const r = await prompt(agy, sessionId, "Say only the name of the model you are.");
  return `${summarize("model-switch", r)}; switched to ${other}: ${a.error ? "error" : "ok"}; thought_level: ${b.error ? "error" : "ok"}; unknown model: ${c.error ? JSON.stringify(c.error) : "accepted"}`;
});
