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

/** Shared search logic — called directly in the chat agent to avoid waitpoint suspension */
export async function runSearch(query: string): Promise<SearchResult[]> {
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const [{ embedding }, db] = await Promise.all([
    embed({
      model: openai.embedding("text-embedding-3-small"),
      value: query,
    }),
    lancedb.connect(LANCEDB_URI),
  ]);

  let table: lancedb.Table;
  try {
    table = await db.openTable("docs");
  } catch {
    return [];
  }

  const reranker = await lancedb.rerankers.RRFReranker.create();

  const rows = await table
    .query()
    .nearestTo(Float32Array.from(embedding))
    .fullTextSearch(query, { columns: ["content"] })
    .rerank(reranker)
    .select(["id", "section", "content", "url", "file_path"])
    .limit(8)
    .toArray();

  return rows.map((r) => ({
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
  run: ({ query }) => runSearch(query),
});
