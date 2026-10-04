#!/usr/bin/env bun
/**
 * remake — clear memory and remake with a completions model.
 *
 * When an LLM agent hits a "sorry" failure (runtime error, classifier refusal),
 * retrying with the same bloated or corrupted context usually re-triggers it.
 * The fix is not a retry — it's a reset:
 *
 *   1. CLEAR the memory: drop the transcript history, keep only the intent.
 *   2. REMAKE the request: fresh completions call with clean context.
 *
 * Usage:
 *   bun remake.ts --file transcript.json [--model <id>] [--endpoint <url>] [--json] [--newest-first]
 *   echo '{"turns":[...]}' | bun remake.ts [--model <id>]
 *   bun remake.ts --prompt "summarize this" [--model <id>]
 *
 * Use --newest-first when piping chat.read_messages pages (which are newest-first).
 *
 * Defaults:
 *   endpoint: http://127.0.0.1:18301/herd/v1/chat/completions (yote herd router via the cell's yote-connector proxy)
 *   model:    first available from the endpoint's /v1/models
 */

// --- sorry patterns (shared with sorry-explore.ts) ---
const SORRY_PATTERNS = [
  { id: "RUNTIME_ERROR", rx: /sorry, i ran into a problem while responding/i },
  { id: "CLASSIFIER_REFUSAL", rx: /sorry, i can't help with this request right now/i },
  { id: "GENERIC_SORRY", rx: /^\s*sorry[,.]/i },
];

type Item = { role?: string; content?: unknown };
type Turn = { items?: Item[]; role?: string; content?: unknown };

function asText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c.map(p => (typeof p === "string" ? p : (p as any)?.text ?? "")).join("");
  if (c && typeof c === "object") return (c as any).text ?? JSON.stringify(c);
  return String(c ?? "");
}

function flattenTurns(raw: unknown, newestFirst: boolean): Item[] {
  // normalize every input shape to a flat chronological item list
  const wrap = (t: any): Item[] =>
    Array.isArray(t?.items) ? t.items : t?.role ? [{ role: t.role, content: t.content }] : [];
  let turns: any[] = [];
  if (Array.isArray(raw)) turns = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as any;
    if (Array.isArray(o.turns)) turns = o.turns;
    else if (Array.isArray(o.items)) return o.items;
  }
  // chat.read_messages pages are newest-first; reverse those for chronological
  const ordered = newestFirst ? [...turns].reverse() : turns;
  return ordered.flatMap(wrap);
}

function findFailure(items: Item[]): { index: number; pattern: string } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (String(it.role) !== "assistant") continue;
    const text = asText(it.content);
    for (const p of SORRY_PATTERNS) {
      if (p.rx.test(text)) return { index: i, pattern: p.id };
    }
  }
  return null;
}

function extractIntent(items: Item[], failureIndex: number | null): string {
  // the intent is the last user message before the failure (or the last user message overall)
  const end = failureIndex ?? items.length;
  for (let i = end - 1; i >= 0; i--) {
    const it = items[i];
    if (String(it.role) === "user") {
      const t = asText(it.content).trim();
      if (t) return t;
    }
  }
  return "";
}

async function getModels(endpoint: string): Promise<string[]> {
  const base = endpoint.replace(/\/v1\/chat\/completions\/?$/, "").replace(/\/v1\/completions\/?$/, "");
  const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`models endpoint ${res.status}`);
  const data = (await res.json()) as any;
  return (data.data ?? []).map((m: any) => m.id).filter(Boolean);
}

async function remake(
  intent: string,
  endpoint: string,
  model: string,
): Promise<{ text: string; model: string; cleared: number }> {
  // CLEAR: fresh context — system + intent only. No history. That's the whole point.
  const messages = [
    { role: "system", content: "You are a helpful assistant. Answer directly and completely." },
    { role: "user", content: intent },
  ];
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: 2000, temperature: 0.7 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`completions ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const text = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? "";
  return { text: String(text).trim(), model, cleared: 0 };
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const getArg = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const endpoint =
    getArg("--endpoint") ?? process.env.REMAKE_ENDPOINT ?? "http://127.0.0.1:18301/herd/v1/chat/completions";
  let model = getArg("--model") ?? process.env.REMAKE_MODEL;
  const newestFirst = args.includes("--newest-first");

  // --- input ---
  let intent = getArg("--prompt") ?? "";
  let clearedCount = 0;
  let failurePattern: string | null = null;

  if (!intent) {
    let raw = "";
    const file = getArg("--file");
    if (file) raw = await Bun.file(file).text();
    else raw = await Bun.stdin.text();
    if (!raw.trim()) {
      console.error("remake: provide --prompt, --file, or pipe transcript JSON on stdin");
      process.exit(2);
    }
    const parsed = JSON.parse(raw);
    const items = flattenTurns(parsed, newestFirst);
    clearedCount = items.length;
    const failure = findFailure(items);
    if (failure) failurePattern = failure.pattern;
    intent = extractIntent(items, failure?.index ?? null);
    if (!intent) {
      console.error("remake: no user intent found in transcript");
      process.exit(2);
    }
  }

  // --- model ---
  if (!model) {
    const models = await getModels(endpoint);
    if (!models.length) throw new Error("no models available at endpoint");
    model = models[0];
  }

  // --- remake ---
  const result = await remake(intent, endpoint, model);
  result.cleared = clearedCount;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          model: result.model,
          failurePattern,
          clearedMessages: result.cleared,
          intent: intent.slice(0, 200),
          remake: result.text,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`remake: cleared ${result.cleared} message(s)` + (failurePattern ? ` (was ${failurePattern})` : ""));
    console.log(`remake: model ${result.model}`);
    console.log(`---`);
    console.log(result.text);
  }
}

main().catch(e => {
  console.error(`remake: ${e.message}`);
  process.exit(1);
});
