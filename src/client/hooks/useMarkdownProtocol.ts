import { useCallback, useEffect, useRef } from "react";
import {
	type CustomMessage,
	MessageTypeCanonicalMarkdown,
	MessageTypeNeedsInit,
	MessageTypeReloadRemote,
	MessageTypeRequestMarkdown,
	type NeedsInitPayload,
	type ReloadRemotePayload,
	type RequestMarkdownPayload,
} from "../../shared/messages";
import type { UseCustomMessagesProps } from "./useCustomMessages";
import { useCustomMessages } from "./useCustomMessages";

export interface UseMarkdownProtocolProps extends UseCustomMessagesProps {
	getMarkdown: () => string;
	onNeedsInit?: (gistId: string, filename: string) => void;
	onReloadRemote?: (markdown: string) => void;
}

export function useMarkdownProtocol({
	provider,
	getMarkdown,
	onNeedsInit,
	onReloadRemote,
}: UseMarkdownProtocolProps) {
	const { on, send } = useCustomMessages({ provider });
	const respondedRequestIds = useRef<Set<string>>(new Set());

	const handleRequestMarkdown = useCallback(
		(message: CustomMessage) => {
			if (message.type !== MessageTypeRequestMarkdown) return;
			const payload = message.payload as RequestMarkdownPayload;

			if (respondedRequestIds.current.has(payload.requestId)) return;
			respondedRequestIds.current.add(payload.requestId);

			if (respondedRequestIds.current.size > 100) {
				const entries = Array.from(respondedRequestIds.current);
				respondedRequestIds.current = new Set(entries.slice(-50));
			}

			const markdown = getMarkdown();
			send({
				type: MessageTypeCanonicalMarkdown,
				payload: { requestId: payload.requestId, markdown },
			});
		},
		[getMarkdown, send],
	);

	const handleNeedsInit = useCallback(
		(message: CustomMessage) => {
			if (message.type !== MessageTypeNeedsInit) return;
			const payload = message.payload as NeedsInitPayload;
			onNeedsInit?.(payload.gistId, payload.filename);
		},
		[onNeedsInit],
	);

	const handleReloadRemote = useCallback(
		(message: CustomMessage) => {
			if (message.type !== MessageTypeReloadRemote) return;
			const payload = message.payload as ReloadRemotePayload;
			onReloadRemote?.(payload.markdown);
		},
		[onReloadRemote],
	);

	useEffect(() => {
		const unsubs = [
			on(MessageTypeRequestMarkdown, handleRequestMarkdown),
			on(MessageTypeNeedsInit, handleNeedsInit),
			on(MessageTypeReloadRemote, handleReloadRemote),
		];

		return () => {
			unsubs.forEach((unsub) => unsub());
		};
	}, [on, handleRequestMarkdown, handleNeedsInit, handleReloadRemote]);

	return { send };
}
