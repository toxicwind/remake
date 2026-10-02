# remake

**When your LLM agent says "sorry," don't retry. Remake.**

`remake` recovers from agent failures by doing what retry can't: it **clears the corrupted memory** and remakes the request as a fresh completions call.

## The problem

LLM agents fail with "Sorry, I ran into a problem while responding." The instinct is to retry. But retry re-sends the same bloated, possibly corrupted context — which is often *why* it failed. You get the same sorry back.

## The fix

Don't retry the failure. **Clear the memory and remake the intent.**

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Transcript │────▶│ Clear memory │────▶│   Remake    │
│  (with sorry)│     │ (keep intent,│     │  (fresh     │
│              │     │  drop history)│     │   completions)│
└─────────────┘     └──────────────┘     └─────────────┘
```

1. **Find** the failure (sorry pattern detection)
2. **Extract** the last user intent (the actual task)
3. **Clear** the context — drop all history, keep only intent
4. **Remake** via a fresh completions call

## Usage

```bash
# From a failed transcript
cat transcript.json | bun remake.ts

# Direct prompt (skip detection)
bun remake.ts --prompt "summarize this document"

# JSON output for pipelines
bun remake.ts --file transcript.json --json

# Custom endpoint/model
bun remake.ts --file transcript.json \
  --endpoint http://localhost:11434/v1/chat/completions \
  --model llama3.2
```

Works with any OpenAI-compatible completions endpoint: Ollama, llama-swap, vLLM, LM Studio, OpenAI, etc.

## Companion: sorry-explore

`sorry-explore.ts` finds *why* it failed. `remake.ts` fixes it.

```bash
# First, understand the failure
cat transcript.json | bun sorry-explore.ts

# Then, recover from it
cat transcript.json | bun remake.ts
```

`--newest-first` flag for `chat.read_messages` pages (newest-first order).

## Why this doesn't exist

We searched: arXiv, OpenAlex, Semantic Scholar, HuggingFace papers, GitHub code and repos. Papers on "failure recovery" are about customer service (1999, marketing). GitHub has retry libraries, but none that **clear context as the recovery mechanism**. Retry-with-same-context is the default; clear-and-remake is the insight.

## Install

```bash
git clone https://github.com/toxicwind/remake
cd remake
bun remake.ts --prompt "hello"
```

Requires [Bun](https://bun.sh). No npm dependencies.

## License

MIT
