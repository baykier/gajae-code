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
	/** Injectable clock for status-card throttling; defaults to wall time. */
	now?: () => number;
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

/** Feishu rate-limits card patches; live status redraws coalesce to at most one update per window. */
const STATUS_CARD_UPDATE_MIN_MS = 3_000;
/** Hard ceiling for one ephemeral status card; sessions without a finalized answer frame cannot linger forever. */
const STATUS_CARD_MAX_AGE_MS = 10 * 60_000;
/** A tool start after this much silence begins a fresh visual turn on the same card. */
const STATUS_CARD_IDLE_RESET_MS = 60_000;
const STATUS_CARD_TEXT_PREVIEW_CHARS = 280;
const STATUS_CARD_LIMIT = 16;

export interface FeishuAppStatusFrameInput {
	sessionId: string;
	endpointGeneration: number;
	/** One additive session frame: `tool_activity`, `turn_stream`, or `context_update`. */
	frame: Record<string, unknown>;
}

/**
 * Live state behind one session's ephemeral status card. The card is created on
 * the first status frame, redrawn in place at most once per update window, and
 * deleted when the turn settles (final-answer frame or session close).
 */
interface StatusCardState {
	readonly sessionId: string;
	messageId: string | undefined;
	/** When the card message was born; bounds its total lifetime (max age). */
	createdAt: number;
	startedAt: number;
	lastActivityAt: number;
	lastUpdateAt: number;
	toolName: string | undefined;
	toolOutcome: string | undefined;
	toolAt: number | undefined;
	text: string | undefined;
	model: string | undefined;
	tokenUsage: string | undefined;
	dirty: boolean;
	settled: boolean;
	/** Serializes provider mutations so card patches can never land out of order. */
	chain: Promise<void>;
}

export function formatStatusDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function statusCardLines(state: StatusCardState, now: number): string {
	const lines: string[] = [];
	if (state.toolName !== undefined) {
		const mark =
			state.toolOutcome === undefined || state.toolOutcome === "started"
				? ""
				: state.toolOutcome === "completed"
					? "✓ "
					: "✗ ";
		const elapsed = state.toolAt !== undefined ? ` · ${formatStatusDuration(now - state.toolAt)}` : "";
		lines.push(`工具 ${mark}\`${state.toolName}\`${elapsed}`);
	}
	if (state.text !== undefined) {
		const preview = state.text
			.replace(/[ \t]+\n/g, "\n")
			.trim()
			.slice(0, STATUS_CARD_TEXT_PREVIEW_CHARS);
		if (preview.length > 0) lines.push(preview);
	}
	const meta = [state.model, state.tokenUsage].filter((entry): entry is string => entry !== undefined).join(" · ");
	if (meta.length > 0) lines.push(meta);
	lines.push(`已运行 ${formatStatusDuration(now - state.startedAt)}`);
	return lines.join("\n");
}

/** The in-progress card: a compact terminal mirror of the live session state. */
export function buildStatusCard(state: StatusCardState, now: number): Record<string, unknown> {
	return {
		config: { enable_forward: false },
		header: { title: { tag: "plain_text", content: "GJC 运行中" }, template: "blue" },
		elements: [{ tag: "div", text: { tag: "lark_md", content: statusCardLines(state, now) } }],
	};
}

/** Fallback card when the ephemeral card cannot be deleted (e.g. outside Feishu's edit window). */
export function settledStatusCard(elapsed: string): Record<string, unknown> {
	return {
		config: { enable_forward: false },
		header: { title: { tag: "plain_text", content: "GJC 回合已结束" }, template: "grey" },
		elements: [{ tag: "div", text: { tag: "lark_md", content: `已完成 · 耗时 ${elapsed}` } }],
	};
}

export class FeishuAppNotificationDaemon {
	readonly #options: FeishuAppDaemonOptions;
	readonly #pending = new Map<string, PendingAction>();
	readonly #delivered = new Set<string>();
	readonly #statusCards = new Map<string, StatusCardState>();
	readonly #now: () => number;
	/** Most recent session that produced a delivery; routes free-form `/sdk` commands. */
	#lastSessionId: string | undefined;
	#started = false;

