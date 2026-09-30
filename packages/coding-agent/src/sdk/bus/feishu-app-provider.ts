/**
 * Feishu enterprise-app bot live provider (conversation-capable counterpart of
 * `feishu-webhook.ts`).
 *
 * Inbound uses the official SDK's WebSocket long connection, so no public
 * callback URL is required. Outbound uses the tenant-access-token message APIs
 * (text chunks and interactive cards) against the one chat the daemon is bound
 * to. Everything transport-specific stays behind `FeishuAppProviderClient` so
 * tests can inject a scripted client.
 */
import { logger } from "@gajae-code/utils";
import { EventDispatcher, Client as LarkClient, WSClient as LarkWsClient, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { FEISHU_TEXT_CHUNK_CHARS } from "./feishu-webhook";

export interface FeishuAppProviderConfig {
	appId: string;
	appSecret: string;
	/** The one chat the bot serves; inbound from other chats is ignored. */
	chatId: string;
}

export interface FeishuAppInboundEnvelope {
	kind: "message" | "card_action";
	senderOpenId: string | undefined;
	/** Parsed text content of an inbound `text` message. */
	text: string | undefined;
	/** Button `value` payload of an inbound card action. */
	value: Record<string, unknown> | undefined;
	messageId: string | undefined;
}

export type FeishuAppDeliveryResult =
	| { ok: true; messageId: string | undefined }
	| { ok: false; uncertain: boolean; detail: string };

export interface FeishuAppProviderClient {
	/** Live transport liveness; omit when the client cannot observe it. */
	readonly transportHealthy?: boolean;
	start(onEnvelope: (envelope: FeishuAppInboundEnvelope) => void | Promise<void>): Promise<void>;
	stop(): Promise<void>;
	sendText(text: string): Promise<FeishuAppDeliveryResult>;
	sendCard(card: Record<string, unknown>): Promise<FeishuAppDeliveryResult>;
	/** Best-effort in-place card replacement (e.g. disabling answered buttons). */
	updateCard(messageId: string, card: Record<string, unknown>): Promise<FeishuAppDeliveryResult>;
	/** Best-effort removal of a bot-owned message (e.g. an ephemeral status card). */
	deleteMessage(messageId: string): Promise<FeishuAppDeliveryResult>;
}

function readString(source: unknown, key: string): string | undefined {
	if (!source || typeof source !== "object") return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readObject(source: unknown, key: string): Record<string, unknown> | undefined {
	if (!source || typeof source !== "object") return undefined;
	const value = (source as Record<string, unknown>)[key];
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Feishu splits text rendering per message; chunk identical to the webhook transport. */
export function chunkFeishuAppText(text: string): string[] {
	if (text.length === 0) return [];
	if (text.length <= FEISHU_TEXT_CHUNK_CHARS) return [text];
	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		let end = Math.min(cursor + FEISHU_TEXT_CHUNK_CHARS, text.length);
		if (end < text.length) {
			const newline = text.lastIndexOf("\n", end);
			if (newline > cursor) end = newline;
		}
		chunks.push(text.slice(cursor, end));
		cursor = end === cursor ? end + 1 : end;
	}
	return chunks.length > 0 ? chunks : [text];
}

/**
 * Feishu ships text message content as a JSON-encoded string
 * (`"{\"text\":\"...\"}"`); accept a pre-parsed object too, for tests and
 * schema variants that deliver it already decoded.
 */
export function readMessageText(message: Record<string, unknown>): string | undefined {
	const decoded = readString(readObject(message, "content"), "text");
	if (decoded !== undefined) return decoded;
	const encoded = readString(message, "content");
	if (encoded === undefined) return undefined;
	try {
		return readString(JSON.parse(encoded) as unknown, "text");
	} catch {
		return undefined;
	}
}

export function parseMessageEnvelope(data: unknown, chatId: string): FeishuAppInboundEnvelope | undefined {
	const message = readObject(data, "message");
	if (!message) return undefined;
	// The provider is bound to one chat; drop anything the tenant routes here
	// from elsewhere instead of trusting the payload's own routing claims.
	if (readString(message, "chat_id") !== chatId) return undefined;
	if (readString(message, "message_type") !== "text") return undefined;
	const sender = readObject(data, "sender");
	// Ignore echoes of the bot's own messages and non-user senders.
	if (readString(sender, "sender_type") !== "user") return undefined;
	const rawText = readMessageText(message);
	if (rawText === undefined) return undefined;
	const senderId = readObject(sender, "sender_id");
	return {
		kind: "message",
		senderOpenId: readString(senderId, "open_id"),
		text: rawText,
		value: undefined,
		messageId: readString(message, "message_id"),
	};
}

/**
 * Field-level summary for a dropped message event; chat ids and message/sender
 * types are diagnostic identifiers, never message content.
 */
export function describeMessageEventDrop(data: unknown, chatId: string): string {
	const message = readObject(data, "message");
	if (!message) return "no message object";
	const actualChat = readString(message, "chat_id");
	const chat = actualChat === undefined ? "chat_id missing" : actualChat === chatId ? "bound chat" : "unbound chat";
	const type = readString(message, "message_type") ?? "unknown";
	const sender = readObject(data, "sender");
	const senderType = readString(sender, "sender_type") ?? "unknown";
	const hasText = readMessageText(message) !== undefined;
	return `${chat}, message_type=${type}, sender_type=${senderType}, text=${hasText ? "present" : "absent"}`;
}

export function parseCardActionEnvelope(data: unknown): FeishuAppInboundEnvelope | undefined {
	const action = readObject(data, "action");
	if (!action) return undefined;
	const value = readObject(action, "value");
	if (!value) return undefined;
	const operator = readObject(data, "operator");
	// Card-click identities arrive at the root on current WS payloads and under
	// `context` on older schemas; read both, prefer the root.
	const messageId = readString(data, "open_message_id") ?? readString(readObject(data, "context"), "open_message_id");
	const openId =
		readString(data, "open_id") ??
		readString(operator, "open_id") ??
		readString(readObject(data, "context"), "open_id");
	return {
		kind: "card_action",
		senderOpenId: openId,
		text: undefined,
		value,
		messageId,
	};
}

/** Feishu SDK error carrying a provider verdict code, when one is available. */
function apiErrorCode(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as Record<string, unknown>).code;
	return typeof code === "number" ? code : undefined;
}

/** REST-only surface health/test diagnostics need; no WS lifecycle. */
export type FeishuAppDiagnosticProvider = Pick<FeishuAppProviderClient, "sendText">;

export class FeishuAppLiveProvider implements FeishuAppProviderClient {
	#lark: LarkClient | undefined;
	#ws: LarkWsClient | undefined;
	#onEnvelope: ((envelope: FeishuAppInboundEnvelope) => void | Promise<void>) | undefined;
	#generation = 0;
	#stopped = true;
	#healthy = false;

	constructor(private readonly config: FeishuAppProviderConfig) {}

	get transportHealthy(): boolean {
		return this.#healthy;
	}

	async start(onEnvelope: (envelope: FeishuAppInboundEnvelope) => void | Promise<void>): Promise<void> {
		this.#generation++;
		const generation = this.#generation;
		this.#onEnvelope = onEnvelope;
		this.#stopped = false;
		this.#healthy = false;
		if (!this.#lark)
			this.#lark = new LarkClient({
				appId: this.config.appId,
				appSecret: this.config.appSecret,
				loggerLevel: LoggerLevel.warn,
			});
		if (this.#ws) {
			this.#ws.close({ force: true });
			this.#ws = undefined;
		}
		const dispatcher = new EventDispatcher({});
		dispatcher.register({
			"im.message.receive_v1": async data => {
				if (generation !== this.#generation || this.#stopped) return;
				const envelope = parseMessageEnvelope(data, this.config.chatId);
				if (!envelope) {
					logger.info(
						`Feishu app bot dropped an inbound message event (${describeMessageEventDrop(data, this.config.chatId)}).`,
					);
					return;
				}
				logger.info(`Feishu app bot received a message from ${envelope.senderOpenId ?? "an unknown sender"}.`);
				await this.#onEnvelope?.(envelope);
			},
			"card.action.trigger": async (data: unknown) => {
				if (generation !== this.#generation || this.#stopped) return;
				const envelope = parseCardActionEnvelope(data);
				if (!envelope) {
					logger.info("Feishu app bot dropped a card action event (missing action value or identity).");
					return;
				}
				logger.info(`Feishu app bot received a card action from ${envelope.senderOpenId ?? "an unknown sender"}.`);
				await this.#onEnvelope?.(envelope);
			},
		});
		const ws = new LarkWsClient({
			appId: this.config.appId,
			appSecret: this.config.appSecret,
			onReady: () => {
				if (generation !== this.#generation) return;
				this.#healthy = true;
			},
			onError: error => {
				if (generation !== this.#generation) return;
				this.#healthy = false;
				logger.warn(`Feishu app bot transport failed: ${error instanceof Error ? error.message : String(error)}`);
			},
		});
		this.#ws = ws;
		await ws.start({ eventDispatcher: dispatcher });
	}

	async stop(): Promise<void> {
		this.#generation++;
		this.#stopped = true;
		this.#onEnvelope = undefined;
		this.#healthy = false;
		this.#ws?.close({ force: true });
		this.#ws = undefined;
	}

	async sendText(text: string): Promise<FeishuAppDeliveryResult> {
		let lastMessageId: string | undefined;
		for (const chunk of chunkFeishuAppText(text)) {
			const result = await this.#createMessage({
				receive_id: this.config.chatId,
				msg_type: "text",
				content: JSON.stringify({ text: chunk }),
			});
			if (!result.ok) return result;
			lastMessageId = result.messageId ?? lastMessageId;
		}
		return { ok: true, messageId: lastMessageId };
	}

	async sendCard(card: Record<string, unknown>): Promise<FeishuAppDeliveryResult> {
		return await this.#createMessage({
			receive_id: this.config.chatId,
			msg_type: "interactive",
			content: JSON.stringify(card),
		});
	}

	async updateCard(messageId: string, card: Record<string, unknown>): Promise<FeishuAppDeliveryResult> {
		const lark = this.#requireClient();
		try {
			const response = await lark.im.message.patch({
				path: { message_id: messageId },
				data: { content: JSON.stringify(card) },
			});
			return this.#verdict(response, "card update");
		} catch (error) {
			return this.#failure(error, "card update", true);
		}
	}

	async deleteMessage(messageId: string): Promise<FeishuAppDeliveryResult> {
		const lark = this.#requireClient();
		try {
			const response = await lark.im.message.delete({ path: { message_id: messageId } });
			return this.#verdict(response, "message delete");
		} catch (error) {
			return this.#failure(error, "message delete", true);
		}
	}

	#requireClient(): LarkClient {
		if (!this.#lark)
			this.#lark = new LarkClient({
				appId: this.config.appId,
				appSecret: this.config.appSecret,
				loggerLevel: LoggerLevel.warn,
			});
		return this.#lark;
	}

	async #createMessage(body: Record<string, unknown>): Promise<FeishuAppDeliveryResult> {
		const lark = this.#requireClient();
		try {
			const response = await lark.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: body as never,
			});
			const verdict = this.#verdict(response, "message send");
			if (verdict.ok) {
				const data = readObject(response, "data");
				const message = readObject(data, "message");
				return { ok: true, messageId: readString(message, "message_id") };
			}
			return verdict;
		} catch (error) {
			return this.#failure(error, "message send", true);
		}
	}

	#verdict(
		response: unknown,
		what: string,
	): { ok: true; messageId: string | undefined } | { ok: false; uncertain: boolean; detail: string } {
		const code = apiErrorCode(response);
		// SDK resolves with `{ code, msg }` instead of throwing for API-level
		// verdicts. A non-zero code is a definitive rejection, never an
		// uncertainty; transport-level failures surface as thrown errors.
		if (code === undefined || code === 0) return { ok: true, messageId: undefined };
		return { ok: false, uncertain: false, detail: `${what} rejected by Feishu (code ${code}).` };
	}

	#failure(error: unknown, what: string, uncertain: boolean): { ok: false; uncertain: boolean; detail: string } {
		const code = apiErrorCode(error);
		return {
			ok: false,
			uncertain: code === undefined ? uncertain : false,
			detail: error instanceof Error ? `${what} failed: ${error.message}` : `${what} failed: ${String(error)}`,
		};
	}
}
