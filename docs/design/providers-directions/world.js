// PROTOTYPE - the fixture world of the Providers prototype (#405). Throwaway: nothing here is
// production code. Every variant and every sheet reads this one world, so the counts agree.
//
// The model it draws (a proposal for #404, not decided):
//   - An Account is who pays: one sign-in or key at a vendor (Anthropic · Work, OpenRouter).
//   - A Harness is the agent program on the machines (Claude Code, Codex, pi, OpenCode).
//   - A Model is what the user picks (Opus 5.5, GLM 5.3).
//   - A menu entry is one model, from one account, in one harness. The composer's model menu is
//     exactly this list, in this order.
//
// ?state= picks the moment:
//   ready     (default) set up, one account not yet on build-box-2
//   failed    Z.ai refused its key this morning
//   expiring  the Personal long-lived token ends in 12 days
//   empty     no account yet
(function () {
  var params = new URLSearchParams(location.search);
  var state = params.get("state") || "ready";

  var MACHINES = [
    { id: "studio-mac", kind: "laptop", note: "this Mac" },
    { id: "build-box-1", kind: "server", note: "Linux" },
    { id: "build-box-2", kind: "server", note: "Linux" },
  ];
  var ALL = MACHINES.map(function (m) { return m.id; });

  // The agent programs. Hercule installs and updates them on every machine (ADR 0028).
  var HARNESSES = [
    { id: "claude-code", name: "Claude Code", mark: "claude", version: "2.1.312", on: ALL, about: "Anthropic's agent. Claude models only." },
    { id: "codex", name: "Codex", mark: "codex", version: "0.165.0", on: ALL, about: "OpenAI's agent. Speaks the Responses API." },
    { id: "pi", name: "pi", mark: "pi", version: "1.0.4", on: ALL, about: "A small open agent. Takes almost any account." },
    { id: "opencode", name: "OpenCode", mark: "opencode", version: "1.19.2", on: ["studio-mac", "build-box-1"], about: "An open agent. Takes almost any account." },
  ];

  // What a vendor offers when you add an account of it, and how each sign-in reaches the fleet.
  // reach "fleet": Hercule holds the credential and hands it to every machine at session start.
  // reach "machine": each machine signs in and keeps its own login.
  var VENDORS = {
    anthropic: {
      name: "Anthropic", mark: "anthropic", offers: "Claude plans and API keys",
      methods: [
        { id: "token", name: "Long-lived token", reach: "fleet", about: "Sign in once in your browser. Hercule keeps the token and every machine uses it. It lasts a year; Hercule reminds you a month before it ends. The token can only run models, so your plan's usage windows stay hidden.", tag: "Best for several machines" },
        { id: "per-machine", name: "Sign in on each machine", reach: "machine", about: "Each machine keeps its own login and shows your usage windows. A login ends now and then, and that machine then needs you again." },
        { id: "key", name: "API key", reach: "fleet", about: "Pay per token from the Anthropic Console. Works on every machine." },
      ],
    },
    openai: {
      name: "OpenAI", mark: "openai", offers: "ChatGPT plans and API keys",
      methods: [
        { id: "chatgpt-shared", name: "Sign in with ChatGPT", reach: "fleet", about: "Sign in once in your browser. Hercule keeps the sign-in, renews it every hour, and hands each machine a fresh pass. A machine you add later needs one approval click, from here. Plus and Pro plans pay for Codex, pi and OpenCode.", tag: "Uses your plan" },
        { id: "chatgpt", name: "Codex sign-in on each machine", reach: "machine", about: "Codex's own login, kept on each machine and renewed there. Codex only." },
        { id: "key", name: "API key", reach: "fleet", about: "Pay per token from the OpenAI platform. Works on every machine." },
      ],
    },
    openrouter: { name: "OpenRouter", mark: "openrouter", offers: "466 models, paid from prepaid credits", methods: [{ id: "key", name: "API key", reach: "fleet", about: "Works on every machine." }] },
    zai: { name: "Z.ai", mark: "zai", offers: "The GLM Coding Plan", methods: [{ id: "key", name: "API key", reach: "fleet", about: "Works on every machine." }] },
    opencode: { name: "OpenCode", mark: "opencode", offers: "Go and Zen: open models by plan or by credit", methods: [{ id: "key", name: "API key", reach: "fleet", about: "Works on every machine." }] },
    bedrock: { name: "Amazon Bedrock", mark: "server", offers: "Claude and open models in your AWS account", methods: [] },
    vertex: { name: "Google Vertex AI", mark: "globe", offers: "Claude and Gemini in your Google Cloud project", methods: [] },
    local: { name: "A server on your network", mark: "server", offers: "llama.cpp, Ollama, LM Studio or any compatible URL", methods: [] },
  };

  var ACCOUNTS = [
    {
      id: "anthropic-personal", vendor: "anthropic", label: "Personal", plan: "Claude plan", who: "token made 12 Oct 2026",
      method: "token", reach: "fleet", made: "12 Oct 2026", ends: "12 Oct 2027", endsIn: "11 months",
      harnesses: ["claude-code"], only: "A Claude plan runs only in Claude Code, by Anthropic's terms.",
      usage: null, noUsage: "A token shows no usage windows", models: 14,
    },
    {
      id: "anthropic-work", vendor: "anthropic", label: "Work", plan: "Claude Team", who: "rogier@acme.com",
      method: "per-machine", reach: "machine", signedIn: ["studio-mac", "build-box-1"],
      harnesses: ["claude-code"], only: "A Claude plan runs only in Claude Code, by Anthropic's terms.",
      usage: { pct: 61, window: "5-hour window", resets: "11:00" }, weekly: { pct: 38, resets: "Mon" }, models: 14,
    },
    {
      id: "openai-personal", vendor: "openai", label: "Personal", plan: "ChatGPT Pro", who: "rogier@fastmail.com",
      method: "chatgpt-shared", reach: "fleet",
      harnesses: ["codex", "pi", "opencode"], only: "A ChatGPT plan runs in Codex, pi and OpenCode. Claude Code takes Claude models only.",
      usage: { pct: 41, window: "weekly limit", resets: "Mon" }, models: 9,
    },
    {
      id: "openai-work", vendor: "openai", label: "Work", plan: "ChatGPT Business", who: "rogier@acme.com",
      method: "chatgpt-shared", reach: "fleet",
      harnesses: ["codex", "pi", "opencode"], only: "A ChatGPT plan runs in Codex, pi and OpenCode. Claude Code takes Claude models only.",
      usage: { pct: 27, window: "weekly limit", resets: "Tue" }, models: 11,
    },
    {
      id: "zai", vendor: "zai", label: null, plan: "GLM Coding Plan Pro", who: "key ····7c2e",
      method: "key", reach: "fleet", harnesses: ["claude-code", "codex", "pi", "opencode"],
      usage: { pct: 22, window: "5-hour window", resets: "13:10" }, weekly: { pct: 14, resets: "Sun" }, models: 2,
    },
    {
      id: "opencode-go", vendor: "opencode", label: "Go", name: "OpenCode Go", plan: "Go plan", who: "key ····19be",
      method: "key", reach: "fleet", harnesses: ["opencode", "pi", "claude-code", "codex"],
      usage: { pct: 9, window: "weekly limit", resets: "Thu" }, models: 11,
    },
    {
      id: "openrouter", vendor: "openrouter", label: null, plan: "Credits", who: "key ····a91f",
      method: "key", reach: "fleet", harnesses: ["pi", "opencode", "codex", "claude-code"],
      only: "Claude Code runs only Claude models through OpenRouter.",
      balance: "$43.20 left", models: 466,
    },
  ];

  // The failure and expiry moments change one account each.
  // ?opencode=0 is the world before a second open harness: pi is then the only one, so the
  // page asks nothing about a default for open models.
  if (params.get("opencode") === "0") {
    HARNESSES.splice(3, 1);
    ACCOUNTS.forEach(function (a) { a.harnesses = a.harnesses.filter(function (h) { return h !== "opencode"; }); });
  }

  if (state === "failed") {
    var z = ACCOUNTS.filter(function (a) { return a.id === "zai"; })[0];
    z.failed = { at: "09:14", what: "Z.ai refused the key", detail: "401 Unauthorized: token expired or incorrect" };
  }
  if (state === "expiring") {
    var p = ACCOUNTS.filter(function (a) { return a.id === "anthropic-personal"; })[0];
    p.ends = "9 Nov 2026";
    p.endsIn = "12 days";
    p.expiring = true;
  }

  // The catalog: every model your accounts offer, by family. `from` lists [account, harnesses]
  // for each account that offers it. Older models are the ones the harness still accepts but
  // no longer lists first.
  var CC = ["claude-code"];
  var GPT_H = ["codex", "pi", "opencode"];
  var OPEN_H = ["pi", "opencode", "codex", "claude-code"];
  var OR_H = ["pi", "opencode", "codex"];
  var CLAUDE_FROM = [["anthropic-personal", CC], ["anthropic-work", CC], ["openrouter", ["claude-code", "pi", "opencode"]]];
  var MODELS = [
    { id: "opus-5-5", family: "Claude", name: "Opus 5.5", slug: "claude-opus-5-5", from: CLAUDE_FROM, caps: ["Images", "Effort", "Fast"], tier: "Most capable", newest: true },
    { id: "sonnet-5-5", family: "Claude", name: "Sonnet 5.5", slug: "claude-sonnet-5-5", from: CLAUDE_FROM, caps: ["Images", "Effort"], tier: "Everyday", newest: true },
    { id: "haiku-5-5", family: "Claude", name: "Haiku 5.5", slug: "claude-haiku-5-5", from: CLAUDE_FROM, caps: ["Images"], tier: "Fast and cheap", newest: true },
    { id: "fable-5-1", family: "Claude", name: "Fable 5.1", slug: "claude-fable-5-1", from: CLAUDE_FROM, caps: ["Images", "Effort"], tier: "Long writing", newest: true },
    { id: "opus-5", family: "Claude", name: "Opus 5", slug: "claude-opus-5", from: CLAUDE_FROM, older: true },
    { id: "sonnet-5", family: "Claude", name: "Sonnet 5", slug: "claude-sonnet-5", from: CLAUDE_FROM, older: true },
    { id: "fable-5", family: "Claude", name: "Fable 5", slug: "claude-fable-5", from: CLAUDE_FROM, older: true },
    { id: "opus-4-8", family: "Claude", name: "Opus 4.8", slug: "claude-opus-4-8", from: CLAUDE_FROM, older: true },
    { id: "opus-4-7", family: "Claude", name: "Opus 4.7", slug: "claude-opus-4-7", from: CLAUDE_FROM, older: true },
    { id: "opus-4-6", family: "Claude", name: "Opus 4.6", slug: "claude-opus-4-6", from: CLAUDE_FROM, older: true },
    { id: "opus-4-5", family: "Claude", name: "Opus 4.5", slug: "claude-opus-4-5", from: CLAUDE_FROM, older: true },
    { id: "sonnet-4-6", family: "Claude", name: "Sonnet 4.6", slug: "claude-sonnet-4-6", from: CLAUDE_FROM, older: true },
    { id: "sonnet-4-5", family: "Claude", name: "Sonnet 4.5", slug: "claude-sonnet-4-5", from: CLAUDE_FROM, older: true },
    { id: "haiku-4-5", family: "Claude", name: "Haiku 4.5", slug: "claude-haiku-4-5", from: CLAUDE_FROM, older: true },

    { id: "gpt-6-1-sol", family: "GPT", name: "GPT-6.1 Sol", slug: "gpt-6.1-sol", from: [["openai-personal", GPT_H], ["openai-work", GPT_H], ["openrouter", OR_H]], caps: ["Images", "Effort", "Fast"], tier: "Most capable", newest: true },
    { id: "gpt-6-luna", family: "GPT", name: "GPT-6 Luna", slug: "gpt-6-luna", from: [["openai-personal", GPT_H], ["openai-work", GPT_H], ["openrouter", OR_H]], caps: ["Images", "Effort"], tier: "Fast", newest: true },
    { id: "gpt-6-astra", family: "GPT", name: "GPT-6 Astra", slug: "gpt-6-astra", from: [["openai-personal", GPT_H], ["openai-work", GPT_H]], caps: ["Images", "Effort"], tier: "Long tasks", newest: true, fresh: "26 Oct" },
    { id: "gpt-5-6-sol", family: "GPT", name: "GPT-5.6 Sol", slug: "gpt-5.6-sol", from: [["openai-personal", GPT_H], ["openai-work", GPT_H], ["openrouter", OR_H]], older: true },
    { id: "gpt-5-6-luna", family: "GPT", name: "GPT-5.6 Luna", slug: "gpt-5.6-luna", from: [["openai-personal", GPT_H], ["openai-work", GPT_H]], older: true },
    { id: "gpt-5-5", family: "GPT", name: "GPT-5.5", slug: "gpt-5.5", from: [["openai-personal", GPT_H], ["openai-work", GPT_H], ["openrouter", OR_H]], older: true },
    { id: "gpt-5-4", family: "GPT", name: "GPT-5.4", slug: "gpt-5.4", from: [["openai-personal", GPT_H], ["openai-work", GPT_H], ["openrouter", OR_H]], older: true },
    { id: "gpt-5-4-mini", family: "GPT", name: "GPT-5.4 mini", slug: "gpt-5.4-mini", from: [["openai-personal", GPT_H], ["openai-work", GPT_H]], older: true },

    { id: "daybreak", family: "GPT", name: "Daybreak", slug: "daybreak-1", from: [["openai-work", GPT_H]], caps: ["Images", "Effort"], tier: "Business only", newest: true },
    { id: "daybreak-mini", family: "GPT", name: "Daybreak mini", slug: "daybreak-1-mini", from: [["openai-work", GPT_H]], caps: ["Effort"], tier: "Business only", newest: true },
    { id: "glm-5-3", family: "GLM", name: "GLM 5.3", slug: "glm-5.3", from: [["zai", OPEN_H], ["opencode-go", OPEN_H], ["openrouter", OR_H]], caps: ["Effort"], tier: "Open, strong at code", newest: true, open: true },
    { id: "glm-5-3-flash", family: "GLM", name: "GLM 5.3 Flash", slug: "glm-5.3-flash", from: [["zai", OPEN_H], ["openrouter", OR_H]], caps: [], tier: "Open, fast", newest: true, open: true },
    { id: "glm-5-2", family: "GLM", name: "GLM 5.2", slug: "glm-5.2", from: [["openrouter", OR_H]], older: true, open: true },
    { id: "glm-4-7", family: "GLM", name: "GLM 4.7", slug: "glm-4.7", from: [["openrouter", OR_H], ["opencode-go", OPEN_H]], older: true, open: true },
    { id: "kimi-k3", family: "Kimi", name: "Kimi K3", slug: "kimi-k3", from: [["opencode-go", OPEN_H], ["openrouter", OR_H]], caps: ["Images"], tier: "Open, long context", newest: true, open: true },
    { id: "kimi-k2-6", family: "Kimi", name: "Kimi K2.6", slug: "kimi-k2.6", from: [["opencode-go", OPEN_H], ["openrouter", OR_H]], older: true, open: true },
    { id: "qwen-3-6-coder", family: "Qwen", name: "Qwen 3.6 Coder", slug: "qwen3.6-coder", from: [["opencode-go", OPEN_H], ["openrouter", OR_H]], caps: [], tier: "Open, code", newest: true, open: true },
    { id: "deepseek-v4", family: "DeepSeek", name: "DeepSeek V4", slug: "deepseek-v4", from: [["opencode-go", OPEN_H], ["openrouter", OR_H]], caps: ["Effort"], tier: "Open, reasoning", newest: true, open: true },
    { id: "minimax-m3", family: "MiniMax", name: "MiniMax M3", slug: "minimax-m3", from: [["opencode-go", OPEN_H], ["openrouter", OR_H]], caps: [], tier: "Open, agentic", newest: true, open: true },
  ];

  // OpenRouter's long tail: families only it offers here, with how many models each has. The
  // catalog draws a few rows of each and counts the rest, so 466 never means 466 rows.
  var LONG_TAIL = [
    ["Gemini", ["Gemini 3.5 Pro", "Gemini 3.5 Flash", "Gemini 3 Pro"], 21],
    ["Grok", ["Grok 5", "Grok 5 Fast", "Grok Code 2"], 14],
    ["Mistral", ["Devstral 3", "Mistral Large 4", "Codestral 3"], 38],
    ["Llama", ["Llama 5 Maverick", "Llama 5 Scout"], 41],
    ["Qwen", ["Qwen 3.6 Max", "Qwen 3.5 Coder 480B"], 47],
    ["DeepSeek", ["DeepSeek V4 Flash", "DeepSeek R3"], 19],
    ["Others", ["Command A+", "Nova Pro 2", "Hermes 5", "Jamba 2"], 254],
  ];

  // The model menu: what the composer offers, in this order. The first is the default for new threads.
  var MENU = [
    { model: "opus-5-5", account: "anthropic-personal", harness: "claude-code", isDefault: true },
    { model: "sonnet-5-5", account: "anthropic-personal", harness: "claude-code" },
    { model: "opus-5-5", account: "anthropic-work", harness: "claude-code" },
    { model: "gpt-6-1-sol", account: "openai-personal", harness: "codex" },
    { model: "gpt-6-1-sol", account: "openai-personal", harness: "pi" },
    { model: "glm-5-3", account: "zai", harness: "pi" },
    { model: "kimi-k3", account: "opencode-go", harness: "opencode" },
  ];

  if (state === "empty") {
    ACCOUNTS.length = 0;
    MENU.length = 0;
  }

  /* ------------------------------------------------------------------ helpers */

  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function account(id) { return byId(ACCOUNTS, id); }
  function harness(id) { return byId(HARNESSES, id); }
  function model(id) { return byId(MODELS, id); }

  /** Returns an account's name: the vendor, then its label when it has one ("Anthropic · Work"). */
  function accountName(a) {
    if (a.name) return a.name;
    var v = VENDORS[a.vendor].name;
    return a.label ? v + " · " + a.label : v;
  }

  /** Returns the machines an account reaches: all of them for a fleet credential, else the ones signed in. */
  function accountMachines(a) {
    return a.reach === "fleet" ? ALL : a.signedIn || [];
  }

  /** Returns the machines an entry can run on: where its account reaches and its harness is installed. */
  function entryMachines(e) {
    var a = account(e.account), h = harness(e.harness);
    return accountMachines(a).filter(function (m) { return h.on.indexOf(m) !== -1; });
  }

  /**
   * Returns an entry's name in the menu. A model that appears once is just its name. When the
   * same model appears more than once, each entry adds the one fact that tells them apart: the
   * account when the accounts differ, else the harness.
   */
  function entryName(e) {
    var m = model(e.model);
    var twins = MENU.filter(function (x) { return x.model === e.model && x !== e; });
    if (!twins.length) return m.name;
    var accountsDiffer = twins.some(function (x) { return x.account !== e.account; });
    if (accountsDiffer) return m.name + " · " + (account(e.account).label || VENDORS[account(e.account).vendor].name);
    return m.name + " · " + harness(e.harness).name;
  }

  /**
   * Returns what keeps an entry from running everywhere, or null when nothing does:
   * a failed account first, then the machines it cannot reach and why.
   */
  function entryProblem(e) {
    var a = account(e.account), h = harness(e.harness);
    if (a.failed) return { kind: "fail", text: a.failed.what, short: "Key refused" };
    var missing = ALL.filter(function (m) { return entryMachines(e).indexOf(m) === -1; });
    if (!missing.length) return null;
    var why = accountMachines(a).indexOf(missing[0]) === -1
      ? accountName(a) + " is not signed in there"
      : h.name + " is not installed there";
    return { kind: "you", text: "Not on " + missing.join(", "), why: why, short: "Not on " + missing.join(", ") };
  }

  /** Returns the accounts that offer a model, with the harnesses each can run it in. */
  function routesOf(m) {
    return m.from
      .filter(function (f) { return account(f[0]); })
      .map(function (f) { return { account: account(f[0]), harnesses: f[1].filter(function (h) { return account(f[0]).harnesses.indexOf(h) !== -1; }) }; });
  }

  /** Returns how many models all accounts offer together, counting OpenRouter's long tail. */
  function catalogCount() {
    return ACCOUNTS.length ? 531 : 0;
  }

  /* ------------------------------------------------------------------ variant D and the catalog */

  // The projects of the book's world. Variant D lets each one pick the account it pays with.
  var PROJECTS = [
    { id: "webshop", rug: "webshop" },
    { id: "payments-api", rug: "payments" },
    { id: "ops", rug: "ops" },
  ];

  // How much a model holds and what OpenRouter charges, for the catalog's second line.
  var META = {
    "opus-5-5": "1M context", "sonnet-5-5": "1M context", "haiku-5-5": "200K context", "fable-5-1": "1M context",
    "gpt-6-1-sol": "400K context", "gpt-6-luna": "400K context", "gpt-6-astra": "1M context",
    "glm-5-3": "1M context", "glm-5-3-flash": "200K context", "kimi-k3": "512K context",
    "qwen-3-6-coder": "256K context", "deepseek-v4": "256K context", "minimax-m3": "1M context",
  };
  var PRICE = {
    "opus-5-5": "$5 / $25", "sonnet-5-5": "$3 / $15", "haiku-5-5": "$1 / $5", "fable-5-1": "$4 / $20",
    "gpt-6-1-sol": "$2.50 / $15", "gpt-6-luna": "$0.40 / $1.60", "glm-5-3": "$0.60 / $2.20", "glm-5-3-flash": "$0.08 / $0.40",
    "kimi-k3": "$0.80 / $3.20", "qwen-3-6-coder": "$0.45 / $1.80", "deepseek-v4": "$0.30 / $1.20", "minimax-m3": "$0.35 / $1.40",
  };

  // OpenRouter's long tail, made up but shaped like the real list: families, newest first, then
  // their older and smaller variants. Together with the shared models above it makes 466.
  var TAIL_FAMILIES = [
    ["Gemini", ["Gemini 3.5 Pro", "Gemini 3.5 Flash", "Gemini 3 Pro", "Gemini 3 Flash", "Gemini 2.5 Pro", "Gemini 2.5 Flash"]],
    ["Grok", ["Grok 5", "Grok 5 Fast", "Grok Code 2", "Grok 4.2", "Grok 4"]],
    ["Mistral", ["Devstral 3", "Mistral Large 4", "Codestral 3", "Mistral Medium 4", "Magistral 2", "Ministral 3"]],
    ["Llama", ["Llama 5 Maverick", "Llama 5 Scout", "Llama 4.1 Behemoth", "Llama 4 Maverick", "Llama 3.3"]],
    ["Qwen", ["Qwen 3.6 Max", "Qwen 3.5 Coder 480B", "Qwen 3.5 Plus", "Qwen 3.5 VL", "QwQ 2"]],
    ["DeepSeek", ["DeepSeek V4 Flash", "DeepSeek R3", "DeepSeek V3.2", "DeepSeek R2"]],
    ["Others", ["Command A+", "Nova Pro 2", "Hermes 5", "Jamba 2", "Phi 5", "Gemma 4", "Olmo 3", "Granite 5", "Sonar Pro 2", "Reka Core 3", "Ernie 5", "Hunyuan T2", "Step 3", "Seed 2", "Ling 2", "Arcee Coder"]],
  ];
  var VARIANTS = ["", " Instruct", " Mini", " Turbo", " 8B", " 70B", " Preview", " Thinking", " Lite", " (free)", " Vision", " Nano"];
  var TAIL = [];
  (function buildTail() {
    var target = 466 - MODELS.filter(function (m) { return m.from.some(function (f) { return f[0] === "openrouter"; }); }).length;
    var round = 0;
    while (TAIL.length < target && round < VARIANTS.length) {
      TAIL_FAMILIES.forEach(function (f) {
        f[1].forEach(function (base, i) {
          if (TAIL.length >= target) return;
          var name = base + VARIANTS[round];
          var id = "or-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
          var h = Crew.hash(id);
          TAIL.push({
            id: id, family: f[0], name: name, slug: id.slice(3), from: [["openrouter", OR_H]],
            older: round > 0 || i > 1, newest: round === 0 && i <= 1, tail: true,
            meta: [128, 200, 256, 400, 1000][h % 5] + "K context",
            price: "$" + ((h % 90) / 20 + 0.05).toFixed(2) + " / $" + ((h % 90) / 5 + 0.2).toFixed(2),
          });
        });
      });
      round++;
    }
  })();
  var CATALOG = MODELS.concat(TAIL);
  CATALOG.forEach(function (m) {
    if (!m.meta) m.meta = META[m.id] || (m.older ? "older" : "");
    if (!m.price) m.price = PRICE[m.id] || "";
  });
  MODELS.forEach(function (m) {
    if (!META[m.id]) m.meta = m.older ? "" : m.meta;
  });

  /** Returns the vendors that hold at least one account, in a fixed order. */
  function vendorsInUse() {
    return ["anthropic", "openai", "zai", "opencode", "openrouter"].filter(function (v) {
      return ACCOUNTS.some(function (a) { return a.vendor === v; });
    });
  }
  /** Returns the accounts of one vendor. */
  function accountsOf(vendor) {
    return ACCOUNTS.filter(function (a) { return a.vendor === vendor; });
  }
  /** Returns every catalog model a vendor's accounts offer. */
  function modelsOf(vendor) {
    return CATALOG.filter(function (m) {
      return m.from.some(function (f) { var a = account(f[0]); return a && a.vendor === vendor; });
    });
  }
  /** Returns a catalog model by id, the long tail included. A menu entry may carry a harness after "@" ("gpt-6-1-sol@pi"); it is ignored here. */
  function catalogModel(id) { return byId(CATALOG, String(id).split("@")[0]); }

  window.World = {
    state: state,
    MACHINES: MACHINES, ALL: ALL, HARNESSES: HARNESSES, VENDORS: VENDORS, ACCOUNTS: ACCOUNTS,
    MODELS: MODELS, LONG_TAIL: LONG_TAIL, MENU: MENU,
    account: account, harness: harness, model: model,
    accountName: accountName, accountMachines: accountMachines, entryMachines: entryMachines,
    entryName: entryName, entryProblem: entryProblem, routesOf: routesOf, catalogCount: catalogCount,
    PROJECTS: PROJECTS, CATALOG: CATALOG, vendorsInUse: vendorsInUse, accountsOf: accountsOf, modelsOf: modelsOf, catalogModel: catalogModel,
    // The harness for models that have none of their own. Set once, under Harnesses.
    openHarness: "pi",
  };
})();
