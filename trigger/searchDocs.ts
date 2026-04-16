import { schemaTask } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import * as lancedb from "@lancedb/lancedb";
import { embed } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import path from "path";

export interface SearchResult {
  section: string;
  content: string;
  url: string;
  file_path: string;
}

const LANCEDB_URI = process.env.LANCEDB_URI ?? path.join(process.cwd(), "lancedb-data");

/** Max results to return after deduplication */
const MAX_RESULTS = 12;

/**
 * Multi-query search: runs both the expanded query and original query,
 * merges results, and deduplicates by chunk ID. This ensures both
 * semantic (expanded) and exact-term (original) signals are captured.
 */
export async function runSearch(
  expandedQuery: string,
  originalQuery?: string
): Promise<SearchResult[]> {
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const db = await lancedb.connect(LANCEDB_URI);

  let table: lancedb.Table;
  try {
    table = await db.openTable("docs");
  } catch {
    return [];
  }

  const reranker = await lancedb.rerankers.RRFReranker.create();

  // Run primary search on the expanded query
  const { embedding: expandedEmb } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: expandedQuery,
  });

  const primaryRows = await table
    .query()
    .nearestTo(Float32Array.from(expandedEmb))
    .fullTextSearch(expandedQuery, { columns: ["content"] })
    .rerank(reranker)
    .select(["id", "section", "content", "url", "file_path"])
    .limit(MAX_RESULTS)
    .toArray();

  // If we have a different original query, run a secondary search and merge
  const effectiveOriginal = originalQuery?.trim();
  if (effectiveOriginal && effectiveOriginal !== expandedQuery) {
    const { embedding: originalEmb } = await embed({
      model: openai.embedding("text-embedding-3-small"),
      value: effectiveOriginal,
    });

    const secondaryRows = await table
      .query()
      .nearestTo(Float32Array.from(originalEmb))
      .fullTextSearch(effectiveOriginal, { columns: ["content"] })
      .rerank(reranker)
      .select(["id", "section", "content", "url", "file_path"])
      .limit(6)
      .toArray();

    // Merge: deduplicate by chunk ID, primary results take priority
    const seenIds = new Set(primaryRows.map((r) => String(r.id)));
    for (const row of secondaryRows) {
      if (!seenIds.has(String(row.id))) {
        primaryRows.push(row);
        seenIds.add(String(row.id));
      }
    }
  }

  return primaryRows.slice(0, MAX_RESULTS).map((r) => ({
    section: String(r.section ?? ""),
    content: String(r.content ?? ""),
    url: String(r.url ?? ""),
    file_path: String(r.file_path ?? ""),
  }));
}

/** Standalone task — kept for direct triggering / testing via dashboard */
export const searchDocsTask = schemaTask({
  id: "search-docs",
  schema: z.object({
    query: z.string().describe("Natural language question about Trigger.dev"),
  }),
  run: ({ query }) => runSearch(query, query),
});
