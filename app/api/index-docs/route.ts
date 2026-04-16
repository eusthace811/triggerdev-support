import { tasks } from "@trigger.dev/sdk/v3";
import { NextResponse } from "next/server";

export async function POST() {
  // Trigger by string ID — do NOT import indexDocs.ts here.
  // That file imports @lancedb/lancedb (native binary) which can't be
  // bundled by Next.js. The task only runs inside the Trigger.dev worker.
  const handle = await tasks.trigger("index-docs", undefined);
  return NextResponse.json({ runId: handle.id });
}
