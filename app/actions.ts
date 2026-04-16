"use server";

import { chat } from "@trigger.dev/sdk/ai";
import type { ResolveChatAccessTokenParams } from "@trigger.dev/sdk/chat";
import type { myChat } from "@/trigger/chat";

export async function getChatToken(_input: ResolveChatAccessTokenParams) {
  return chat.createAccessToken<typeof myChat>("trigger-support");
}
