/**
 * Feishu enterprise-app conversation daemon.
 *
 * One bound chat, plain text plus interactive-card asks. The runtime fans
 * session notifications in through `notify`/`resume`/`postCommandResult` and
 * authorized inbound messages/cards route back out through reply frames or
 * `/sdk` command dispatch. There is no durable thread store: the daemon keeps
 * only in-memory pending-ask state, so restarts lose nothing that the session
 * host does not already own.
 */
import { randomUUID } from "node:crypto";
import { logger } from "@gajae-code/utils";
import type { SessionAttachment } from "../router";
import type { FeishuAppInboundEnvelope, FeishuAppProviderClient } from "./feishu-app-provider";

/** Card labels stay scannable; questions keep the shared chat-question budget. */
const FEISHU_APP_QUESTION_CHARS = 1_200;
const FEISHU_APP_OPTION_CHARS = 180;
const FEISHU_APP_MAX_OPTIONS = 8;
const PENDING_ACTION_LIMIT = 128;
const PUBLICATION_MEMORY_LIMIT = 512;
const NO_BOUND_SESSION_HINT =
	"暂无绑定到本群的活跃 GJC 会话：先启动一个 gjc 会话并让它推送一次通知，之后 /sdk 命令会路由到它。";
const DETACHED_SESSION_HINT = "此前绑定的会话已结束：重新启动 gjc 会话并推送一次通知后，/sdk 命令即可恢复路由。";
const FREE_FORM_ACCEPTED_HINT = "已提交到会话。";
const FREE_FORM_REJECTED_HINT = "会话未接受该消息（队列可能已满），请稍后重试。";

export interface FeishuAppNotifyInput {
	sessionId: string;
	endpointGeneration: number;
	content: string;
	publicationId?: string;
	actionId?: string;
	options?: string[];
}

interface PendingAction {
	readonly sessionId: string;
	readonly actionId: string;
	readonly options: string[];
	/** Card message id once the interactive send settles; enables in-place resolution. */
	messageId: string | undefined;
}

export interface FeishuAppDaemonOptions {
	provider: FeishuAppProviderClient;
	authorizedOpenIds: ReadonlySet<string>;
	resolveAttachment: (sessionId: string) => SessionAttachment | null | undefined;
	onCommand: (
		sessionId: string,
		content: string,
		attachment: SessionAttachment,
		idempotencyKey: string,
	) => Promise<boolean>;
	onFreeForm: (
		sessionId: string,
		content: string,
		attachment: SessionAttachment,
		idempotencyKey: string,
	) => Promise<boolean>;
}

function authorize(options: FeishuAppDaemonOptions, envelope: FeishuAppInboundEnvelope): boolean {
	return envelope.senderOpenId !== undefined && options.authorizedOpenIds.has(envelope.senderOpenId);
}

/**
 * Feishu renders @-mentions inside text payloads as `@_user_N` placeholders,
 * so "@机器人 /sdk help" arrives as "@_user_1 /sdk help"; strip every leading
 * placeholder before command and numbered-reply detection.
 */
export function stripLeadingMentionTokens(text: string): string {
	return text.replace(/^(?:\s*@_user_\d+)+\s*/, "").trim();
}

