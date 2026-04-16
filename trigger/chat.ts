import { chat } from "@trigger.dev/sdk/ai";
import { streamText, generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { runSearch } from "./searchDocs";
import type { SearchResult } from "./searchDocs";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const SYSTEM_PROMPT = `You are Triggerito, a Trigger.dev support agent. Answer developer questions about Trigger.dev accurately and concisely.

## Rules
- Answer based only on the retrieved docs provided in the context below. Do not use training data.
- Cite every source inline as a markdown link with a descriptive label matching the page or section title, e.g. "Use \`task()\` to define jobs ([tasks overview](https://trigger.dev/docs/tasks-regular))." Never use generic labels like "docs", "source", or "here".
- Never invent or extrapolate API signatures, parameter names, property names, or return value shapes. If the retrieved docs do not explicitly show a method's exact usage, tell the user to check the official docs page directly rather than guessing.
- If the docs don't cover something, say so clearly — do not guess.
- Be concise and technical. These are developers; skip the hand-holding.
- If a user reports an error, ask for the full error message and relevant code if not already provided.`;

/**
 * Rewrites the user's natural-language question into a dense technical query using
 * Trigger.dev-specific terms so BM25 (which is blind to semantic intent) gets signal,
 * and vector search gets a better embedding anchor.
 *
 * Falls back to the original query on any error so retrieval is never blocked.
 */
async function expandQuery(query: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: openrouter.chat("google/gemini-3-flash-preview"),
      system: `You are a search query optimizer for Trigger.dev documentation.
Rewrite the user's question as a short, dense search query using Trigger.dev-specific technical terms — SDK method names, API names, and concept names (e.g. "task", "waitpoint", "concurrencyKey", "triggerAndWait", "wait.forToken", "batchTrigger", "schemaTask", "realtime") — where applicable.
Output only the rewritten query. No explanation. No punctuation at the end. 20 words max.`,
      prompt: query,
    });
    return text.trim() || query;
  } catch {
    return query;
  }
}

function buildContext(results: SearchResult[]): string {
  if (results.length === 0) return "No relevant docs found.";
  return results
    .map((r) => `### ${r.section}\nSource: ${r.url}\n\n${r.content}`)
    .join("\n\n---\n\n");
}

export const myChat = chat.agent({
  id: "trigger-support",
  run: async ({ messages, signal }) => {
    // Extract the latest user query for search
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const query =
      typeof lastUserMsg?.content === "string"
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg?.content)
          ? lastUserMsg.content
              .filter((p) => p.type === "text")
              .map((p) => ("text" in p ? (p.text as string) : ""))
              .join(" ")
          : "";

    // Expand the query to Trigger.dev technical terms before searching.
    // Pure-semantic questions ("pause a job until a human approves it") score near zero
    // on BM25 and can miss the right page on vector too. Expansion fixes both.
    // Pre-fetch pattern required: chat.agent() ends the stream after the first finish
    // event, so maxSteps / multi-step tool calling doesn't work yet.
    const searchQuery = await expandQuery(query);
    const searchResults = await runSearch(searchQuery);

    const systemWithContext = `${SYSTEM_PROMPT}

## Retrieved documentation
${buildContext(searchResults)}`;

    return streamText({
      model: openrouter.chat("google/gemini-3-flash-preview"),
      system: systemWithContext,
      messages,
      abortSignal: signal,
    });
  },
});
