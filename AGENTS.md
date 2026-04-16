# Trigger Support — Agent Context

## What this is

A Trigger.dev support chat agent. Developers ask questions about the Trigger.dev platform and get accurate, cited answers backed by the live docs. Built as a job application project demonstrating Trigger.dev's `chat.agent()` prerelease SDK.

## Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router, React 19, Turbopack) |
| Chat agent | `@trigger.dev/sdk` `chat.agent()` prerelease |
| LLM | Google Gemini 3 Flash via OpenRouter |
| Embeddings | OpenAI `text-embedding-3-small` |
| Vector DB | LanceDB (embedded Rust binary, runs in worker only) |
| Search | Hybrid BM25 + vector with RRF reranking |
| UI components | AI Elements (`components/ai-elements/`) + shadcn/ui (`components/ui/`) |
| Markdown | Streamdown with code, math, mermaid plugins |
| Styling | Tailwind CSS v4 |

## How the chat agent works

```
User question
  → useTriggerChatTransport (client)
  → chat.agent("trigger-support") (Trigger.dev worker)
      1. expandQuery()   — rewrites question to dense SDK terms (better BM25 recall)
      2. runSearch()     — hybrid LanceDB search: vector + BM25 → RRF reranker → top 8 chunks
      3. buildContext()  — formats chunks as Markdown sections with source URLs
      4. streamText()    — Gemini 3 Flash streams response with inline citations
  → useTriggerChatTransport streams back to client
  → chat.tsx renders with shimmer → citation badges → Sources list
```

**Pre-fetch pattern (important):** `chat.agent()` ends the stream after the first LLM finish event, before `maxSteps` can fire a second step. Search results are fetched *before* the stream starts and injected into the system prompt as context. Do not attempt tool-calling inside the agent run — it won't work yet.

## File map

```
trigger/
  chat.ts          — chat.agent() definition: expandQuery, buildContext, streamText
  searchDocs.ts    — runSearch() + searchDocsTask (standalone task for testing)
  indexDocs.ts     — one-time indexing: GitHub tree API → MDX chunks → LanceDB

app/
  page.tsx         — header + <Chat>
  layout.tsx       — Geist fonts, metadata
  globals.css      — Tailwind v4 theme (light/dark CSS vars)
  actions.ts       — getChatToken() server action
  components/
    chat.tsx       — main UI: useChat, citation parsing, streaming shimmer
  api/
    index-docs/
      route.ts     — POST → tasks.trigger("index-docs") [never imports LanceDB!]

components/
  ai-elements/     — official AI Elements registry (installed via CLI, do not hand-edit)
  ui/              — shadcn/ui primitives (Badge, Button, HoverCard, Carousel, etc.)

lib/utils.ts       — cn() class merge utility
public/            — logo.svg, triggerito.svg (mascot)
```

## Critical constraints

**LanceDB must never be imported in Next.js.**
`@lancedb/lancedb` contains a compiled Rust binary. Turbopack cannot bundle `.node` files.
- `app/api/index-docs/route.ts` triggers indexing by string ID: `tasks.trigger("index-docs", undefined)`
- `trigger/searchDocs.ts` and `trigger/indexDocs.ts` are worker-only — they are never imported in `app/`
- `next.config.ts` has `serverExternalPackages: ["@lancedb/lancedb", "apache-arrow"]` — do not remove this

**SDK prerelease — type stubs are incomplete.**
`@trigger.dev/sdk@0.0.0-chat-prerelease-20260415164455` exports `/ai`, `/v3`, `/chat`, `/chat/react` at runtime but TypeScript types lag. `next.config.ts` has `typescript: { ignoreBuildErrors: true }` — this covers upstream AI Elements type issues too. Do not remove it.

**Pinned exact versions (no `^`):**
`@trigger.dev/sdk` and `trigger.dev` are pinned to the exact prerelease tag in `package.json`. Using `^` causes npm to resolve to the wrong prerelease tag.

## Running the project

```bash
# 1. Copy env vars (see below)
cp docs/dry-run/.env.local .env.local

# 2. Start Trigger.dev worker (terminal 1)
npm run trigger:dev

# 3. Start Next.js dev server (terminal 2)
npm run dev

# 4. Index the docs — one-time, run in worker (~5–10 min)
curl -X POST http://localhost:3000/api/index-docs

# 5. Open http://localhost:3000 and ask a question
```

## Environment variables

```env
TRIGGER_SECRET_KEY=tr_dev_...        # Trigger.dev project secret key
TRIGGER_PROJECT_REF=proj_...         # Project reference ID
OPENROUTER_API_KEY=sk-or-v1-...     # OpenRouter — used for Gemini 3 Flash
OPENAI_API_KEY=sk-proj-...          # OpenAI — used only for text-embedding-3-small
GITHUB_TOKEN=ghp_...                 # Optional — higher GitHub API rate limits during indexing
LANCEDB_URI=./lancedb-data           # Optional — defaults to this path
```

## Coding conventions

- **Citation format the LLM is prompted to use:** `([label](https://trigger.dev/docs/path)).` — the regex in `chat.tsx` matches this exact pattern. If you change the system prompt citation format, update `parseTextWithCitations` and `extractDocSources` to match.
- **AI Elements components** live in `components/ai-elements/` — installed by the official registry, not hand-written. If you need to customise a component, copy it to a new file rather than editing the installed version.
- **shadcn/ui components** live in `components/ui/` — these were authored for this project and can be edited freely.
- **Tailwind v4** — use CSS variable tokens (`text-foreground`, `bg-muted`, etc.) not hard-coded colours. Theme is defined in `app/globals.css`.
- **Next.js 16** — check `node_modules/next/dist/docs/` before using any Next.js API. Many patterns from prior versions are broken or renamed.