	constructor(options: FeishuAppDaemonOptions) {
		this.#options = options;
		this.#now = options.now ?? (() => Date.now());
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
	/**
	 * Consume one live session frame into the session's ephemeral status card.
	 * The card is created on the first frame, redrawn in place at most once per
	 * update window (Feishu rate-limits card patches), and deleted when the turn
	 * settles. Every consumed frame marks the card dirty; frames inside the
	 * update window coalesce into the next applied redraw.
	 */
	async statusFrame(input: FeishuAppStatusFrameInput): Promise<void> {
		const frame = input.frame;
		const now = this.#now();
		const state = this.#statusCardState(input.sessionId, now);
		if (frame.type === "turn_stream") {
			if (frame.phase === "finalized") {
				// A pre-ask lead-in also finalizes (finalAnswer:false) but the turn
				// keeps running past it; only the final answer settles the card.
				if (frame.finalAnswer !== true) return;
				await this.#settleStatusCard(state, now);
				return;
			}
			if (frame.phase !== "live") return;
			if (typeof frame.text !== "string" || frame.text.length === 0) return;
			state.text = frame.text;
		} else if (frame.type === "tool_activity") {
			const toolName = readString(frame, "toolName");
			if (toolName === undefined) return;
			const phase = readString(frame, "phase") ?? "started";
			if (phase === "started" && now - state.lastActivityAt > STATUS_CARD_IDLE_RESET_MS) {
				// A tool start after a long silence begins a fresh visual turn:
				// the previous turn may have ended without a finalized answer.
				state.startedAt = now;
				state.text = undefined;
			}
			state.toolName = toolName;
			state.toolOutcome = phase;
			state.toolAt = phase === "started" ? now : (state.toolAt ?? now);
		} else if (frame.type === "context_update") {
			if (typeof frame.model !== "string" && typeof frame.tokenUsage !== "string") return;
			if (typeof frame.model === "string") state.model = frame.model;
			if (typeof frame.tokenUsage === "string") state.tokenUsage = frame.tokenUsage;
		} else {
			return;
		}
		state.lastActivityAt = now;
		state.dirty = true;
		await this.#flushStatusCard(state, now);
	}

	#statusCardState(sessionId: string, now: number): StatusCardState {
		const existing = this.#statusCards.get(sessionId);
		if (existing) return existing;
		const state: StatusCardState = {
			sessionId,
			messageId: undefined,
			createdAt: now,
			startedAt: now,
			lastActivityAt: now,
			lastUpdateAt: 0,
			toolName: undefined,
			toolOutcome: undefined,
			toolAt: undefined,
			text: undefined,
			model: undefined,
			tokenUsage: undefined,
			dirty: false,
			settled: false,
			chain: Promise.resolve(),
		};
		while (this.#statusCards.size >= STATUS_CARD_LIMIT) {
			const oldest = this.#statusCards.keys().next().value;
			if (oldest === undefined) break;
			this.#statusCards.delete(oldest);
		}
		this.#statusCards.set(sessionId, state);
		return state;
	}

	async #flushStatusCard(state: StatusCardState, now: number): Promise<void> {
		if (state.settled) return;
		if (now - state.createdAt > STATUS_CARD_MAX_AGE_MS) {
			await this.#settleStatusCard(state, now);
			return;
		}
		if (!state.dirty) return;
		if (state.messageId === undefined) {
			// First appearance is never throttled: the card must show up fast.
			state.dirty = false;
			state.lastUpdateAt = now;
			const card = buildStatusCard(state, now);
			state.chain = state.chain
				.then(async () => {
					const result = await this.#options.provider.sendCard(card);
					if (result.ok) state.messageId = result.messageId ?? state.messageId;
					else logger.warn(`Feishu app bot status card send failed: ${result.detail}`);
				})
				.catch(() => undefined);
			await state.chain;
			return;
		}
		if (now - state.lastUpdateAt < STATUS_CARD_UPDATE_MIN_MS) return; // dirty stays set; next frame redraws
		state.dirty = false;
		state.lastUpdateAt = now;
		const messageId = state.messageId;
		const card = buildStatusCard(state, now);
		state.chain = state.chain
			.then(async () => {
				const result = await this.#options.provider.updateCard(messageId, card);
				if (!result.ok) logger.warn(`Feishu app bot status card update failed: ${result.detail}`);
			})
			.catch(() => undefined);
		await state.chain;
	}

	async #settleStatusCard(state: StatusCardState, now: number): Promise<void> {
		if (state.settled) return;
		state.settled = true;
		this.#statusCards.delete(state.sessionId);
		const messageId = state.messageId;
		if (messageId === undefined) return;
		const elapsed = formatStatusDuration(now - state.startedAt);
		state.chain = state.chain
			.then(async () => {
				// The finalized answer arrives as its own message, so the card is
				// transient by design; if Feishu refuses the delete (edit window),
				// mute it to a settled state instead of leaving a stale spinner.
				const deleted = await this.#options.provider.deleteMessage(messageId);
				if (deleted.ok) return;
				logger.warn(`Feishu app bot status card removal failed: ${deleted.detail}`);
				const fallback = await this.#options.provider.updateCard(messageId, settledStatusCard(elapsed));
				if (!fallback.ok) logger.warn(`Feishu app bot status card settle failed: ${fallback.detail}`);
			})
			.catch(() => undefined);
		await state.chain;
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
		const statusCard = this.#statusCards.get(sessionId);
		if (statusCard) await this.#settleStatusCard(statusCard, this.#now());
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
		// Free-form chat is the instant-reply lane: route the stripped text
		// into the bound session as turn.steer. The raw WS user_message
		// injection is silently dropped by hosts whose notification runtime is
		// not wired to this endpoint (observed live: frames accepted at TCP
		// level, agent never sees them), while turn.steer is a control request
		// with an explicit acceptance verdict. Mid-run the host admits the
		// text into the live loop immediately; idle it becomes a follow-up
		// owned by the next turn. Without a bound session nothing can receive
		// it, so stay quiet — the /sdk no-session hint already covers that
		// state.
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
