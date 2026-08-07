# Needle × ShowFlow: Chat Bot Integration Analysis

## TL;DR

**Needle** is a 26M-parameter, Python/JAX-based function-calling model (14 MB weights) that's a strong technical fit for the "ask the bot to run app functions" use case — it takes a natural-language query + a tool schema and returns a structured tool-call JSON, with a constrained decoder that guarantees grammatically valid output.

**The catch:** needle is Python-only. ShowFlow is Bun/TS. There's no Node-compatible binding. Integration requires a Python bridge (subprocess or sidecar service).

## What Needle Is (and Isn't)

### Is:
- **Purpose-built for function calling.** Takes `(query: str, tools: str)` and returns `[{name, arguments}]` JSON. It was post-trained on 2B tokens of single-shot function-call data.
- **Constrained decoding.** A grammar-constrained decoder tracks position in the output JSON via a state machine + char-level trie. It masks logits so the model can only emit valid tool names and argument keys from the supplied schema. Output is always valid JSON, never hallucinated.
- **Tiny and fast.** 14 MB weights, ~1-6k tokens/sec on mobile, 6000 prefill / 1200 decode on Cactus cloud TPUs. On CPU it's slower (JAX), but the model is small enough (26M params) to be practical.
- **Self-contained / offline.** Weights auto-download from HuggingFace (`Cactus-Compute/needle`). No external LLM API key needed.
- **Finetunable locally.** `needle finetune data.jsonl` trains on a local machine. You can finetune on your own tool set + phrasing patterns.

### Isn't:
- **A conversational model.** It's single-shot function calling — query + tools → tool call. No built-in chat history/state. For multi-turn, you'd manage conversation context yourself (accumulate context, re-inject into each query, or chain tool results back).
- **Drop-in for Node.** Pure Python (JAX/Flax/Flaxlinen/SentencePiece). No WASM, no ONNX export, no JS runtime.
- **Production-hardened.** The README explicitly says "small models can be finicky" and recommends the playground for testing/finetuning on your own tools first.

## The Language Mismatch

| | ShowFlow | Needle |
|---|---|---|
| Language | TypeScript (Bun) | Python 3.11+ |
| Runtime | `bun run dev` (single binary) | JAX + XLA (heavy stack) |
| Dependencies | npm packages | jax, jaxlib, flax, optax, sentencepiece, huggingface_hub |
| Model format | N/A | Pickle (`.pkl`), JAX params |
| Tokenizer | N/A | SentencePiece BPE (8192 vocab) |

There is **no way** to `import needle` from Bun. You must bridge the two runtimes.

## Integration Architecture Options

### Option 1: Python Subprocess Bridge (simplest)

ShowFlow spawns a long-lived Python process that loads the model once and stays alive, communicating via JSON over stdin/stdout:

```
ShowFlow (Bun)
  ├─ /api/chatbot POST
  │    ├─ writes JSON {"query": "...", "tools": [...]} → Python stdin
  │    └─ reads JSON {"result": [{"name": "list_shows", "arguments": {...}}]} ← stdout
  └─ Python process (needle serve)
       ├─ loads model + checkpoint on startup (one-time ~10s import)
       ├─ loops: read line → generate() → print line
       └─ uses needle's generate() with constrained decoding
```

**Pros:** Single deployment artifact (Python script ships alongside), no extra port, simplest Docker setup.
**Cons:** Process lifecycle management (restart on crash, shutdown), stdin/stdout framing (newline-delimited JSON), harder to debug.

**Prototype sketch:**

Python side (`chatbot_bridge.py`):
```python
import sys, json
from needle.model.architecture import SimpleAttentionNetwork
from needle.model.run import generate, load_checkpoint
from needle.dataset.dataset import get_tokenizer

params, config = load_checkpoint("checkpoints/needle.pkl")
model = SimpleAttentionNetwork(config)
tokenizer = get_tokenizer()

for line in sys.stdin:
    req = json.loads(line)
    result = generate(model, params, tokenizer,
                      query=req["query"], tools=req["tools"],
                      stream=False, constrained=True)
    sys.stdout.write(json.dumps({"result": result}) + "\n")
    sys.stdout.flush()
```

TS side (spawn + message exchange):
```ts
// src/backend/core/needle_client.ts
import { spawn, type ChildProcess } from "bun";

let proc: ChildProcess | null = null;
function ensureProc() {
  if (!proc || proc.killed) {
    proc = spawn(["python3", "chatbot_bridge.py"], { cwd: import.meta.dir });
    proc.stdout?.connect((line) => { /* store pending promise */ });
  }
  return proc;
}

export async function callNeedle(query: string, tools: object[]): Promise<any> {
  return new Promise((resolve, reject) => {
    // write JSON line, await response
  });
}
```

