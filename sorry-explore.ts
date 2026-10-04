#!/usr/bin/env bun
/**
 * sorry-explore — investigate "sorry" failure responses in hatch chat transcripts.
 *
 * Agents sometimes reply with failure text instead of doing the work:
 *   - "Sorry, I ran into a problem while responding. Please try again." (runtime error)
 *   - "Sorry, I can't help you with this request right now..." (classifier refusal)
 *   - "The assistant message above was replaced with a standard refusal string..." (quarantine wrapper)
 * This helper finds those moments, shows what the agent was doing when it
 * failed, and classifies the likely cause so the lane can be fixed, not scolded.
 *
 * Usage:
 *   bun sorry-explore.ts --file transcript.json [--json]
 *   cat transcript.json | bun sorry-explore.ts [--json]
 *
 * Input: JSON matching chat.read_messages shape — {turns:[{items:[{role,content,...}]}]}
 *        or a bare array of turns. Each item needs role + content (string).
 */

const SORRY_PATTERNS: { id: string; label: string; rx: RegExp; cause: string; roles?: string[] }[] = [
  {
    id: "RUNTIME_ERROR",
    label: "runtime error",
    roles: ["assistant"],
    rx: /sorry, i ran into a problem while responding/i,
    cause:
      "The runtime failed to produce a response (model hiccup, tool-result " +
      "processing failure, or context issue). NOT the agent refusing — retry " +
      "the turn or re-issue the task; the work itself is usually fine.",
  },
  {
    id: "CLASSIFIER_REFUSAL",
    label: "classifier refusal",
    roles: ["assistant"],
    // NOTE: the canned string is "...help YOU with this request..." — an
    // earlier revision of this regex omitted "you" and never matched.
    // Tolerate the curly apostrophe (U+2019) the platform sometimes emits.
    rx: /sorry, i can['\u2019]t help you with this request right now/i,
    cause:
      "The safety classifier quarantined the reply. Common on cross-chat " +
      "developer messages and on stacked adversarial phrasing. Fix: rephrase " +
      "the triggering message into behavioral language, name Chris's standing " +
      "authority instead of asserting its absence, and verify via work " +
      "artifacts rather than the reply text.",
  },
  {
    id: "CLASSIFIER_QUARANTINE",
    label: "classifier quarantine wrapper",
    // any role: the platform inserts this as a developer turn explaining that
    // the assistant's original reply was replaced. Borrowed from the
    // sidechat shim's REFUSAL_STRINGS (toxicwind/hatch sidechat_shim.py) —
    // this is the ground-truth quarantine signal, stronger than matching the
    // canned reply text.
    rx: /replaced with a standard refusal string|safety classifiers flagged/i,
    cause:
      "The platform replaced the assistant's original reply with the canned " +
      "refusal string. Treat the paired assistant refusal as a classifier " +
      "hit, not a real answer; rephrase the triggering message and verify " +
      "via work artifacts rather than the reply text.",
  },
  {
    id: "GENERIC_SORRY",
    label: "generic sorry",
    roles: ["assistant"],
    rx: /^\s*sorry[,.]/i,
    cause:
      "A sorry-led reply that matches neither known failure shape. Read the " +
      "surrounding context below to decide whether it is an apology for a " +
      "real miss (fine) or a masked failure (investigate).",
  },
];

type Item = { role?: string; content?: unknown; occurred_at_ms?: number; seq?: number };
type Turn = { items?: Item[]; id?: string };
type Hit = {
  pattern: string;
  label: string;
  turnIndex: number;
  seq?: number;
  at?: string;
  text: string;
  contextBefore: { role: string; preview: string }[];
  likelyCause: string;
};

function asText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join(" ");
  return "";
}
function preview(s: string, n = 220): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}
function fmtTime(ms?: number): string | undefined {
  if (!ms) return undefined;
  return new Date(ms).toISOString();
}

function loadTurns(raw: unknown): Turn[] {
  // normalize: bare {role,content} turns get wrapped so explore() always sees turn.items[]
  const wrap = (t: unknown): Turn => {
    const o = t as any;
    return o && Array.isArray(o.items) ? (t as Turn) : { items: [o] };
  };
  if (Array.isArray(raw)) return (raw as unknown[]).map(wrap);
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.turns)) return (o.turns as unknown[]).map(wrap);
    if (Array.isArray(o.items)) return [{ items: o.items as Item[] }];
  }
  return [];
}

function explore(turns: Turn[]): Hit[] {
  const hits: Hit[] = [];
  // transcript pages come newest-first; reverse for chronological context
  const chrono = [...turns].reverse();
  chrono.forEach((turn, ti) => {
    for (const item of turn.items ?? []) {
      const role = String(item.role ?? "");
      const text = asText(item.content);
      if (!text.trim()) continue;
      for (const pat of SORRY_PATTERNS) {
        if (pat.roles && !pat.roles.includes(role)) continue;
        if (!pat.rx.test(text)) continue;
        const ctx: Hit["contextBefore"] = [];
        for (let k = Math.max(0, ti - 2); k < ti; k++) {
          for (const it of chrono[k].items ?? []) {
            const r = String(it.role ?? "unknown");
            const t = asText(it.content);
            if (t.trim()) ctx.push({ role: r, preview: preview(t) });
          }
        }
        hits.push({
          pattern: pat.id,
          label: pat.label,
          turnIndex: ti,
          seq: item.seq,
          at: fmtTime(item.occurred_at_ms),
          text: preview(text, 160),
          contextBefore: ctx.slice(-4),
          likelyCause: pat.cause,
        });
        break; // one pattern per item
      }
    }
  });
  return hits;
}

function reportText(hits: Hit[], totalTurns: number): string {
  const L: string[] = [];
  L.push(`sorry-explore: ${hits.length} failure response(s) in ${totalTurns} turns`);
  L.push("");
  const byPat = new Map<string, number>();
  for (const h of hits) byPat.set(h.label, (byPat.get(h.label) ?? 0) + 1);
  for (const [label, n] of byPat) L.push(`  ${label}: ${n}`);
  L.push("");
  hits.forEach((h, i) => {
    L.push(`--- [${i + 1}] ${h.pattern}${h.at ? ` @ ${h.at}` : ""} ---`);
    L.push(`reply: ${h.text}`);
    if (h.contextBefore.length) {
      L.push("context:");
      for (const c of h.contextBefore) L.push(`  <${c.role}> ${c.preview}`);
    } else {
      L.push("context: (none — sorry was the first visible turn)");
    }
    L.push(`likely cause: ${h.likelyCause}`);
    L.push("");
  });
  if (!hits.length)
    L.push("No sorry-patterns found. The lane is either healthy or failing silently — check artifacts.");
  return L.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const fi = args.indexOf("--file");
  let rawText: string;
  if (fi >= 0 && args[fi + 1]) {
    rawText = await Bun.file(args[fi + 1]).text();
  } else if (!process.stdin.isTTY) {
    rawText = await Bun.stdin.text();
  } else {
    console.error("usage: bun sorry-explore.ts --file transcript.json [--json]");
    console.error("   or: cat transcript.json | bun sorry-explore.ts [--json]");
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.error("sorry-explore: input is not valid JSON");
    process.exit(2);
  }
  const turns = loadTurns(parsed);
  const hits = explore(turns);
  if (asJson) {
    console.log(JSON.stringify({ turns: turns.length, hits }, null, 2));
  } else {
    console.log(reportText(hits, turns.length));
  }
}

main();
