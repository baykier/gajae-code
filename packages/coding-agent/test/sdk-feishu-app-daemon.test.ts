import { describe, expect, test } from "bun:test";
import { buildAskCard, FeishuAppNotificationDaemon, stripLeadingMentionTokens } from "../src/sdk/bus/feishu-app-daemon";
import {
	chunkFeishuAppText,
	describeMessageEventDrop,
	type FeishuAppDeliveryResult,
	type FeishuAppInboundEnvelope,
	FeishuAppLiveProvider,
	type FeishuAppProviderClient,
	parseCardActionEnvelope,
	parseMessageEnvelope,
} from "../src/sdk/bus/feishu-app-provider";
import { FEISHU_TEXT_CHUNK_CHARS } from "../src/sdk/bus/feishu-webhook";
import type { SessionAttachment } from "../src/sdk/router";

describe("feishu app provider text parsing", () => {
	test("chunkFeishuAppText keeps short text intact", () => {
		expect(chunkFeishuAppText("hello")).toEqual(["hello"]);
	});

	test("chunkFeishuAppText treats empty text as nothing to send", () => {
		expect(chunkFeishuAppText("")).toEqual([]);
	});

	test("chunkFeishuAppText splits long text at newline boundaries", () => {
		const half = "a".repeat(FEISHU_TEXT_CHUNK_CHARS - 1);
		const text = `${half}\n${"b".repeat(10)}`;
		// The first chunk stops before the newline; the remainder keeps it.
		expect(chunkFeishuAppText(text)).toEqual([half, `\n${"b".repeat(10)}`]);
	});

	test("chunkFeishuAppText hard-splits text without newlines", () => {
		const text = "x".repeat(FEISHU_TEXT_CHUNK_CHARS + 500);
		const chunks = chunkFeishuAppText(text);
		expect(chunks[0]).toHaveLength(FEISHU_TEXT_CHUNK_CHARS);
		expect(chunks.join("")).toBe(text);
	});
});