### Option 2: HTTP Sidecar Service (cleaner, more scalable)

Same Python model serving, but behind a tiny HTTP server (the needle repo already has `needle playground` which uses `http.server` — you could write a minimal variant):

```
ShowFlow (Bun)                    Python sidecar
  ├─ /api/chatbot POST              GET /health (model loaded?)
  │    ├─ HTTP POST http://localhost:8791/generate   └─ POST /generate
  │    │    {"query": "...", "tools": [...]}       ├─ needle.generate()
  │    └─ dispatches tool → internal service      └─ returns {result: [...]}
  └─ tool dispatch

Docker: single container, supervisord starts both
```

**Pros:** Network-isolated, health-checkable, can be scaled/restarted independently, easy to swap model backends, works with Docker compose/k8s sidecars.
**Cons:** Extra Python process to manage, port allocation, Docker image needs both Bun + Python + JAX.

### Option 3: Pure REST Proxy to Existing Needle Playground

If you run `needle playground` (serves on port 7860), you could proxy to it. But the playground's API is designed for human interaction (saves finetune checkpoints, etc.) — not a clean programmatic interface. Not recommended for production.

## Recommended Approach: Option 2 (HTTP Sidecar)

Despite the extra moving parts, the HTTP sidecar is the cleaner long-term choice because:
- Process isolation means a model crash doesn't take down your media manager
- Health checks let ShowFlow report "AI assistant offline" gracefully
- You can pre-load the model at startup and reuse it across requests (amortize the ~10s JAX import + model load)
- Works in both `bun run dev` (local) and Docker (production) — you just need the Python venv in both environments

### Suggested file layout:
```
src/
  backend/
    chatbot/
      bridge.py          # Tiny HTTP server wrapping needle.generate()
      tools.ts           # Tool schema definitions (TS, shared with UI)
      chatbot.ts         # TS client + tool dispatcher
      routes.ts          # /api/chatbot route
```

## What Tools Could Be Exposed

ShowFlow already has clean API routes — the chatbot tools should map 1:1 to existing or easily-wrapped backend operations. Here's a recommended tool set:

### Informational (read-only, safe)
| Tool | Maps to | Example query |
|---|---|---|
| `list_shows` | `GET /api/shows` | "What shows do I have?" |
| `get_calendar` | `GET /api/calendar?days=N` | "What's airing this week?" |
| `list_missing` | `GET /api/missing` | "What episodes am I missing?" |
| `check_system_status` | `GET /api/system/status` | "Is the watcher running?" |
| `check_health` | `GET /api/system/health` | "Are my indexers healthy?" |
| `check_errors` | `GET /api/events` + `GET /api/pipeline/kanban` | "What errors have there been?" |
| `get_pipeline_status` | `GET /api/pipeline/kanban` | "What's in the download pipeline?" |
| `search_releases` | `GET /api/search?q=...` | "Find releases of Attack on Titan" |
| `search_episode` | `GET /api/shows/:id/.../search` | "Search for S01E05" |
| `list_background_jobs` | `GET /api/system/jobs` (new) | "What's currently running?" |

### Actions (state-changing)
| Tool | Maps to | Example query |
|---|---|---|
| `add_show` | `POST /api/shows` | "Add Attack on Titan" |
| `remove_show` | `DELETE /api/shows/:id` | "Remove One Piece" |
| `sync_show` | `POST /api/shows/:id/sync` | "Sync My Hero Academia" |
| `scan_library` | `POST /api/system/scan` | "Scan the library" |
| `start_watcher` | `POST /api/system/watch/start` | "Start the download watcher" |
| `stop_watcher` | `POST /api/system/watch/stop` | "Stop the watcher" |
| `grab_release` | `POST /api/search/grab` | "Grab the best release" |
| `grab_episode` | `POST /api/shows/:id/.../grab` | "Grab S01E12" |
| `run_task` | `POST /api/tasks/:name` | "Run the backup task" |
| `create_backup` | `POST /api/backup` | "Back up the database" |

### Tool schema example (JSON, as needle expects):