function readString(source: unknown, key: string): string | undefined {
	if (!source || typeof source !== "object") return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readIndex(source: unknown, key: string): number | undefined {
	if (!source || typeof source !== "object") return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Ask card: question text plus one button per option; the value carries the routing identity. */
export function buildAskCard(
	sessionId: string,
	actionId: string,
	question: string,
	options: string[],
): Record<string, unknown> {
	const elements: Record<string, unknown>[] = [
		{ tag: "div", text: { tag: "lark_md", content: question.slice(0, FEISHU_APP_QUESTION_CHARS) } },
	];
	if (options.length > 0) {
		elements.push({
			tag: "action",
			actions: options.slice(0, FEISHU_APP_MAX_OPTIONS).map((option, index) => ({
				tag: "button",
				text: { tag: "plain_text", content: `${index + 1}. ${option.slice(0, FEISHU_APP_OPTION_CHARS)}` },
				type: "primary",
				value: { sessionId, actionId, answerIndex: index },
			})),
		});
	}
	return {
		config: { enable_forward: false },
		header: { title: { tag: "plain_text", content: "GJC 需要你的输入" }, template: "orange" },
		elements,
	};
}

function resolvedCard(answer: string): Record<string, unknown> {
	return {
		config: { enable_forward: false },
		header: { title: { tag: "plain_text", content: "GJC 需要你的输入" }, template: "grey" },
		elements: [
			{ tag: "div", text: { tag: "lark_md", content: `已回答：${answer.slice(0, FEISHU_APP_OPTION_CHARS)}` } },
		],
	};
}

export class FeishuAppNotificationDaemon {
	readonly #options: FeishuAppDaemonOptions;
	readonly #pending = new Map<string, PendingAction>();
	readonly #delivered = new Set<string>();
	/** Most recent session that produced a delivery; routes free-form `/sdk` commands. */
	#lastSessionId: string | undefined;
	#started = false;

	constructor(options: FeishuAppDaemonOptions) {
		this.#options = options;
	}

	transportHealthy(): boolean {
		return this.#options.provider.transportHealthy ?? true;
	}

	restartBlocked(): boolean {
		// No durable provider state exists; a fresh provider reconnects cleanly.
		return false;
	}

	async start(): Promise<void> {
		await this.#options.provider.start(envelope => this.#onEnvelope(envelope));
		this.#started = true;
	}

	async stop(): Promise<void> {
		this.#started = false;
		await this.#options.provider.stop();
	}

	async notify(input: FeishuAppNotifyInput): Promise<void> {
		if (input.publicationId !== undefined) {
			const key = `${input.sessionId}:${input.publicationId}`;
			if (this.#delivered.has(key)) return;
			this.#rememberPublication(key);
		}
		this.#lastSessionId = input.sessionId;
		if (input.actionId !== undefined && Array.isArray(input.options) && input.options.length > 0) {
			await this.#sendAsk(input);
			return;
		}
		const result = await this.#options.provider.sendText(input.content);
		if (!result.ok) logger.warn(`Feishu app bot notify failed: ${result.detail}`);
	}

	async resolveAction(sessionId: string, actionId: string): Promise<void> {
		const pending = this.#pending.get(actionId);
		if (!pending || pending.sessionId !== sessionId) return;
		this.#pending.delete(actionId);
		if (pending.messageId === undefined) return;
		const result = await this.#options.provider.updateCard(pending.messageId, resolvedCard("已处理"));
		if (!result.ok) logger.warn(`Feishu app bot ask resolution failed: ${result.detail}`);
	}

	async postCommandResult(sessionId: string, content: string): Promise<void> {
		this.#lastSessionId = sessionId;
		const result = await this.#options.provider.sendText(content);
		if (!result.ok) logger.warn(`Feishu app bot command result failed: ${result.detail}`);
	}

	async resume(sessionId: string, content: string, generation: number, publicationId?: string): Promise<void> {
		await this.notify({ sessionId, endpointGeneration: generation, content, publicationId });
	}

	async close(sessionId: string, _generation: number): Promise<void> {
		for (const [actionId, pending] of [...this.#pending])
			if (pending.sessionId === sessionId) this.#pending.delete(actionId);
	}

	async retireAttachment(sessionId: string, _generation: number): Promise<void> {
		await this.close(sessionId, 0);
	}

	async recoverCleanup(_sessionId: string, _generation: number, _authorityId?: string): Promise<boolean> {
		// Nothing durable to recover; successor attachments are never blocked.
		return true;
	}

	async #sendAsk(input: FeishuAppNotifyInput): Promise<void> {
		const actionId = input.actionId;
		const options = input.options;
		if (actionId === undefined || options === undefined) return;
		const card = buildAskCard(input.sessionId, actionId, input.content, options);
		const result = await this.#options.provider.sendCard(card);
		if (!result.ok) {
			logger.warn(`Feishu app bot ask delivery failed: ${result.detail}`);
			return;
		}
		this.#rememberPending({ sessionId: input.sessionId, actionId, options, messageId: result.messageId });
	}

	#rememberPending(pending: PendingAction): void {
		while (this.#pending.size >= PENDING_ACTION_LIMIT) {
			const oldest = this.#pending.keys().next().value;
			if (oldest === undefined) break;
			this.#pending.delete(oldest);
		}
		this.#pending.set(pending.actionId, pending);
	}

	#rememberPublication(key: string): void {
		while (this.#delivered.size >= PUBLICATION_MEMORY_LIMIT) {
			const oldest = this.#delivered.values().next().value;
			if (oldest === undefined) break;
			this.#delivered.delete(oldest);
		}
		this.#delivered.add(key);
	}

	async #onEnvelope(envelope: FeishuAppInboundEnvelope): Promise<void> {
		if (!this.#started) return;
		if (!authorize(this.#options, envelope)) {
			logger.warn(
				`Feishu app bot ignored a ${envelope.kind} event from a non-whitelisted sender (${
					envelope.senderOpenId ?? "unknown"
				}).`,
			);
			return;
		}
		if (envelope.kind === "card_action") await this.#onCardAction(envelope);
		else await this.#onMessage(envelope);
	}

	async #onCardAction(envelope: FeishuAppInboundEnvelope): Promise<void> {
		const value = envelope.value;
		if (!value) return;
		const actionId = readString(value, "actionId");
		const sessionId = readString(value, "sessionId");
		if (!actionId || !sessionId) return;
		const pending = this.#pending.get(actionId);
		if (!pending || pending.sessionId !== sessionId) return;
		const index = readIndex(value, "answerIndex");
		const answer = index !== undefined ? pending.options[index] : undefined;
		if (answer === undefined) return;
		await this.#answerPending(pending, answer, envelope.messageId);
	}

	async #onMessage(envelope: FeishuAppInboundEnvelope): Promise<void> {
		const rawText = envelope.text;
		if (rawText === undefined) return;
		const text = stripLeadingMentionTokens(rawText).replace(/^／/, "/");
		const numbered = /^(\d+)$/.exec(text);
		if (numbered) {
			const pending = [...this.#pending.values()].at(-1);
			if (pending) {
				const answer = pending.options[Number(numbered[1]) - 1];
				if (answer !== undefined) {
					await this.#answerPending(pending, answer, envelope.messageId);
					return;
				}
			}
		}
		if (text.startsWith("/sdk")) {
			logger.info(`Feishu app bot dispatching a /sdk command from ${envelope.senderOpenId ?? "unknown"}.`);
			await this.#dispatchCommand(text);
			return;
		}
		// Free-form chat is a conversational surface like Telegram/Slack: route
		// the stripped text into the bound session as a durable turn.prompt.
		// The raw WS user_message injection is silently dropped by hosts whose
		// notification runtime is not wired to this endpoint (observed live:
		// frames accepted at TCP level, agent never sees them), while
		// turn.prompt is a control request with an explicit acceptance
		// receipt. A prompt submitted mid-run queues for the next idle
		// boundary instead of steering the live run. Without a bound session
		// nothing can receive it, so stay quiet — the /sdk no-session hint
		// already covers that state.
		const boundSessionId = this.#lastSessionId;
		if (!boundSessionId) {
			logger.info("Feishu app bot ignored a free-form message; no active session is bound to receive it.");
			return;
		}
		const boundAttachment = this.#options.resolveAttachment(boundSessionId);
		if (!boundAttachment) {
			logger.info("Feishu app bot ignored a free-form message; its session attachment is no longer current.");
			return;
		}
		if (text.length === 0) return;
		try {
			const accepted = await this.#options.onFreeForm(boundSessionId, text, boundAttachment, randomUUID());
			logger.info(`Feishu app bot routed a free-form message into session ${boundSessionId}.`);
			const ack = await this.#options.provider.sendText(
				accepted ? FREE_FORM_ACCEPTED_HINT : FREE_FORM_REJECTED_HINT,
			);
			if (!ack.ok) logger.warn(`Feishu app bot free-form ack failed: ${ack.detail}`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logger.warn(`Feishu app bot free-form dispatch failed: ${reason}`);
			const failure = await this.#options.provider.sendText(`会话消息提交失败：${reason}`);
			if (!failure.ok) logger.warn(`Feishu app bot free-form failure hint failed: ${failure.detail}`);
		}
	}

	async #answerPending(pending: PendingAction, answer: string, messageId: string | undefined): Promise<void> {
		this.#pending.delete(pending.actionId);
		const attachment = this.#options.resolveAttachment(pending.sessionId);
		if (!attachment) {
			logger.warn("Feishu app bot ignored an ask reply for a detached session.");
			return;
		}
		attachment.send({ type: "reply", id: pending.actionId, answer });
		const cardId = pending.messageId ?? messageId;
		if (cardId === undefined) return;
		const result = await this.#options.provider.updateCard(cardId, resolvedCard(answer));
		if (!result.ok) logger.warn(`Feishu app bot ask card update failed: ${result.detail}`);
	}

	async #dispatchCommand(content: string): Promise<void> {
		const sessionId = this.#lastSessionId;
		if (!sessionId) {
			const result = await this.#options.provider.sendText(NO_BOUND_SESSION_HINT);
			if (!result.ok) logger.warn(`Feishu app bot no-session hint failed: ${result.detail}`);
			return;
		}
		const attachment = this.#options.resolveAttachment(sessionId);
		if (!attachment) {
			const result = await this.#options.provider.sendText(DETACHED_SESSION_HINT);
			if (!result.ok) logger.warn(`Feishu app bot detached-session hint failed: ${result.detail}`);
			return;
		}
		try {
			await this.#options.onCommand(sessionId, content, attachment, randomUUID());
		} catch (error) {
			logger.warn(
				`Feishu app bot command dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
