import { useEffect, useCallback, useRef } from "react";
import type YProvider from "y-partyserver/provider";
import {
  type CustomMessage,
  type MessageType,
  encodeMessage,
  decodeMessage,
} from "../../shared/messages";

type MessageHandler = (message: CustomMessage) => void;

export interface UseCustomMessagesProps {
  provider: YProvider | null;
}

export function useCustomMessages({ provider }: UseCustomMessagesProps) {
  const handlersRef = useRef<Map<MessageType, MessageHandler[]>>(new Map());

  const on = useCallback((type: MessageType, handler: MessageHandler) => {
    const handlers = handlersRef.current.get(type) || [];
    handlers.push(handler);
    handlersRef.current.set(type, handlers);

    return () => {
      const current = handlersRef.current.get(type);
      if (current) {
        handlersRef.current.set(
          type,
          current.filter((h) => h !== handler),
        );
      }
    };
  }, []);

  const send = useCallback(
    (message: CustomMessage) => {
      if (!provider) return;
      provider.sendMessage(encodeMessage(message));
    },
    [provider],
  );

  useEffect(() => {
    if (!provider) return;

    const listener = (data: string) => {
      try {
        const message = decodeMessage(data);
        const handlers = handlersRef.current.get(message.type);
        if (handlers) {
          for (const handler of handlers) {
            handler(message);
          }
        }
      } catch {
        // ignore malformed messages
      }
    };

    provider.on("custom-message", listener);

    return () => {
      provider.off("custom-message", listener);
    };
  }, [provider]);

  return { on, send };
}
