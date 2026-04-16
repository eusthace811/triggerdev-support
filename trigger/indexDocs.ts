import { task, logger } from "@trigger.dev/sdk/v3";
import * as lancedb from "@lancedb/lancedb";
import { embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import path from "path";

interface DocChunk {
  id: string;
  file_path: string;
  section: string;
  content: string;
  url: string;
  vector: Float32Array;
}

const LANCEDB_URI = process.env.LANCEDB_URI ?? path.join(process.cwd(), "lancedb-data");
const LANCEDB_API_KEY = process.env.LANCEDB_API_KEY;

export const indexDocsTask = task({
  id: "index-docs",
  maxDuration: 600,
  run: async () => {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 1. List all MDX files via GitHub tree API (one request for the whole repo)
    logger.info("Fetching file tree from GitHub...");
    const treeRes = await fetch(
      "https://api.github.com/repos/triggerdotdev/trigger.dev/git/trees/main?recursive=1",
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(process.env.GITHUB_TOKEN && {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          }),
        },
      }
    );
    if (!treeRes.ok) {
      throw new Error(`GitHub tree API error: ${treeRes.status} ${await treeRes.text()}`);
    }
    const { tree } = (await treeRes.json()) as {
      tree: Array<{ path: string; type: string }>;
    };

    const mdxPaths = tree
      .filter(
        (f) =>
          f.type === "blob" &&
          f.path.startsWith("docs/") &&
          (f.path.endsWith(".mdx") || f.path.endsWith(".md")) &&
          !f.path.match(/\/migration-/) // exclude third-party migration guides — they pollute retrieval with non-Trigger.dev concepts
      )
      .map((f) => f.path);

    logger.info(`Found ${mdxPaths.length} documentation files`);

    // 2. Fetch file contents in parallel batches of 20
    const FETCH_BATCH = 20;
    const files: Array<{ path: string; content: string }> = [];

    for (let i = 0; i < mdxPaths.length; i += FETCH_BATCH) {
      const batch = mdxPaths.slice(i, i + FETCH_BATCH);
      const results = await Promise.all(
        batch.map(async (filePath) => {
          const res = await fetch(
            `https://raw.githubusercontent.com/triggerdotdev/trigger.dev/main/${filePath}`
          );
          if (!res.ok) return null;
          return { path: filePath, content: await res.text() };
        })
      );
      for (const r of results) {
        if (r) files.push(r);
      }
      logger.info(`Fetched ${Math.min(i + FETCH_BATCH, mdxPaths.length)}/${mdxPaths.length} files`);
    }

    // 3. Parse each file into section-level chunks
    const rawChunks: Omit<DocChunk, "vector">[] = [];
    for (const { path: filePath, content } of files) {
      rawChunks.push(...chunkMdx(filePath, content));
    }
    logger.info(`Created ${rawChunks.length} chunks from ${files.length} files`);

    // 4. Embed in batches of 100 using text-embedding-3-small
    const EMBED_BATCH = 100;
    const allVectors: Float32Array[] = [];

    for (let i = 0; i < rawChunks.length; i += EMBED_BATCH) {
      const batch = rawChunks.slice(i, i + EMBED_BATCH);
      const { embeddings } = await embedMany({
        model: openai.embedding("text-embedding-3-small"),
        values: batch.map((c) => `${c.section}\n\n${c.content}`),
      });
      for (const e of embeddings) {
        allVectors.push(Float32Array.from(e));
      }
      logger.info(
        `Embedded ${Math.min(i + EMBED_BATCH, rawChunks.length)}/${rawChunks.length} chunks`
      );
    }

    // 5. Build final rows
    const rows: DocChunk[] = rawChunks.map((chunk, i) => ({
      ...chunk,
      vector: allVectors[i],
    }));

    // 6. Write to LanceDB (overwrite if exists)
    logger.info(`Writing ${rows.length} rows to LanceDB at ${LANCEDB_URI}...`);
    const db = await lancedb.connect(LANCEDB_URI, {
      ...(LANCEDB_API_KEY ? { apiKey: LANCEDB_API_KEY, region: "us-east-1" } : {}),
    });
    const table = await db.createTable(
      "docs",
      rows as unknown as Record<string, unknown>[],
      { mode: "overwrite" }
    );

    // 7. Create full-text search (BM25) indexes on content and section columns
    await table.createIndex("content", { config: lancedb.Index.fts() });
    await table.createIndex("section", { config: lancedb.Index.fts() });
    logger.info("FTS indexes created (content + section)");

    return { files: files.length, chunks: rows.length };
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Max characters per chunk. Sections longer than this are split into overlapping sub-chunks. */
const CHUNK_CAP = 1500;
/** Overlap between consecutive sub-chunks so context isn't lost at boundaries. */
const CHUNK_OVERLAP = 200;
/** Minimum body length to index a section (lowered to catch tables and short dense content). */
const MIN_BODY = 40;

function chunkMdx(filePath: string, raw: string): Omit<DocChunk, "vector">[] {
  // Strip frontmatter block
  const noFrontmatter = raw.replace(/^---[\s\S]*?---\s*\n/, "");
  // Strip MDX import lines
  const noImports = noFrontmatter.replace(/^import\s+.*$/gm, "");
  // Convert semantic JSX tags to markdown labels so their content is preserved with context
  const withLabels = noImports
    .replace(/<(Note|Tip|Warning|Info|Callout|Important)(?:\s[^>]*)?>/gi, "\n**$1:** ")
    .replace(/<\/(Note|Tip|Warning|Info|Callout|Important)>/gi, "\n");
  // Remove remaining JSX tags (keep any plain text between them)
  const cleaned = withLabels.replace(/<\/?[A-Za-z][A-Za-z0-9.]*(?:\s[^>]*)?\/?>/g, " ");

  const url = pathToUrl(filePath);
  // Page context prefix for BM25 — e.g. "Page: self-hosting/overview"
  const pageSlug = filePath.replace(/^docs\//, "").replace(/\.mdx?$/, "");
  const pageContext = `Page: ${pageSlug}`;
  const chunks: Omit<DocChunk, "vector">[] = [];

  // Split on h2 / h3 headings; keep heading line attached to the section
  const sections = cleaned.split(/(?=^#{2,3} )/m);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const firstNewline = trimmed.indexOf("\n");
    const headingLine =
      firstNewline === -1 ? trimmed : trimmed.slice(0, firstNewline);
    const body = firstNewline === -1 ? "" : trimmed.slice(firstNewline + 1).trim();

    // Detect whether this is a pre-heading intro (no ## prefix)
    const isHeading = /^#{2,3}\s+/.test(headingLine);
    const heading = isHeading
      ? headingLine.replace(/^#{2,3}\s+/, "").trim()
      : "Overview";

    if (body.length < MIN_BODY) continue;

    const safeId = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    // Prefix with page context so BM25 can match on page-level terms
    const prefix = `${pageContext} | Section: ${heading}\n\n`;
    const prefixedBody = prefix + body;

    // Split large sections into overlapping sub-chunks
    if (prefixedBody.length <= CHUNK_CAP) {
      chunks.push({
        id: `${filePath}#${safeId}`,
        file_path: filePath,
        section: heading,
        content: prefixedBody,
        url,
      });
    } else {
      let offset = 0;
      let part = 0;
      while (offset < prefixedBody.length) {
        const end = Math.min(offset + CHUNK_CAP, prefixedBody.length);
        const slice = prefixedBody.slice(offset, end);
        // Don't emit a tail chunk smaller than CHUNK_OVERLAP — it adds no new signal
        if (slice.length > CHUNK_OVERLAP) {
          chunks.push({
            id: `${filePath}#${safeId}-p${part}`,
            file_path: filePath,
            section: heading,
            content: slice,
            url,
          });
          part++;
        }
        offset += CHUNK_CAP - CHUNK_OVERLAP;
      }
    }
  }

  // Fallback: treat the whole file as one chunk if no headings were found
  if (chunks.length === 0 && cleaned.trim().length >= MIN_BODY) {
    const name =
      filePath.split("/").pop()?.replace(/\.mdx?$/, "") ?? "Doc";
    chunks.push({
      id: filePath,
      file_path: filePath,
      section: name,
      content: `${pageContext} | Section: ${name}\n\n${cleaned.trim().slice(0, CHUNK_CAP)}`,
      url,
    });
  }

  return chunks;
}

function pathToUrl(filePath: string): string {
  // docs/introduction.mdx  →  https://trigger.dev/docs/introduction
  // docs/guides/nextjs.mdx →  https://trigger.dev/docs/guides/nextjs
  return (
    "https://trigger.dev/docs/" +
    filePath.replace(/^docs\//, "").replace(/\.mdx?$/, "")
  );
}
