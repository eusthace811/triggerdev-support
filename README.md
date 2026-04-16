# Trigger Support

An AI support agent for the Trigger.dev platform. Ask questions about tasks, scheduling, concurrency, realtime, deployment — and get accurate, cited answers sourced directly from the official documentation.

Built with the Trigger.dev `chat.agent()` prerelease SDK, LanceDB hybrid search, and the AI Elements component library.

---

## How it works

```
User question
  ↓
Query expansion     — Gemini rewrites natural language to dense SDK terms (better BM25 recall)
  ↓
Vector search       — embed expanded query with text-embedding-3-small → cosine nearest neighbors
  ↓
BM25 search         — full-text search over doc chunks in LanceDB
  ↓
RRF reranking       — Reciprocal Rank Fusion merges both result sets → top 8 chunks
  ↓
Context injection   — chunks formatted as Markdown sections, injected into system prompt
  ↓
Grounded generation — Gemini 3 Flash streams an answer with inline citations
  ↓
Citation rendering  — streamed text split on citation pattern → inline badges with hover cards
```

The agent runs as a `chat.agent()` task on Trigger.dev. The Next.js frontend connects to it via `useTriggerChatTransport` and streams the response in real time.

### Why hybrid search?

Pure vector search misses exact API names. Pure BM25 misses semantic intent. The agent combines both — then uses Reciprocal Rank Fusion (RRF) to merge the result sets — so a question like *"pause a job until a human approves it"* surfaces the right `waitpoint` docs even though none of those words appear in the query.

Query expansion runs first: Gemini rewrites the natural-language question into a dense technical query (`task() waitpoint resumeAfterResponse() wait.forToken()`) before searching, giving BM25 the signal it needs.

---

## Stack

