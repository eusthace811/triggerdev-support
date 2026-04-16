"use client";

import { useChat } from "@ai-sdk/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import type { myChat } from "@/trigger/chat";
import { getChatToken } from "@/app/actions";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageActions,
  MessageAction,
  MessageContent,
  MessageResponse,
  MessageToolbar,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCarousel,
  InlineCitationCarouselContent,
  InlineCitationCarouselItem,
  InlineCitationSource,
} from "@/components/ai-elements/inline-citation";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import { HoverCardTrigger } from "@/components/ui/hover-card";
import { Badge } from "@/components/ui/badge";
import { CopyIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

const GENERIC_LABELS = new Set([
  "docs", "source", "here", "link", "this", "documentation", "see docs", "reference",
]);

function urlToTitle(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname}${pathname}`;
  } catch {
    return url;
  }
}

function cleanLabel(label: string): string {
  return label.replace(/^(docs|source|doc):\s*/i, "").trim();
}

function extractDocSources(text: string): { url: string; title: string }[] {
  const linkRegex = /\[([^\]]*)\]\((https:\/\/trigger\.dev\/docs\/[^)]+)\)/g;
  const seen = new Set<string>();
  const results: { url: string; title: string }[] = [];
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    const [, rawLabel, url] = match;
    if (!seen.has(url)) {
      seen.add(url);
      const label = cleanLabel(rawLabel);
      const isGeneric = GENERIC_LABELS.has(label.toLowerCase().trim());
      results.push({ url, title: isGeneric ? urlToTitle(url) : label });
    }
  }
  return results;
}

type CitationPart =
  | { type: "text"; content: string }
  | { type: "citation"; url: string; title: string };

/**
 * Splits the completed assistant message text into alternating text segments
 * and citation markers, so badges can be rendered inline at the right positions.
 * Only matches "([label](trigger.dev/docs/...))" — the pattern the model uses.
 */
function parseTextWithCitations(text: string): CitationPart[] {
  const parts: CitationPart[] = [];
  const seen = new Set<string>();
  // Also consume any trailing punctuation (e.g. the "." in "([label](url)).")
  // so it doesn't become an orphaned line after the badge.
  const regex = /\s*\(\[([^\]]+)\]\((https:\/\/trigger\.dev\/docs\/[^)]+)\)\)[.!?,;]?/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    const rawLabel = match[1];
    const url = match[2];
    // Skip duplicate URLs so badge count matches Sources count
    if (!seen.has(url)) {
      seen.add(url);
      const label = cleanLabel(rawLabel);
      const isGeneric = GENERIC_LABELS.has(label.toLowerCase().trim());
      const title = isGeneric ? urlToTitle(url) : label;
      parts.push({ type: "citation", url, title });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", content: text.slice(lastIndex) });
  }

  return parts;
}

const LOADING_PHRASES = [
  "Thinking…",
  "Searching docs…",
  "Reading the docs…",
  "Looking it up…",
  "On it…",
  "Checking the docs…",
];

const SUGGESTIONS = [
  "What are the limitations of the self-hosted version?",
  "Does waiting time in triggerAndWait count as compute time?",
  "How do I run a cron job every 30 minutes?",
  "How do I exit a task early if certain criteria are met?",
];


export function Chat() {
  const transport = useTriggerChatTransport<typeof myChat>({
    task: "trigger-support",
    accessToken: getChatToken,
  });

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- pre-release SDK UIMessageChunk type narrows FinishReason vs ai@5
  const { messages, sendMessage, stop, status } = useChat({ transport });
  const [inputText, setInputText] = useState("");
  const isGenerating = status === "streaming" || status === "submitted";
  const loadingPhrase = useMemo(
    () => LOADING_PHRASES[Math.floor(Math.random() * LOADING_PHRASES.length)],
    // re-pick each time generation starts
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isGenerating],
  );

  const handleSubmit = ({ text }: { text: string }) => {
    if (!text.trim() || isGenerating) return;
    sendMessage({ text: text.trim() });
    setInputText("");
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <Conversation>
        <ConversationContent>
          <div className="mx-auto w-full max-w-3xl">
          {messages.length === 0 && (
            <ConversationEmptyState>
              <img src="/triggerito.svg" alt="Triggerito" className="w-24 h-24" />
              <div className="space-y-2 text-center">
                <h3 className="font-semibold text-2xl">I am Triggerito, how can I help?</h3>
                <p className="text-muted-foreground text-lg">
                  Ask anything about Trigger.dev — tasks, scheduling, deployment, and more.
                </p>
              </div>
            </ConversationEmptyState>
          )}
          {messages.map((m, idx) => {
            const isLastMessage = idx === messages.length - 1;

            return (
              <Fragment key={m.id}>
                {m.parts.map((part, i) => {
                  if (part.type !== "text") return null;
                  if (!part.text.trim()) return null;
                  const isAnimating =
                    isLastMessage &&
                    m.role === "assistant" &&
                    status === "streaming";

                  // Parse citation positions only after streaming is complete
                  const citationParts =
                    m.role === "assistant" && !isAnimating
                      ? parseTextWithCitations(part.text)
                      : null;

                  const docSources =
                    m.role === "assistant" && !isAnimating
                      ? extractDocSources(part.text)
                      : [];

                  return (
                    <Message
                      key={`${m.id}-${i}`}
                      from={m.role}
                      className={m.role === "user" ? "mb-4" : ""}
                    >
                      <MessageContent className="text-lg">
                        {isAnimating || !citationParts ? (
                          // During streaming: render raw text as one block
                          <MessageResponse isAnimating={isAnimating}>
                            {part.text}
                          </MessageResponse>
                        ) : (
                          // After streaming: interleave text segments and citation badges
                          citationParts.map((p, pi) => {
                            if (p.type === "citation") {
                              return (
                                <InlineCitationCard key={pi}>
                                  <HoverCardTrigger
                                    render={
                                      <Badge
                                        variant="secondary"
                                        className="cursor-pointer rounded-full text-xs font-medium"
                                      />
                                    }
                                  >
                                    {p.title}
                                  </HoverCardTrigger>
                                  <InlineCitationCardBody>
                                    <InlineCitationCarousel>
                                      <InlineCitationCarouselContent>
                                        <InlineCitationCarouselItem>
                                          <InlineCitationSource
                                            title={p.title}
                                            url={p.url}
                                          />
                                          <a
                                            href={p.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="mt-2 inline-block text-xs text-primary underline-offset-4 hover:underline"
                                          >
                                            Open docs →
                                          </a>
                                        </InlineCitationCarouselItem>
                                      </InlineCitationCarouselContent>
                                    </InlineCitationCarousel>
                                  </InlineCitationCardBody>
                                </InlineCitationCard>
                              );
                            }
                            // Text segment — skip empty/whitespace-only ones
                            if (!p.content.trim()) return null;
                            // Pure punctuation left after stripping parens → render as span
                            if (/^[\s.!?,;:]+$/.test(p.content)) {
                              return <span key={pi}>{p.content.trim()}</span>;
                            }
                            return (
                              <MessageResponse key={pi} isAnimating={false}>
                                {p.content}
                              </MessageResponse>
                            );
                          })
                        )}
                        {docSources.length > 0 && (
                          <Sources>
                            <SourcesTrigger count={docSources.length} />
                            <SourcesContent>
                              {docSources.map((s) => (
                                <Source key={s.url} href={s.url} title={s.title} />
                              ))}
                            </SourcesContent>
                          </Sources>
                        )}
                      </MessageContent>
                      {m.role === "assistant" && !isAnimating && (
                        <MessageToolbar>
                          <MessageActions>
                            <MessageAction
                              tooltip="Copy"
                              onClick={() =>
                                navigator.clipboard.writeText(part.text)
                              }
                            >
                              <CopyIcon />
                            </MessageAction>
                          </MessageActions>
                        </MessageToolbar>
                      )}
                    </Message>
                  );
                })}
              </Fragment>
            );
          })}
          {isGenerating && (
            <Shimmer className="text-lg">{loadingPhrase}</Shimmer>
          )}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {messages.length === 0 && (
        <div className="px-4 pb-4">
          <div className="mx-auto max-w-3xl">
            <Suggestions>
              {SUGGESTIONS.map((s) => (
                <Suggestion
                  key={s}
                  suggestion={s}
                  size="default"
                  onClick={(text) => {
                    sendMessage({ text });
                  }}
                />
              ))}
            </Suggestions>
          </div>
        </div>
      )}

      <div className="border-t px-4 py-4">
        <PromptInput
          onSubmit={handleSubmit}
          className="mx-auto max-w-3xl"
        >
          <PromptInputTextarea
            value={inputText}
            onChange={(e) => setInputText(e.currentTarget.value)}
            placeholder="Ask about Trigger.dev..."
            className="text-lg md:text-lg"
          />
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit
              status={status}
              onStop={stop}
              disabled={!inputText.trim() && !isGenerating}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