describe("feishu app provider envelope parsing", () => {
	const chatId = "oc_bound";

	test("parseMessageEnvelope accepts a bound user text message", () => {
		expect(
			parseMessageEnvelope(
				{
					sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
					message: {
						chat_id: chatId,
						content: { text: "/sdk query todo.list {}" },
						message_id: "om_1",
						message_type: "text",
					},
				},
				chatId,
			),
		).toEqual({
			kind: "message",
			senderOpenId: "ou_alice",
			text: "/sdk query todo.list {}",
			value: undefined,
			messageId: "om_1",
		});
	});

	test("parseMessageEnvelope decodes Feishu's JSON-string content (wire format)", () => {
		expect(
			parseMessageEnvelope(
				{
					sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
					message: {
						chat_id: chatId,
						content: JSON.stringify({ text: "@_user_1 /sdk help" }),
						message_id: "om_wire",
						message_type: "text",
					},
				},
				chatId,
			),
		).toEqual({
			kind: "message",
			senderOpenId: "ou_alice",
			text: "@_user_1 /sdk help",
			value: undefined,
			messageId: "om_wire",
		});
		// Malformed or empty content is still dropped, never accepted as text.
		const malformed = {
			sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
			message: { chat_id: chatId, content: "{not json", message_type: "text" },
		};
		expect(parseMessageEnvelope(malformed, chatId)).toBeUndefined();
		const empty = {
			sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
			message: { chat_id: chatId, content: JSON.stringify({ text: "" }), message_type: "text" },
		};
		expect(parseMessageEnvelope(empty, chatId)).toBeUndefined();
	});

	test("parseMessageEnvelope drops messages from other chats", () => {
		expect(
			parseMessageEnvelope(
				{
					sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
					message: { chat_id: "oc_other", content: { text: "hi" }, message_type: "text" },
				},
				chatId,
			),
		).toBeUndefined();
	});

	test("parseMessageEnvelope drops bot echoes and non-text messages", () => {
		const base = { chat_id: chatId, content: { text: "echo" }, message_type: "text" };
		expect(
			parseMessageEnvelope(
				{ sender: { sender_id: { open_id: "ou_bot" }, sender_type: "app" }, message: base },
				chatId,
			),
		).toBeUndefined();
		expect(
			parseMessageEnvelope(
				{
					sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
					message: { ...base, message_type: "image" },
				},
				chatId,
			),
		).toBeUndefined();
		expect(
			parseMessageEnvelope(
				{ sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" }, message: { ...base, content: {} } },
				chatId,
			),
		).toBeUndefined();
	});

	test("parseCardActionEnvelope reads root identity and falls back to context", () => {
		const value = { actionId: "action-1", answerIndex: 1, sessionId: "session" };
		expect(
			parseCardActionEnvelope({
				action: { value },
				open_id: "ou_alice",
				open_message_id: "om_card",
				operator: { open_id: "ou_operator" },
			}),
		).toEqual({ kind: "card_action", senderOpenId: "ou_alice", text: undefined, value, messageId: "om_card" });
		expect(
			parseCardActionEnvelope({ action: { value }, context: { open_id: "ou_ctx", open_message_id: "om_ctx" } }),
		).toEqual({
			kind: "card_action",
			senderOpenId: "ou_ctx",
			text: undefined,
			value,
			messageId: "om_ctx",
		});
		expect(parseCardActionEnvelope({ action: {} })).toBeUndefined();
		expect(parseCardActionEnvelope({})).toBeUndefined();
	});
});

class FakeFeishuAppProvider implements FeishuAppProviderClient {
	texts: string[] = [];
	cards: Record<string, unknown>[] = [];
	updates: Array<{ card: Record<string, unknown>; messageId: string }> = [];
	handler: ((envelope: FeishuAppInboundEnvelope) => void | Promise<void>) | undefined;
	transportHealthy: boolean | undefined = true;
	/** Next create-result messageId; undefined keeps the card receipt message-less. */
	nextMessageId: string | undefined = "om_card";
	sendFailure: FeishuAppDeliveryResult | undefined;

	async start(onEnvelope: (envelope: FeishuAppInboundEnvelope) => void | Promise<void>): Promise<void> {
		this.handler = onEnvelope;
	}

	async stop(): Promise<void> {
		this.handler = undefined;
	}

	async sendText(text: string): Promise<FeishuAppDeliveryResult> {
		if (this.sendFailure) return this.sendFailure;
		this.texts.push(text);
		return { ok: true, messageId: undefined };
	}

	async sendCard(card: Record<string, unknown>): Promise<FeishuAppDeliveryResult> {
		this.cards.push(card);
		return { ok: true, messageId: this.nextMessageId };
	}

	async updateCard(messageId: string, card: Record<string, unknown>): Promise<FeishuAppDeliveryResult> {
		this.updates.push({ card, messageId });
		return { ok: true, messageId: undefined };
	}

	emit(envelope: FeishuAppInboundEnvelope): Promise<void> {
		return this.handler?.(envelope) ?? Promise.resolve();
	}
}

interface RecordedReply {
	answer: string;
	id: string;
	type: string;
}

function recordingAttachment(replies: RecordedReply[]): SessionAttachment {
	const fake = {
		send(input: RecordedReply): void {
			replies.push(input);
		},
	};
	return fake as unknown as SessionAttachment;
}

function makeDaemon(provider: FakeFeishuAppProvider, attachments: Map<string, SessionAttachment>) {
	const onCommandCalls: Array<{ content: string; idempotencyKey: string; sessionId: string }> = [];
	const onFreeFormCalls: Array<{ content: string; idempotencyKey: string; sessionId: string }> = [];
	const daemon = new FeishuAppNotificationDaemon({
		provider,
		authorizedOpenIds: new Set(["ou_alice"]),
		resolveAttachment: sessionId => attachments.get(sessionId) ?? null,
		onCommand: async (sessionId, content, _attachment, idempotencyKey) => {
			onCommandCalls.push({ content, idempotencyKey, sessionId });
			return true;
		},
		onFreeForm: async (sessionId, content, _attachment, idempotencyKey) => {
			onFreeFormCalls.push({ content, idempotencyKey, sessionId });
			return true;
		},
	});
	return { daemon, onCommandCalls, onFreeFormCalls };
}

function messageEnvelope(text: string, senderOpenId = "ou_alice"): FeishuAppInboundEnvelope {
	return { kind: "message", senderOpenId, text, value: undefined, messageId: `om_${text}` };
}

function cardAction(value: Record<string, unknown>): FeishuAppInboundEnvelope {
	return { kind: "card_action", senderOpenId: "ou_alice", text: undefined, value, messageId: "om_click" };
}

describe("feishu app daemon ask cards", () => {
	test("cards carry routing identity and bounded question/options", () => {
		const card = buildAskCard("session", "action-1", "q".repeat(1_500), ["o".repeat(300), "second"]);
		expect(card.config).toEqual({ enable_forward: false });
		const elements = card.elements as Array<Record<string, unknown>>;
		const questionJson = JSON.stringify(elements[0]);
		expect(questionJson.length).toBeLessThan(1_500);
		const actions = elements[1] as { actions: Array<{ text: { content: string }; value: Record<string, unknown> }> };
		expect(actions.actions).toHaveLength(2);
		expect(actions.actions[0].value).toEqual({ actionId: "action-1", answerIndex: 0, sessionId: "session" });
		expect(actions.actions[0].text.content.startsWith("1. ")).toBe(true);
		expect(actions.actions[0].text.content.length).toBeLessThan(200);
		expect(actions.actions[1].value.answerIndex).toBe(1);
		expect(buildAskCard("session", "action-2", "pick", []).elements).toHaveLength(1);
	});
});

describe("feishu app daemon outbound", () => {
	test("notify sends text and dedupes by sessionId+publicationId", async () => {
		const provider = new FakeFeishuAppProvider();
		const { daemon } = makeDaemon(provider, new Map());
		await daemon.notify({ content: "hello", endpointGeneration: 1, publicationId: "p1", sessionId: "s1" });
		await daemon.notify({ content: "hello", endpointGeneration: 1, publicationId: "p1", sessionId: "s1" });
		await daemon.notify({ content: "again", endpointGeneration: 1, publicationId: "p2", sessionId: "s1" });
		expect(provider.texts).toEqual(["hello", "again"]);
	});

	test("ask notify sends one card per ask and delivery failures are absorbed", async () => {
		const provider = new FakeFeishuAppProvider();
		const { daemon } = makeDaemon(provider, new Map());
		provider.sendFailure = { detail: "rejected by Feishu (code 230001).", ok: false, uncertain: false };
		await daemon.notify({ content: "hello", endpointGeneration: 1, sessionId: "s1" });
		provider.sendFailure = undefined;
		await daemon.notify({
			actionId: "ask-1",
			content: "pick",
			endpointGeneration: 1,
			options: ["alpha", "beta"],
			sessionId: "s1",
		});
		expect(provider.texts).toEqual([]);
		expect(provider.cards).toHaveLength(1);
		await daemon.stop();
	});

	test("resolveAction updates the card once and ignores unknown ids", async () => {
		const provider = new FakeFeishuAppProvider();
		const { daemon } = makeDaemon(provider, new Map());
		await daemon.notify({
			actionId: "ask-1",
			content: "pick",
			endpointGeneration: 1,
			options: ["alpha"],
			sessionId: "s1",
		});
		await daemon.resolveAction("s1", "missing");
		expect(provider.updates).toEqual([]);
		await daemon.resolveAction("s1", "ask-1");
		expect(provider.updates).toHaveLength(1);
		await daemon.resolveAction("s1", "ask-1");
		expect(provider.updates).toHaveLength(1);
	});

	test("resume reposts through notify dedupe and postCommandResult always sends", async () => {
		const provider = new FakeFeishuAppProvider();
		const { daemon } = makeDaemon(provider, new Map());
		await daemon.resume("s1", "body", 1, "pub-1");
		await daemon.resume("s1", "body", 1, "pub-1");
		await daemon.postCommandResult("s1", "result");
		expect(provider.texts).toEqual(["body", "result"]);
	});
});

describe("feishu app daemon inbound", () => {
	test("numbered replies answer the newest pending ask and resolve its card", async () => {
		const provider = new FakeFeishuAppProvider();
		const replies: RecordedReply[] = [];
		const { daemon } = makeDaemon(provider, new Map([["s1", recordingAttachment(replies)]]));
		await daemon.start();
		await daemon.notify({
			actionId: "ask-1",
			content: "pick",
			endpointGeneration: 1,
			options: ["alpha", "beta"],
			sessionId: "s1",
		});
		await provider.emit(messageEnvelope("2"));
		expect(replies).toEqual([{ answer: "beta", id: "ask-1", type: "reply" }]);
		expect(provider.updates).toHaveLength(1);
		expect(JSON.stringify(provider.updates[0].card)).toContain("beta");
		await daemon.stop();
	});

	test("unauthorized senders and detached sessions are dropped", async () => {
		const provider = new FakeFeishuAppProvider();
		const replies: RecordedReply[] = [];
		const { daemon } = makeDaemon(provider, new Map([["s1", recordingAttachment(replies)]]));
		await daemon.start();
		await daemon.notify({
			actionId: "ask-1",
			content: "pick",
			endpointGeneration: 1,
			options: ["alpha"],
			sessionId: "s1",
		});
		await provider.emit(messageEnvelope("1", "ou_stranger"));
		expect(replies).toEqual([]);
		await daemon.stop();

		const detachedProvider = new FakeFeishuAppProvider();
		const detachedReplies: RecordedReply[] = [];
		const detached = makeDaemon(detachedProvider, new Map()).daemon;
		await detached.start();
		await detached.notify({
			actionId: "ask-2",
			content: "pick",
			endpointGeneration: 1,
			options: ["alpha"],
			sessionId: "s1",
		});
		await detachedProvider.emit(messageEnvelope("1"));
		expect(detachedReplies).toEqual([]);
		await detached.stop();
	});

	test("card actions resolve by actionId and sessionId; bad indices are ignored", async () => {
		const provider = new FakeFeishuAppProvider();
		const replies: RecordedReply[] = [];
		const { daemon } = makeDaemon(provider, new Map([["s1", recordingAttachment(replies)]]));
		await daemon.start();
		await daemon.notify({
			actionId: "ask-1",
			content: "pick",
			endpointGeneration: 1,
			options: ["alpha", "beta"],
			sessionId: "s1",
		});
		await provider.emit(cardAction({ actionId: "ask-1", answerIndex: 9, sessionId: "s1" }));
		expect(replies).toEqual([]);
		await provider.emit(cardAction({ actionId: "ask-1", answerIndex: 1, sessionId: "s2" }));
		expect(replies).toEqual([]);
		await provider.emit(cardAction({ actionId: "ask-1", answerIndex: 1, sessionId: "s1" }));
		expect(replies).toEqual([{ answer: "beta", id: "ask-1", type: "reply" }]);
		await daemon.stop();
	});

	test("close drops only that session's pendings; the rest stay answerable", async () => {
		const provider = new FakeFeishuAppProvider();
		const replies: RecordedReply[] = [];
		const attachments = new Map([
			["s1", recordingAttachment(replies)],
			["s2", recordingAttachment(replies)],
		]);
		const { daemon } = makeDaemon(provider, attachments);
		await daemon.start();
		await daemon.notify({
			actionId: "ask-1",
			content: "q1",
			endpointGeneration: 1,
			options: ["a1"],
			sessionId: "s1",
		});
		await daemon.notify({
			actionId: "ask-2",
			content: "q2",
			endpointGeneration: 1,
			options: ["b1", "b2"],
			sessionId: "s2",
		});
		await daemon.close("s1", 1);
		// ask-1 is gone; the newest pending is ask-2, so "2" answers beta.
		await provider.emit(messageEnvelope("2"));
		expect(replies).toEqual([{ answer: "b2", id: "ask-2", type: "reply" }]);
		await daemon.stop();
	});

	test("/sdk commands dispatch to the most recent delivered session with a fresh idempotency key", async () => {
		const provider = new FakeFeishuAppProvider();
		const attachments = new Map([["s1", recordingAttachment([])]]);
		const { daemon, onCommandCalls } = makeDaemon(provider, attachments);
		await daemon.start();
		// No delivery yet: /sdk has no session to bind to.
		await provider.emit(messageEnvelope("/sdk query todo.list {}"));
		expect(onCommandCalls).toEqual([]);
		// Unbound /sdk commands answer with the no-session hint instead of silence.
		expect(provider.texts).toHaveLength(1);
		expect(provider.texts[0]).toContain("暂无绑定");
		await daemon.notify({ content: "attached", endpointGeneration: 1, sessionId: "s1" });
		await provider.emit(messageEnvelope("/sdk query todo.list {}"));
		expect(onCommandCalls).toHaveLength(1);
		expect(onCommandCalls[0]).toMatchObject({ content: "/sdk query todo.list {}", sessionId: "s1" });
		expect(onCommandCalls[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
		// Command failures never escape the dispatch loop.
		const failing = new FeishuAppNotificationDaemon({
			provider,
			authorizedOpenIds: new Set(["ou_alice"]),
			resolveAttachment: () => attachments.get("s1") ?? null,
			onCommand: async () => {
				throw new Error("dispatch exploded");
			},
			onFreeForm: async () => true,
		});
		await failing.start();
		await failing.notify({ content: "attached", endpointGeneration: 1, sessionId: "s1" });
		await provider.emit(messageEnvelope("/sdk query todo.list {}"));
		await failing.stop();
		await daemon.stop();
	});

	test("envelopes before start are ignored; recoverCleanup and transport observation stay passive", async () => {
		const provider = new FakeFeishuAppProvider();
		const { daemon } = makeDaemon(provider, new Map());
		expect(daemon.transportHealthy()).toBe(true);
		provider.transportHealthy = false;
		expect(daemon.transportHealthy()).toBe(false);
		provider.transportHealthy = undefined;
		expect(daemon.transportHealthy()).toBe(true);
		expect(daemon.restartBlocked()).toBe(false);
		expect(await daemon.recoverCleanup("s1", 1, "authority")).toBe(true);
		// Not started: the provider has no handler yet.
		expect(provider.handler).toBeUndefined();
		await daemon.start();
		expect(provider.handler).toBeDefined();
		await daemon.stop();
		expect(provider.handler).toBeUndefined();
	});
});

describe("feishu app live provider construction", () => {
	test("transport starts unhealthy and no socket opens until start()", () => {
		const provider = new FeishuAppLiveProvider({ appId: "cli_a", appSecret: "s", chatId: "oc_x" });
		expect(provider.transportHealthy).toBe(false);
		expect(FEISHU_TEXT_CHUNK_CHARS).toBe(3_800);
	});
});

describe("feishu app daemon mention handling", () => {
	test("stripLeadingMentionTokens removes only leading @_user_N placeholders", () => {
		expect(stripLeadingMentionTokens("@_user_1 /sdk help")).toBe("/sdk help");
		expect(stripLeadingMentionTokens("@_user_1 @_user_2 hi")).toBe("hi");
		expect(stripLeadingMentionTokens("  @_user_1 3 ")).toBe("3");
		expect(stripLeadingMentionTokens("/sdk help")).toBe("/sdk help");
		expect(stripLeadingMentionTokens("mid @_user_1 mention")).toBe("mid @_user_1 mention");
	});

	test("describeMessageEventDrop names the failing filter without message content", () => {
		const boundText = {
			message: { chat_id: "oc_bound", content: { text: "hi" }, message_type: "text" },
			sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
		};
		expect(describeMessageEventDrop(boundText, "oc_bound")).toContain("bound chat");
		const otherChat = structuredClone(boundText);
		(otherChat.message as Record<string, unknown>).chat_id = "oc_other";
		expect(describeMessageEventDrop(otherChat, "oc_bound")).toContain("unbound chat");
		const nonText = structuredClone(boundText);
		(nonText.message as Record<string, unknown>).message_type = "image";
		expect(describeMessageEventDrop(nonText, "oc_bound")).toContain("message_type=image");
		const appSender = structuredClone(boundText);
		(appSender.sender as Record<string, unknown>).sender_type = "app";
		expect(describeMessageEventDrop(appSender, "oc_bound")).toContain("sender_type=app");
		expect(describeMessageEventDrop({}, "oc_bound")).toBe("no message object");
	});

	test("@-prefixed /sdk commands dispatch with stripped text", async () => {
		const provider = new FakeFeishuAppProvider();
		const attachments = new Map([["s1", recordingAttachment([])]]);
		const { daemon, onCommandCalls } = makeDaemon(provider, attachments);
		await daemon.start();
		await daemon.notify({ content: "attached", endpointGeneration: 1, sessionId: "s1" });
		await provider.emit(messageEnvelope("@_user_1 /sdk query todo.list {}"));
		expect(onCommandCalls).toHaveLength(1);
		expect(onCommandCalls[0]).toMatchObject({ content: "/sdk query todo.list {}", sessionId: "s1" });
		await daemon.stop();
	});

	test("@-prefixed numbered replies answer the newest pending ask", async () => {
		const provider = new FakeFeishuAppProvider();
		const replies: RecordedReply[] = [];
		const { daemon } = makeDaemon(provider, new Map([["s1", recordingAttachment(replies)]]));
		await daemon.start();
		await daemon.notify({
			actionId: "ask-1",
			content: "pick",
			endpointGeneration: 1,
			options: ["alpha", "beta"],
			sessionId: "s1",
		});
		await provider.emit(messageEnvelope("@_user_1 2"));
		expect(replies).toEqual([{ answer: "beta", id: "ask-1", type: "reply" }]);
		await daemon.stop();
	});

	test("a fullwidth ／ command slash routes like /sdk", async () => {
		const provider = new FakeFeishuAppProvider();
		const attachments = new Map([["s1", recordingAttachment([])]]);
		const { daemon, onCommandCalls } = makeDaemon(provider, attachments);
		await daemon.start();
		await daemon.notify({ content: "attached", endpointGeneration: 1, sessionId: "s1" });
		await provider.emit(messageEnvelope("@_user_1 ／sdk help"));
		expect(onCommandCalls).toHaveLength(1);
		expect(onCommandCalls[0]).toMatchObject({ content: "/sdk help", sessionId: "s1" });
		await daemon.stop();
	});
	test("free-form chat dispatches a durable turn.prompt through onFreeForm and acks acceptance", async () => {
		const provider = new FakeFeishuAppProvider();
		const attachment = {
			isCurrent(): boolean {
				return true;
			},
		} as unknown as SessionAttachment;
		const { daemon, onFreeFormCalls } = makeDaemon(provider, new Map([["s1", attachment]]));
		await daemon.start();
		await daemon.notify({ content: "attached", endpointGeneration: 1, sessionId: "s1" });
		await provider.emit(messageEnvelope("@_user_1 今天天气如何"));
		expect(onFreeFormCalls).toHaveLength(1);
		expect(onFreeFormCalls[0]).toMatchObject({ content: "今天天气如何", sessionId: "s1" });
		expect(onFreeFormCalls[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
		expect(provider.texts).toContain("已提交到会话。");
		await daemon.stop();
	});

	test("free-form chat reports a submission failure through the onFreeForm receipt", async () => {
		const provider = new FakeFeishuAppProvider();
		const attachment = {
			isCurrent(): boolean {
				return true;
			},
		} as unknown as SessionAttachment;
		const daemon = new FeishuAppNotificationDaemon({
			provider,
			authorizedOpenIds: new Set(["ou_alice"]),
			resolveAttachment: () => attachment,
			onCommand: async () => true,
			onFreeForm: async () => false,
		});
		await daemon.start();
		await daemon.notify({ content: "attached", endpointGeneration: 1, sessionId: "s1" });
		await provider.emit(messageEnvelope("今天天气如何"));
		expect(provider.texts).toContain("会话未接受该消息（队列可能已满），请稍后重试。");
		await daemon.stop();
	});

	test("free-form chat stays silent when no active session is bound", async () => {
		const provider = new FakeFeishuAppProvider();
		const { daemon } = makeDaemon(provider, new Map());
		await daemon.start();
		await provider.emit(messageEnvelope("今天天气如何"));
		expect(provider.texts).toEqual([]);
		await daemon.stop();
	});
});