```json
[
  {
    "name": "list_shows",
    "description": "List all shows in the library with their titles, IDs, and tracked/grabbed episode counts.",
    "parameters": {
      "type": "string",
      "description": "Ignore. Reserved for future filtering."
    }
  },
  {
    "name": "search_releases",
    "description": "Search all configured indexers for releases matching a query string.",
    "parameters": {
      "query": {"type": "string", "description": "Search terms, e.g. 'Attack on Titan S01E05'", "required": true}
    }
  },
  {
    "name": "grab_episode",
    "description": "Grab the best available release for a specific episode of a tracked show.",
    "parameters": {
      "show_id": {"type": "string", "description": "The UUID of the show.", "required": true},
      "season": {"type": "integer", "description": "Season number, e.g. 1.", "required": true},
      "episode": {"type": "string", "description": "Episode number, e.g. 5.", "required": true}
    }
  },
  {
    "name": "check_errors",
    "description": "Check recent pipeline errors and failures. Returns the latest pipeline events including rejected/failed releases with reason codes.",
    "parameters": {}
  }
]
```

## How the Conversation Flow Would Work

1. **User** types in chat: _"What's airing next week?"_
2. **Frontend** sends `{query: "What's airing next week?", tools: [...]}` to `/api/chatbot`
3. **Backend** calls needle via Python bridge → needle returns `[{name: "get_calendar", arguments: {"days": 7}}]`
4. **Backend** dispatches: calls its own `GET /api/calendar?days=7` internally, gets episode data
5. **Backend** formats result into a natural-language reply (e.g. "Attack on Titan S02E01 airs on Monday. My Hero Academia S3E10 on Wednesday.")
6. **Frontend** displays: [user message] → [bot: "Attack on Titan S02E01 airs..."] → (optionally shows source data)

For multi-turn: the backend accumulates `(user_query → tool_call → tool_result → next_query)` and feeds a summary back as the next query to needle, or a simple rules-based router handles disambiguation (e.g., "which show?" → fetch show list → re-prompt needle with context).

## Key Considerations & Caveats

### 1. JAX on CPU is slow to start
Loading the model requires importing JAX (several seconds) + first JIT compilation of the decode step (XLA compilation, ~5-15s on first call). Subsequent calls are fast since JAX caches compiled HLO. You should:
- Keep the Python process warm (don't spawn-per-request)
- Warm up the model at startup with a dummy call

### 2. The model is small — it will hallucinate tool args
Needle at 26M params is good at picking the *right tool*, but may occasionally produce nonsensical argument values (e.g., wrong show_id). You should validate tool arguments on the TS side (check show exists, season/episode valid, etc.) and fall back to a text response when the model produces unexecutable output.

### 3. No off-the-shelf conversational layer
Needle returns tool calls, not prose. The "chatbot" personality (natural language replies to users) has to be handled by the TS layer — either template-based ("Found 3 releases for Attack on Titan: ...") or by chaining a second call to a lightweight LLM (OpenAI/gpt-4o-mini) for response generation, using needle purely for intent classification / tool routing.

### 4. Finetuning is optional but recommended
The base model was pretrained on generic tool-calling data. Finetuning on 100-200 examples of ShowFlow-specific queries + desired tool calls would significantly improve accuracy. The `needle finetune` command + `data.jsonl` format is documented in the README. This could be done during development, not at runtime.

### 5. Docker complexity
The current Dockerfile uses `gcr.io/distroless/base-debian12` — a minimal image. Adding Python + JAX + Flax + sentencepiece to that image is non-trivial. You'd likely need a multi-stage build or a separate Python image (e.g., `python:3.12-slim` with JAX installed) and either combine them with supervisord or run them as separate containers.

### 6. Alternative consideration
Since needle is Python-only and ShowFlow is firmly Bun/TS, an arguably simpler path for a production-quality chatbot would be to use an **LLM-as-a-router** approach with an external API (OpenAI function calling, Anthropic tool use) for the NLU layer, keeping all the tool execution in TS. This avoids the Python bridge entirely but introduces an API key / cost dependency. Needle's value is the **offline, local, no-cost** property — which is significant for a self-hosted app like ShowFlow.

## Minimal Viable Prototype

If you want to test this before committing to architecture:

1. **Backend route** (`src/backend/routes/chatbot.ts`):
   ```ts
   // Exposes /api/chatbot with POST {query, tools}
   // Internally calls a Python subprocess running needle
   // Dispatches the returned tool call to internal functions
   // Returns {toolCall, result, reply}
   ```

2. **Frontend component** (`src/frontend/components/showflow/ChatBot.tsx`):
   - Floating chat button in the header (like FeedbackButton)
   - Expands to a small chat window
   - Input at bottom, message list above
   - Uses existing `fetch` patterns from the app

3. **Python bridge script** (shipped in `src/backend/chatbot/bridge.py`):
   - One file, ~30 lines, wraps `needle.generate()`
   - Runs via `python3 bridge.py` spawned from the Bun server

4. **Tool registry** in TS mapping tool names → handler functions (mostly wrapping existing `db.*` and service calls).

This lets you validate the concept end-to-end before deciding whether to go subprocess, sidecar, or rethink the approach.