| | |
|---|---|
| Framework | Next.js 16, React 19, Turbopack |
| Chat agent | `@trigger.dev/sdk` `chat.agent()` prerelease |
| LLM | Google Gemini 3 Flash via OpenRouter |
| Embeddings | OpenAI `text-embedding-3-small` |
| Vector DB | LanceDB (embedded, runs in Trigger.dev worker) |
| UI components | [AI Elements](https://elements.ai-sdk.dev) + shadcn/ui |
| Markdown | Streamdown with code, math, and mermaid plugins |
| Styling | Tailwind CSS v4 |

---

## Getting started

### Prerequisites

- Node.js 18+
- A [Trigger.dev](https://trigger.dev) account and project
- OpenRouter API key (for Gemini)
- OpenAI API key (for embeddings only)

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local`:

| Variable | Required | Description |
|---|---|---|
| `TRIGGER_SECRET_KEY` | Yes | Trigger.dev project secret key (`tr_dev_...`) |
| `TRIGGER_PROJECT_REF` | Yes | Your project reference ID (`proj_...`) |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key — used for Gemini 3 Flash |
| `OPENAI_API_KEY` | Yes | OpenAI API key — used only for `text-embedding-3-small` |
| `GITHUB_TOKEN` | No | Personal access token — avoids GitHub's 60 req/hr rate limit during indexing |
| `LANCEDB_URI` | No | Path to LanceDB data directory (default: `./lancedb-data`) |

### 3. Start the Trigger.dev worker

```bash
npm run trigger:dev
```

This starts a local worker that runs your tasks (indexing, search, chat agent).

### 4. Start Next.js

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 5. Index the documentation

Trigger a one-time indexing run that fetches all Trigger.dev MDX docs from GitHub, chunks them by section, embeds them with `text-embedding-3-small`, and writes to a local LanceDB table with a BM25 full-text index.

```bash
curl -X POST http://localhost:3000/api/index-docs
```

Watch the run in the [Trigger.dev dashboard](https://cloud.trigger.dev). It takes ~5–10 minutes. You only need to do this once (or whenever the docs change significantly).

### 6. Ask a question

The agent is ready. Try:

- *How do I pause a task until a human approves it?*
- *What happens if my task crashes halfway through?*
- *How do I run only one job at a time per customer?*
- *How do I stream AI responses from a background task to the frontend?*

---

## Re-indexing

The indexing task uses `mode: "overwrite"` when creating the LanceDB table, so it is safe to re-run at any time. Re-trigger it whenever the Trigger.dev docs change significantly:

```bash
curl -X POST http://localhost:3000/api/index-docs
```

---

## Project structure

```
trigger/
  chat.ts          — chat.agent() with query expansion, search, streaming
  searchDocs.ts    — runSearch(): hybrid LanceDB query, also a standalone task
  indexDocs.ts     — one-time indexing task (never imported in Next.js)

app/
  page.tsx         — page shell with header
  layout.tsx       — fonts and metadata
  globals.css      — Tailwind v4 theme
  actions.ts       — getChatToken() server action
  components/
    chat.tsx       — chat UI: streaming, citation parsing, suggestions
  api/
    index-docs/
      route.ts     — POST endpoint that triggers the indexing task

components/
  ai-elements/     — AI Elements registry components (Conversation, Message, etc.)
  ui/              — shadcn/ui primitives (Button, Badge, HoverCard, Carousel, etc.)

lib/utils.ts       — cn() utility
public/            — logo.svg, triggerito.svg
```

---

## Architecture notes

**LanceDB runs in the worker only.** The `@lancedb/lancedb` package contains a compiled Rust binary that Turbopack cannot bundle. All LanceDB code lives in `trigger/` and is triggered by string ID from `app/api/index-docs/route.ts` — never imported directly into Next.js.

**Pre-fetch search pattern.** The prerelease `chat.agent()` ends the stream after the first LLM finish event, before `maxSteps` can trigger a second step. To work around this, search results are fetched *before* the stream starts and injected into the system prompt as context. When multi-step tool calling is supported in a future SDK release, this can be replaced with a proper tool call.

**Citation grounding.** The system prompt instructs the model to cite every source as `([label](https://trigger.dev/docs/...))`. The chat component's `parseTextWithCitations` splits the completed text on this pattern and renders each citation as an inline badge with a hover card linking to the live docs page.

**OpenRouter `.chat()` endpoint.** The Gemini model is accessed via `openai.chat("google/gemini-3-flash-preview")` — not `openai.responses()`. OpenRouter's default endpoint accepts the standard Chat Completions format.

---

## Production deployment

The project is deployed at [triggerdev-support.vercel.app](https://triggerdev-support.vercel.app).

### Deploying to Vercel

1. **Deploy the Trigger.dev worker** — the worker must be deployed to Trigger.dev cloud (not just running locally with `trigger:dev`). Follow the [Trigger.dev deployment docs](https://trigger.dev/docs/deploying).

2. **Set environment variables** in both Vercel and your Trigger.dev project dashboard:
   - `TRIGGER_SECRET_KEY` — use a production key (`tr_prod_...`), not a dev key
   - `TRIGGER_PROJECT_REF`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY` — same as local
   - `GITHUB_TOKEN` — recommended for indexing

3. **Index the documentation** in production:

   ```bash
   curl -X POST https://triggerdev-support.vercel.app/api/index-docs
   ```

   This triggers the `index-docs` task on the Trigger.dev cloud worker. The LanceDB data is stored on the worker's filesystem, not on Vercel's ephemeral serverless filesystem.

4. **Verify** — open the [Trigger.dev dashboard](https://cloud.trigger.dev) to watch the indexing run complete (~5–10 minutes), then ask a question in the chat.

### Production considerations

- **LanceDB runs on the Trigger.dev worker**, not on Vercel. The API route only triggers tasks by string ID — it never imports LanceDB.
- **Vercel's serverless filesystem is ephemeral** — no persistent storage is needed on Vercel since all vector DB operations happen on the Trigger.dev worker.
- **Re-indexing** works the same in production: `curl -X POST https://triggerdev-support.vercel.app/api/index-docs`

---

## Known limitations

- **Multi-step tool calling doesn't work yet.** The `chat.agent()` prerelease ends the stream after the first LLM finish event. `maxSteps` cannot fire a second step, so the pre-fetch pattern is required. This will be fixed in a future SDK release.

- **LanceDB is local, not shared.** The embedded LanceDB instance writes to a local directory on the Trigger.dev worker. In a production multi-worker setup, you would need a shared object store (e.g., S3) or a remote vector database.

- **GitHub rate limits.** Without a `GITHUB_TOKEN`, the GitHub API limits unauthenticated requests to 60/hour. For the ~300 MDX files in the Trigger.dev docs this is fine if you run indexing once, but can fail on repeated runs. A personal access token removes the limit.
