# Trigger Support — Project Guide

A comprehensive guide to understanding, running, and extending the Trigger Support chat agent.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
  - [System Diagram](#system-diagram)
  - [Frontend](#frontend)
  - [Backend Tasks](#backend-tasks)
  - [Data Flow](#data-flow)
- [The RAG Pipeline](#the-rag-pipeline)
  - [1. Document Indexing](#1-document-indexing)
  - [2. Query Expansion](#2-query-expansion)
  - [3. Hybrid Search](#3-hybrid-search)
  - [4. Grounded Generation](#4-grounded-generation)
  - [5. Citation Rendering](#5-citation-rendering)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Key Design Decisions](#key-design-decisions)
- [Evaluation](#evaluation)
  - [Golden QA Dataset](#golden-qa-dataset)
  - [Running an Evaluation](#running-an-evaluation)
  - [Scoring Criteria](#scoring-criteria)
  - [Evaluation History](#evaluation-history)
- [Extending the Project](#extending-the-project)
  - [Adding Query Expansion Mappings](#adding-query-expansion-mappings)
  - [Tuning Chunking Parameters](#tuning-chunking-parameters)
  - [Changing the LLM](#changing-the-llm)
  - [Switching to a Remote Vector DB](#switching-to-a-remote-vector-db)
- [Constraints and Gotchas](#constraints-and-gotchas)
- [Stack Reference](#stack-reference)

---

## Overview

Trigger Support is an AI-powered documentation assistant for the [Trigger.dev](https://trigger.dev) platform. Developers ask natural-language questions and receive accurate, cited answers grounded in the official docs.

It is built as a demonstration of Trigger.dev's `chat.agent()` prerelease SDK, showing how to combine:

- **Trigger.dev background tasks** for document indexing and search
- **Hybrid retrieval** (vector + BM25 full-text search) with RRF reranking
- **LLM-based query expansion** to bridge the gap between natural language and SDK terms
- **Streaming chat UI** with inline citation badges and source attribution

The agent scores **9.3/10** on a golden QA evaluation dataset of 6 representative developer questions.

---

## Prerequisites

- **Node.js 18+**
- A [Trigger.dev](https://trigger.dev) account with a project created
- An [OpenRouter](https://openrouter.ai) API key (for Gemini 3 Flash)
- An [OpenAI](https://platform.openai.com) API key (for `text-embedding-3-small` embeddings)
- Optional: a [GitHub personal access token](https://github.com/settings/tokens) for higher rate limits during indexing

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create `.env.local` at the project root:

```env
TRIGGER_SECRET_KEY=tr_dev_...        # From your Trigger.dev project settings
TRIGGER_PROJECT_REF=proj_...         # From your Trigger.dev project settings
OPENROUTER_API_KEY=sk-or-v1-...     # From openrouter.ai
OPENAI_API_KEY=sk-proj-...          # From platform.openai.com
```

See [Environment Variables](#environment-variables) for the full list.

### 3. Start the Trigger.dev worker

```bash
npm run trigger:dev
```

This connects to the Trigger.dev platform and runs your tasks locally. Keep this terminal open.

### 4. Start the Next.js dev server

In a second terminal:

```bash
npm run dev
```

### 5. Index the documentation

This one-time step fetches all Trigger.dev MDX docs from GitHub, chunks them, embeds them, and writes them to a local LanceDB database with full-text search indexes.

```bash
curl -X POST http://localhost:3000/api/index-docs
```

Monitor the run in your [Trigger.dev dashboard](https://cloud.trigger.dev). It takes 5-10 minutes and produces ~1,950 chunks from ~313 documentation files.

### 6. Start chatting

Open [http://localhost:3000](http://localhost:3000) and ask a question. Try one of the suggestions on the landing page, or ask your own:

- *What are the limitations of the self-hosted version?*
- *Does waiting time in triggerAndWait count as compute time?*
- *How do I exit a task early if an API call fails?*
- *How do I get the cost of my runs?*

---

## Architecture

### System Diagram

```
                          +-----------------------+
                          |    Next.js Frontend   |
                          |                       |
                          |  page.tsx             |
                          |    -> <Chat />        |
                          |       useChat()       |
                          |       useTriggerChat  |
                          |         Transport()   |
                          +----------+------------+
                                     |
                          getChatToken() server action
                                     |
                          +----------v------------+
                          |  Trigger.dev Platform  |
                          |                       |
                          |  chat.agent()         |
                          |  "trigger-support"    |
                          +----------+------------+
                                     |
                    +----------------+----------------+
                    |                                 |
           +-------v--------+              +---------v---------+
           | Query Expansion |              |   Hybrid Search   |
           | (Gemini Flash)  |              |                   |
           +-------+--------+              |  Vector + BM25    |
                    |                       |  RRF reranking    |
                    +-------> LanceDB <-----+                   |
                                            +-------------------+
                                                      |
                                            +---------v---------+
                                            | Grounded Generation|
                                            | (Gemini Flash)     |
                                            | System prompt +    |
                                            | retrieved context  |
                                            +-------------------+
                                                      |
                                              Stream back to UI
```

### Frontend

The frontend is a Next.js 16 app with a single page (`app/page.tsx`) that renders the `<Chat />` component.

**`app/actions.ts`** — A server action that creates an access token for the chat transport. This authenticates the client with the Trigger.dev platform without exposing the secret key.

**`app/components/chat.tsx`** — The main chat component. It uses:
- `useTriggerChatTransport` from `@trigger.dev/sdk/chat/react` to connect to the `trigger-support` chat agent
- `useChat` from `@ai-sdk/react` for message state management and streaming
- AI Elements components for the conversation UI (messages, suggestions, citations, sources)
- Custom citation parsing (`parseTextWithCitations`) that splits completed assistant text on the `([label](url))` pattern and renders inline badges

**`app/api/index-docs/route.ts`** — A POST endpoint that triggers the indexing task by string ID. It never imports LanceDB directly (see [Constraints](#constraints-and-gotchas)).

### Backend Tasks

All backend logic lives in `trigger/` and runs inside the Trigger.dev worker:

**`trigger/chat.ts`** — The chat agent definition using `chat.agent()`. On each user message it:
1. Extracts the latest user query from the message history
2. Expands the query using `expandQuery()` (LLM-based rewrite to SDK terms)
3. Runs hybrid search using `runSearch()` with both expanded and original queries
4. Builds a context string from the retrieved chunks
5. Streams a response using Gemini 3 Flash with the context injected into the system prompt

**`trigger/searchDocs.ts`** — The hybrid search function. Runs vector nearest-neighbor search and BM25 full-text search on LanceDB, merges results with Reciprocal Rank Fusion (RRF), and deduplicates. Supports multi-query retrieval: if the expanded query differs from the original, both are searched and results are merged.

**`trigger/indexDocs.ts`** — The one-time indexing task. Fetches all MDX files from the Trigger.dev GitHub repo, parses them into section-level chunks, embeds with OpenAI's `text-embedding-3-small`, and writes to LanceDB with BM25 full-text indexes on both `content` and `section` columns.

### Data Flow

A complete request flows through these steps:

```
1. User types a question in the chat UI
2. useChat sends it via useTriggerChatTransport
3. The transport calls getChatToken() (lazily, on first use) to authenticate
4. Trigger.dev routes the message to chat.agent("trigger-support")
5. expandQuery() rewrites the question to SDK-specific terms
6. runSearch() runs hybrid search (vector + BM25 + RRF) on LanceDB
7. buildContext() formats the top chunks as Markdown with source URLs
8. streamText() sends the context + messages to Gemini 3 Flash
9. The response streams back through the transport to the client
10. chat.tsx renders the stream with a shimmer animation
11. On completion, parseTextWithCitations() splits the text into segments
12. Citation badges and a collapsible Sources list are rendered
```

---

## The RAG Pipeline

### 1. Document Indexing

**File:** `trigger/indexDocs.ts`

The indexing task runs once to build the search database:

1. **Fetch file tree** — Uses the GitHub Tree API to fetch the entire `triggerdotdev/trigger.dev` repo tree in a single recursive call, then filters client-side for `.mdx` and `.md` files under `docs/`, excluding migration guides (which pollute retrieval with non-Trigger.dev concepts).

2. **Fetch file contents** — Downloads each file's raw content from GitHub in parallel batches of 20. With a `GITHUB_TOKEN`, this avoids rate limits.

3. **Parse into chunks** — Each file is split by `##` and `###` headings. The `chunkMdx()` function:
   - Strips frontmatter and MDX import lines
   - Converts semantic JSX tags (`<Note>`, `<Tip>`, `<Warning>`, `<Info>`, `<Callout>`, `<Important>`) to markdown labels (`**Note:**`) so their content is preserved
   - Strips remaining JSX tags while keeping inner text
   - Adds a page context prefix (`Page: self-hosting/overview | Section: Feature Comparison`) for BM25 matching
   - Splits large sections (>1,500 chars) into overlapping sub-chunks (200 char overlap) to preserve context at boundaries
   - Skips sections shorter than 40 characters

4. **Embed** — Chunks are embedded with OpenAI's `text-embedding-3-small` in batches of 100. The embedding input is `section heading + body` to give the vector both topic and content signal.

5. **Write to LanceDB** — All chunks are written to a `docs` table with `mode: "overwrite"`. Two BM25 full-text search indexes are created: one on `content` and one on `section`.

**Chunk schema:**
```typescript
{
  id: string;        // e.g. "docs/wait.mdx#overview" or "docs/wait.mdx#overview-p0"
  file_path: string; // e.g. "docs/wait.mdx"
  section: string;   // e.g. "Overview"
  content: string;   // prefixed body text
  url: string;       // e.g. "https://trigger.dev/docs/wait"
  vector: Float32Array; // 1536-dim embedding
}
```

**Re-indexing** is safe to run at any time since it uses `mode: "overwrite"`:
```bash
curl -X POST http://localhost:3000/api/index-docs
```

### 2. Query Expansion

**File:** `trigger/chat.ts` — `expandQuery()`

Raw user questions like *"pause a job until a human approves it"* score near zero on BM25 because none of those words appear in the relevant docs. Query expansion bridges this gap.

The `expandQuery()` function calls Gemini 3 Flash with a system prompt that rewrites the question into a dense technical query using Trigger.dev-specific terms. It includes 10 domain-specific term mappings:

| User concept | Expanded to |
|---|---|
| cost / billing / pricing | `compute_cost usage_duration TRQL query runs pricing` |
| exit task / abort / stop retrying | `AbortTaskRunError errors retrying` |
| self-hosted / limitations | `self-hosting overview warm starts auto-scaling checkpoints limits` |
| cron / schedule / recurring | `schedules.task cron declarative schedule timezone` |
| wait / pause / human approval | `wait waitpoint wait.forToken triggerAndWait batchTriggerAndWait checkpoint` |
| secret key / API key / environment | `TRIGGER_SECRET_KEY apikeys environments` |
| concurrency / rate limit | `concurrencyKey queue concurrency limit` |
| deploy / deployment | `deploy CLI deploy command github actions` |
| logs / observability | `logger metadata tags runs dashboard TRQL query` |
| realtime / subscribe / streaming | `realtime subscribe useRealtimeRun` |

The expansion falls back to the original query on any error, so retrieval is never blocked.

### 3. Hybrid Search

**File:** `trigger/searchDocs.ts` — `runSearch()`

Search combines three retrieval signals:

1. **Vector search** — The query is embedded with `text-embedding-3-small` and matched against stored chunk embeddings using cosine similarity (nearest neighbors).

2. **BM25 full-text search** — The query is matched against the `content` column using LanceDB's built-in BM25 index. This catches exact term matches that vector search might miss (e.g., `AbortTaskRunError`, `tr_prod_`).

3. **RRF reranking** — Reciprocal Rank Fusion merges the vector and BM25 result sets. RRF assigns scores based on rank position rather than raw scores, which handles the different score distributions well.

**Multi-query retrieval:** If the expanded query differs from the original, both are searched independently. The primary search (expanded query) returns up to 12 results, and the secondary search (original query) returns up to 6. Results are merged by chunk ID, with primary results taking priority, and the final output is capped at 12 chunks.

This ensures both semantic intent (from expansion) and exact user terms (from original) contribute to retrieval.

### 4. Grounded Generation

**File:** `trigger/chat.ts` — `myChat`

The retrieved chunks are formatted by `buildContext()` as Markdown sections with source URLs, then prepended with a `## Retrieved documentation` header and appended to the system prompt. The full injected context looks like:

```
## Retrieved documentation
### Section Title
Source: https://trigger.dev/docs/page

Content of the chunk...

---

### Another Section
Source: https://trigger.dev/docs/other-page

More content...
```

The system prompt instructs the model to:
- Answer **only** from the retrieved context, never from training data
- Cite every source inline by wrapping a Markdown link in literal parentheses: `([descriptive label](https://trigger.dev/docs/path))` — the outer `()` are literal characters that `parseTextWithCitations()` in `chat.tsx` depends on via the regex `\(\[label\]\(url\)\)`
- Never invent API signatures or parameter names
- Include specific values like env var names (`TRIGGER_SECRET_KEY`), key prefixes (`tr_prod_`), and numeric limits (`128KB`)
- Be concise and technical

### 5. Citation Rendering

**File:** `app/components/chat.tsx`

After the stream completes, the chat component processes the response:

1. **`parseTextWithCitations()`** splits the text on the `([label](url))` pattern into alternating text and citation segments. Duplicate URLs are deduplicated so badge count matches the Sources list.

2. **Text segments** are rendered using `<MessageResponse>` with Streamdown (Markdown rendering with code highlighting, math, and mermaid support).

3. **Citation segments** are rendered as `<Badge>` components wrapped in `<InlineCitationCard>` hover cards. Hovering shows the source title and a link to the docs page.

4. **`extractDocSources()`** collects all unique doc URLs and renders them in a collapsible `<Sources>` section below the message.

While waiting for the first token (status `submitted`), a `<Shimmer>` component displays rotating loading phrases like "Searching docs..." and "Reading the docs...". Once tokens start arriving (status `streaming`), the message text renders inline with `<MessageResponse isAnimating={true}>` for the Streamdown streaming animation.

---

## Project Structure

```
trigger-support/
  trigger/
    chat.ts              Chat agent: query expansion, context building, streaming
    searchDocs.ts        Hybrid search: vector + BM25 + RRF reranking
    indexDocs.ts         One-time indexing: GitHub -> chunks -> embeddings -> LanceDB

  app/
    page.tsx             Page shell with header and <Chat /> component
    layout.tsx           Root layout with Geist fonts
    globals.css          Tailwind v4 theme with light/dark CSS variables
    actions.ts           getChatToken() server action for chat authentication
    components/
      chat.tsx           Chat UI: streaming, citation parsing, suggestions
    api/
      index-docs/
        route.ts         POST endpoint to trigger doc indexing

  components/
    ai-elements/         AI Elements registry components (do not hand-edit)
    ui/                  shadcn/ui primitives (freely editable)

  lib/
    utils.ts             cn() class merge utility

  public/
    logo.svg             Trigger.dev logo
    triggerito.svg        Triggerito mascot

  docs/
    support-golden-answers.csv   Golden QA pairs for evaluation
    reports/                     Evaluation reports from testing runs

  trigger.config.ts      Trigger.dev project configuration
  next.config.ts         Next.js config (serverExternalPackages, ignoreBuildErrors)
  AGENTS.md              Detailed architecture documentation
  GUIDE.md               This file
```

---

## Environment Variables

Create a `.env.local` file at the project root:

| Variable | Required | Description |
|---|---|---|
| `TRIGGER_SECRET_KEY` | Yes | Your Trigger.dev project secret key. Starts with `tr_dev_` (development) or `tr_prod_` (production). Found on the API Keys page in your project dashboard. |
| `TRIGGER_PROJECT_REF` | Yes | Your Trigger.dev project reference ID. Starts with `proj_`. Found in your project settings. |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for accessing Gemini 3 Flash. Get one at [openrouter.ai](https://openrouter.ai). |
| `OPENAI_API_KEY` | Yes | OpenAI API key, used only for `text-embedding-3-small` embeddings. Get one at [platform.openai.com](https://platform.openai.com). |
| `GITHUB_TOKEN` | No | GitHub personal access token. Without it, GitHub's API rate limit is 60 requests/hour, which is fine for a single indexing run but will fail on repeated runs. |
| `LANCEDB_URI` | No | Path to the LanceDB data directory. Defaults to `./lancedb-data`. |

---

## Key Design Decisions

### Why pre-fetch search instead of tool calling?

The `chat.agent()` prerelease ends the stream after the first LLM finish event, before `maxSteps` can fire a second step. This means multi-step tool calling doesn't work yet. To work around this, search results are fetched *before* `streamText()` is called and injected into the system prompt as context.

When the SDK supports multi-step tool calling in a future release, this can be replaced with a proper tool-call pattern where the LLM decides what to search for.

### Why LanceDB?

LanceDB is an embedded vector database that runs as a Rust binary in-process. This means:
- No external database server to manage
- Built-in BM25 full-text search (no separate Elasticsearch/Typesense needed)
- Built-in RRF reranking
- Sub-millisecond query latency

The tradeoff is that it runs locally on the worker and isn't shared across instances. For production, you'd either use a shared object store backend or switch to a hosted vector database.

### Why Gemini 3 Flash via OpenRouter?

Gemini 3 Flash offers a good balance of speed, quality, and cost for a grounded Q&A task. OpenRouter provides a unified API that makes it easy to swap models. The `createOpenAI` adapter from `@ai-sdk/openai` connects to OpenRouter's Chat Completions-compatible endpoint.

### Why hybrid search (vector + BM25)?

Pure vector search misses exact API names like `AbortTaskRunError` or `tr_prod_`. Pure BM25 misses semantic intent — *"pause a job until a human approves it"* contains zero terms from the `waitpoint` docs. Combining both with RRF reranking captures both signals.

### Why query expansion?

Even with hybrid search, many user questions use natural language that doesn't map to SDK terminology. Query expansion uses a cheap, fast LLM call to rewrite *"how much do my runs cost?"* into `compute_cost usage_duration TRQL query runs pricing`, giving BM25 the exact column and table names it needs.

### Why overlapping sub-chunks?

When a section is longer than 1,500 characters, it's split into sub-chunks with 200 characters of overlap. Without overlap, important information at chunk boundaries is lost — for example, a key prefix like `tr_prod_` might appear at the end of one chunk and the explanation at the start of the next. Overlap ensures both chunks have the full context.

---

## Evaluation

### Golden QA Dataset

The file `docs/support-golden-answers.csv` contains 6 representative developer questions with verified golden answers:

| # | Question | Key concepts tested |
|---|----------|---|
| Q1 | Self-hosted limitations | Feature comparison, hardcoded limits, env var config |
| Q2 | triggerAndWait compute time | Checkpointing, compute billing, wait behavior |
| Q3 | Cron every 30 minutes | schedules.task(), cron syntax, timezone |
| Q4 | Cost of runs | TRQL queries, compute_cost column, SDK usage API |
| Q5 | Exit task on criteria | AbortTaskRunError, error handling, retry prevention |
| Q6 | Production secret key | API keys page, TRIGGER_SECRET_KEY, tr_prod_ prefix |

### Running an Evaluation

1. Ensure the worker and dev server are running and docs are indexed
2. Open the app at `http://localhost:3000`
3. For each question in the golden QA file:
   - Start a new chat session (click "New chat" or navigate to `/`)
   - Submit the question exactly as written
   - Wait for the complete response
   - Compare against the golden answer
4. Score each response (see criteria below)
5. Save the report to `docs/reports/report-YYYY-MM-DDTHHMM.md`

### Scoring Criteria

Each question is scored 1-10 based on:

- **Factual correctness** (0-4): Are the stated facts accurate? Are there any hallucinations?
- **Completeness** (0-3): Does it cover the key concepts from the golden answer?
- **Source citations** (0-2): Are sources cited? Are they relevant and correctly linked?
- **Specific values** (0-1): Does it include exact SDK names, env vars, key prefixes, limits?

### Evaluation History

| Run | Date | Score | Key changes |
|---|---|---|---|
| Baseline | 2026-04-16 | 5.8/10 | Initial implementation |
| Round 2 | 2026-04-16 | 8.8/10 | Smaller chunks, overlaps, query expansion mappings, increased retrieval depth |
| Round 3 | 2026-04-16 | 9.3/10 | Page context prefix, JSX tag preservation, multi-query retrieval, section BM25 index, system prompt tuning |

Full reports with per-question analysis are in `docs/reports/`.

---

## Extending the Project

### Adding Query Expansion Mappings

Edit the `expandQuery()` function in `trigger/chat.ts`. Add new entries to the domain term mappings in the system prompt:

```
- new concept / user phrase → SDK_method specificTerm anotherTerm
```

Then re-test with relevant questions to verify the mapping improves retrieval.

### Tuning Chunking Parameters

Edit the constants at the top of `chunkMdx()` in `trigger/indexDocs.ts`:

```typescript
const CHUNK_CAP = 1500;    // Max characters per chunk
const CHUNK_OVERLAP = 200;  // Overlap between consecutive sub-chunks
const MIN_BODY = 40;        // Minimum body length to index a section
```

After changing these, re-index (`curl -X POST http://localhost:3000/api/index-docs`) and re-evaluate.

- **Smaller `CHUNK_CAP`** = more precise retrieval but more chunks to embed and store
- **Larger `CHUNK_OVERLAP`** = better boundary coverage but more redundant content
- **Lower `MIN_BODY`** = captures short sections (tables, lists) but may add noise

### Tuning Retrieval Depth

Edit the constants in `trigger/searchDocs.ts`:

```typescript
const MAX_RESULTS = 12;  // Max chunks returned after deduplication
```

The secondary query (original user question) is hardcoded to `limit(6)` at line 71. Increasing either value passes more context to the LLM at the cost of prompt size and latency. Decreasing them gives more focused context but risks missing relevant chunks.

### Changing the LLM

The LLM is configured in `trigger/chat.ts`:

```typescript
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});
```

To use a different model, change the model ID in both `expandQuery()` and the `streamText()` call:

```typescript
// In expandQuery():
model: openrouter.chat("google/gemini-3-flash-preview"),

// In the agent run:
model: openrouter.chat("google/gemini-3-flash-preview"),
```

Any model available on OpenRouter can be used. For direct API access (e.g., Anthropic, OpenAI), replace `createOpenAI` with the appropriate provider adapter from the AI SDK.

### Switching to a Remote Vector DB

To use a hosted vector database instead of local LanceDB:

1. Replace the LanceDB calls in `trigger/searchDocs.ts` and `trigger/indexDocs.ts` with your chosen provider's SDK (e.g., Pinecone, Weaviate, Qdrant)
2. You'll need to implement BM25 separately or use a provider that supports hybrid search
3. Remove `@lancedb/lancedb` and `apache-arrow` from `package.json` and `next.config.ts` `serverExternalPackages`
4. Update `LANCEDB_URI` references to your provider's connection config

---

## Constraints and Gotchas

### LanceDB cannot be imported in Next.js

`@lancedb/lancedb` contains a compiled Rust binary (`.node` file). Turbopack cannot bundle native modules. All LanceDB code must stay in `trigger/` and run only inside the Trigger.dev worker.

The `app/api/index-docs/route.ts` triggers the indexing task by string ID:
```typescript
const handle = await tasks.trigger("index-docs", undefined);
```

Never `import` from `trigger/indexDocs.ts` or `trigger/searchDocs.ts` in any file under `app/`.

`next.config.ts` has `serverExternalPackages: ["@lancedb/lancedb", "apache-arrow"]` as a safety net — do not remove this.

### SDK prerelease type stubs are incomplete

The `@trigger.dev/sdk` prerelease exports `/ai`, `/v3`, `/chat`, `/chat/react` at runtime but TypeScript types lag behind. `next.config.ts` has `typescript: { ignoreBuildErrors: true }` to handle this. Do not remove it.

### Prerelease package versions

`@trigger.dev/sdk` and `trigger.dev` use a specific prerelease tag (`0.0.0-chat-prerelease-20260415164455`). If you change the version, ensure both packages stay on the same prerelease tag — mixing versions will cause runtime errors. When adding the dependency, prefer the exact version (no `^`) to avoid npm resolving to a different prerelease.

### AI Elements components should not be hand-edited

Components in `components/ai-elements/` are installed by the official AI Elements registry CLI. If you need to customize one, copy it to a new file rather than editing the installed version, so future registry updates don't conflict.

### Citation regex must match the system prompt format

The system prompt instructs the model to wrap each citation in literal parentheses around a Markdown link: `([label](https://trigger.dev/docs/path))`. The `parseTextWithCitations()` regex in `chat.tsx` matches this exact pattern — specifically `\(\[...\]\(https://trigger.dev/docs/...\)\)`. The outer `()` are literal characters, not optional grouping. If you change the citation format in the system prompt, you must update both `parseTextWithCitations()` and `extractDocSources()` in `chat.tsx` to match.

---

## Stack Reference

| Layer | Technology | Purpose |
|---|---|---|
| Framework | Next.js 16 (App Router, React 19, Turbopack) | Web application shell |
| Chat agent | `@trigger.dev/sdk` `chat.agent()` prerelease | Background task orchestration and streaming |
| LLM | Google Gemini 3 Flash via OpenRouter | Query expansion and answer generation |
| Embeddings | OpenAI `text-embedding-3-small` | Document and query embedding (1536 dimensions) |
| Vector DB | LanceDB (embedded Rust binary) | Vector storage, BM25 indexing, RRF reranking |
| Search | Hybrid BM25 + vector with RRF | Multi-signal document retrieval |
| UI components | [AI Elements](https://elements.ai-sdk.dev) + shadcn/ui | Chat conversation, citations, sources |
| Markdown | Streamdown (code, math, mermaid plugins) | Rich text rendering in chat messages |
| Styling | Tailwind CSS v4 | Utility-first CSS with CSS variable theme tokens |
| Fonts | Geist Sans + Geist Mono | Typography |
