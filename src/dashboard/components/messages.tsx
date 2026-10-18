import type { Message } from "../../domain/types.ts";
import { Action, Badge, Empty, Mono, Time } from "./primitives.tsx";
export function MessageTimeline({ messages }: { messages: Message[] }) {
  return messages.length
    ? (
      <div class="divide-y divide-base-300 rounded-md border border-base-300">
        {messages.map((message) => (
          <article class="flex gap-3 px-5 py-5">
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-base-300 font-mono text-[10px] text-base-content/60">
              {(message.senderUsername ?? "AN").slice(0, 2).toUpperCase()}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-medium">
                    {message.senderUsername ?? "Anonymous"}
                  </span>
                  {message.editedAt
                    ? (
                      <Badge>
                        {message.editedByOwner ? "Edited by owner" : "Edited"}
                      </Badge>
                    )
                    : null}
                </div>
                <Time value={message.createdAt} />
              </div>
              <pre
                id={"message-" + message.id}
                class="mt-3 whitespace-pre-wrap break-words font-sans text-[13px] leading-6 text-base-content/80"
              >{message.text}</pre>
              <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
                <Mono>{message.id}</Mono>
                <div>
                  <Action action="edit-message" id={message.id}>
                    Edit message
                  </Action>
                  <Action action="delete-message" id={message.id} danger>
                    Delete
                  </Action>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
    )
    : (
      <div class="rounded-md border border-base-300">
        <Empty title="No messages on this page" />
      </div>
    );
}
