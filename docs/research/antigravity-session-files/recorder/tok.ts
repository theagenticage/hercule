import { readFileSync } from "node:fs";
const [rec, tr] = process.argv.slice(2);
const replies = readFileSync(rec,"utf8").trim().split("\n").map(l=>JSON.parse(l)).filter(r=>r.direction==="in"&&r.message.result?.usage).map(r=>({t:r.t,u:r.message.result.usage,stop:r.message.result.stopReason}));
const steps = readFileSync(tr,"utf8").trim().split("\n").map(l=>JSON.parse(l));
const pr = steps.filter(s=>s.type==="PLANNER_RESPONSE");
const users = steps.filter(s=>s.type==="USER_INPUT").map(s=>s.step_index);
console.log("replies",replies.length,"userInputs at",users.join(","));
// per prompt: split planner responses by user input index
const bounds=[...users,Infinity];
for(let i=0;i<users.length;i++){const sel=pr.filter(s=>s.step_index>bounds[i]&&s.step_index<bounds[i+1]);const sum=(k:string)=>sel.reduce((a,s)=>a+(s[k]??0),0);
 const r=replies[i]; console.log(`prompt ${i}: steps ${sel.map(s=>s.step_index)} sum in=${sum("input_tokens")} cache=${sum("cache_read_tokens")} out=${sum("output_tokens")} | reply in=${r?.u.inputTokens} cached=${r?.u.cachedReadTokens} out=${r?.u.outputTokens} thought=${r?.u.thoughtTokens} total=${r?.u.totalTokens} (${r?.stop})`)}
console.log("planner responses carry:",Object.keys(pr[0]??{}).join(","));
