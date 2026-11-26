import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("question-variants", {}, {}, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  let answer: (m: any) => unknown = () => ({ action: "decline" });
  agy.onRequest((m) => {
    if (m.method === "elicitation/create") agy.respond(m.id, answer(m));
    else select(agy, m, "allow_once");
  });
  const firstConst = (m: any) => {
    const p = m.params?.requestedSchema?.properties?.q1;
    return p?.oneOf?.[0]?.const ?? p?.enum?.[0] ?? p?.items?.enum?.[0] ?? p?.items?.anyOf?.[0]?.const ?? "1";
  };
  answer = (m) => ({ action: "accept", content: { q1: firstConst(m) } });
  const r1 = await prompt(agy, sessionId, "Use your ask-question tool to ask me TWO questions in a single call: (1) which colour the banner should be (Red, Green, Blue), (2) which features to enable, as a multi-select (Dark mode, Search, Export). Then tell me what you received.");
  agy.note("prompt 1 replied; prompt 2 answers with q1_other only");
  answer = () => ({ action: "accept", content: { q1_other: "Purple" } });
  const r2 = await prompt(agy, sessionId, "Use your ask-question tool to ask me ONE question: which colour the banner should be (Red, Green, Blue). Then tell me what you received.");
  agy.note("prompt 2 replied; prompt 3 declines");
  answer = () => ({ action: "decline" });
  const r3 = await prompt(agy, sessionId, "Use your ask-question tool to ask me ONE question: which colour the banner should be (Red, Green, Blue). Then tell me what you received.");
  return [summarize("question-variants p1", r1), summarize("p2", r2), summarize("p3", r3)].join("; ");
});
