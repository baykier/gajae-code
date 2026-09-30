import { describe, expect, test } from "bun:test";
import {
	buildStatusCard,
	FeishuAppNotificationDaemon,
	type FeishuAppStatusFrameInput,
	formatStatusDuration,
	settledStatusCard,
} from "../src/sdk/bus/feishu-app-daemon";
import type {
	FeishuAppDeliveryResult,
	FeishuAppInboundEnvelope,
	FeishuAppProviderClient,
} from "../src/sdk/bus/feishu-app-provider";

class RecordingProvider implements FeishuAppProviderClient {
	sentCards: Record<string, unknown>[] = [];
	updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
	deletions: string[] = [];
	/** messageIds handed out by sendCard, in order. */
	sentMessageIds: string[] = [];
	/** When set, sendCard resolves with this failure instead of recording. */
	sendFailure: FeishuAppDeliveryResult | undefined;
	deleteFailure: FeishuAppDeliveryResult | undefined;

	async start(onEnvelope: (envelope: FeishuAppInboundEnvelope) => void | Promise<void>): Promise<void> {
		void onEnvelope;
	}

	async stop(): Promise<void> {}

	async sendText(): Promise<FeishuAppDeliveryResult> {
		return { ok: true, messageId: undefined };
	}

	async sendCard(card: Record<string, unknown>): Promise<FeishuAppDeliveryResult> {
		if (this.sendFailure) return this.sendFailure;
		const messageId = `om_status_${this.sentCards.length + 1}`;
		this.sentCards.push(card);
		this.sentMessageIds.push(messageId);
		return { ok: true, messageId };
	}

	async updateCard(messageId: string, card: Record<string, unknown>): Promise<FeishuAppDeliveryResult> {
		this.updates.push({ messageId, card });
		return { ok: true, messageId: undefined };
	}

	async deleteMessage(messageId: string): Promise<FeishuAppDeliveryResult> {
		if (this.deleteFailure) return this.deleteFailure;
		this.deletions.push(messageId);
		return { ok: true, messageId: undefined };
	}
}

const SESSION_ID = "feishu-status-session";

function cardHeader(card: Record<string, unknown>): string {
	const header = card.header as { title?: { content?: string } } | undefined;
	return header?.title?.content ?? "";
}

function cardBody(card: Record<string, unknown>): string {
	const elements = card.elements as Array<{ text?: { content?: string } }> | undefined;
	return elements?.[0]?.text?.content ?? "";
}

function statusFrame(frame: Record<string, unknown>): FeishuAppStatusFrameInput {
	return { sessionId: SESSION_ID, endpointGeneration: 1, frame };
}

function toolStarted(toolName: string): Record<string, unknown> {
	return { type: "tool_activity", toolName, phase: "started" };
}

function toolFinished(toolName: string, phase: string): Record<string, unknown> {
	return { type: "tool_activity", toolName, phase };
}

interface Harness {
	daemon: FeishuAppNotificationDaemon;
	provider: RecordingProvider;
	tick: (ms: number) => void;
}

function makeHarness(): Harness {
	const provider = new RecordingProvider();
	let now = 1_000;
	const daemon = new FeishuAppNotificationDaemon({
		provider,
		authorizedOpenIds: new Set(["ou_alice"]),
		resolveAttachment: () => null,
		onCommand: async () => true,
		onFreeForm: async () => true,
		now: () => now,
	});
	return {
		daemon,
		provider,
		tick: ms => {
			now += ms;
		},
	};
}
describe("feishu-app daemon status cards", () => {
	test("first status frame creates the card immediately", async () => {
		const { daemon, provider } = makeHarness();
		await daemon.statusFrame(statusFrame(toolStarted("bash")));
		expect(provider.sentCards).toHaveLength(1);
		expect(cardHeader(provider.sentCards[0])).toBe("GJC 运行中");
		expect(cardBody(provider.sentCards[0])).toContain("`bash`");
		expect(provider.updates).toHaveLength(0);
		expect(provider.deletions).toHaveLength(0);
	});

	test("frames inside the update window coalesce into the next applied redraw", async () => {
		const { daemon, provider, tick } = makeHarness();
		await daemon.statusFrame(statusFrame(toolStarted("bash")));
		expect(provider.sentCards).toHaveLength(1);
		// Within the 3s window: recorded as dirty, no provider call.
		tick(2_000);
		await daemon.statusFrame(statusFrame(toolStarted("read")));
		expect(provider.updates).toHaveLength(0);
		// Past the window: one redraw carrying the latest state.
		tick(1_500);
		await daemon.statusFrame(statusFrame(toolStarted("read")));
		expect(provider.updates).toHaveLength(1);
		expect(cardBody(provider.updates[0].card)).toContain("`read`");
		expect(provider.updates[0].messageId).toBe("om_status_1");
	});

	test("terminal tool outcome marks the tool and keeps its duration", async () => {
		const { daemon, provider, tick } = makeHarness();
		await daemon.statusFrame(statusFrame(toolStarted("bash")));
		tick(4_000);
		await daemon.statusFrame(statusFrame(toolFinished("bash", "completed")));
		expect(provider.updates).toHaveLength(1);
		expect(cardBody(provider.updates[0].card)).toContain("✓ `bash`");
		expect(cardBody(provider.updates[0].card)).toContain("4s");
		tick(4_000);
		await daemon.statusFrame(statusFrame(toolFinished("edit", "failed")));
		expect(provider.updates).toHaveLength(2);
		expect(cardBody(provider.updates[1].card)).toContain("✗ `edit`");
	});

	test("live text replaces the preview and is truncated", async () => {
		const { daemon, provider } = makeHarness();
		await daemon.statusFrame(statusFrame({ type: "turn_stream", phase: "live", text: "正在分析构建日志" }));
		expect(cardBody(provider.sentCards[0])).toContain("正在分析构建日志");
		const long = "字".repeat(500);
		const { daemon: daemon2, provider: provider2 } = makeHarness();
		await daemon2.statusFrame(statusFrame({ type: "turn_stream", phase: "live", text: long }));
		expect(cardBody(provider2.sentCards[0])).toContain("字".repeat(280));
		expect(cardBody(provider2.sentCards[0])).not.toContain("字".repeat(281));
	});

	test("context_update records model and token usage", async () => {
		const { daemon, provider } = makeHarness();
		await daemon.statusFrame(
			statusFrame({ type: "context_update", model: "GLM-5.3-Flash", tokenUsage: "12.3k/128k" }),
		);
		expect(cardBody(provider.sentCards[0])).toContain("GLM-5.3-Flash · 12.3k/128k");
	});

	test("final answer settles by deleting the card", async () => {
		const { daemon, provider } = makeHarness();
		await daemon.statusFrame(statusFrame(toolStarted("bash")));
		expect(provider.sentMessageIds).toEqual(["om_status_1"]);
		await daemon.statusFrame(
			statusFrame({ type: "turn_stream", phase: "finalized", finalAnswer: true, text: "完成了" }),
		);
		expect(provider.deletions).toEqual(["om_status_1"]);
		expect(provider.updates).toHaveLength(0);
		// A second settle (e.g. close after finalize) is a no-op.
		await daemon.close(SESSION_ID, 1);
		expect(provider.deletions).toEqual(["om_status_1"]);
	});

	test("failed delete falls back to a grey settled card", async () => {
		const { daemon, provider } = makeHarness();
		provider.deleteFailure = { ok: false, uncertain: false, detail: "window closed" };
		await daemon.statusFrame(statusFrame(toolStarted("bash")));
		await daemon.statusFrame(
			statusFrame({ type: "turn_stream", phase: "finalized", finalAnswer: true, text: "完成了" }),
		);
		expect(provider.deletions).toHaveLength(0);
		expect(provider.updates).toHaveLength(1);
		expect(cardHeader(provider.updates[0].card)).toBe("GJC 回合已结束");
		expect(cardBody(provider.updates[0].card)).toContain("已完成 · 耗时 0s");
	});

	test("a pre-ask lead-in frame does not settle the card", async () => {
		const { daemon, provider } = makeHarness();
		await daemon.statusFrame(statusFrame(toolStarted("bash")));
		await daemon.statusFrame(
			statusFrame({ type: "turn_stream", phase: "finalized", finalAnswer: false, text: "先看一下" }),
		);
		expect(provider.deletions).toHaveLength(0);
		expect(provider.updates).toHaveLength(0);
	});

	test("session close removes the card and a later frame starts a fresh one", async () => {
		const { daemon, provider } = makeHarness();
		await daemon.statusFrame(statusFrame(toolStarted("bash")));
		await daemon.close(SESSION_ID, 1);
		expect(provider.deletions).toEqual(["om_status_1"]);
		await daemon.statusFrame(statusFrame(toolStarted("read")));
		expect(provider.sentCards).toHaveLength(2);
		expect(provider.sentMessageIds).toEqual(["om_status_1", "om_status_2"]);
	});

	test("cards older than the max age settle instead of updating", async () => {
		const { daemon, provider, tick } = makeHarness();
		await daemon.statusFrame(statusFrame(toolStarted("bash")));
		tick(10 * 60_000 + 1);
		await daemon.statusFrame(statusFrame(toolStarted("read")));
		expect(provider.updates).toHaveLength(0);
		expect(provider.deletions).toEqual(["om_status_1"]);
		// The settled state is gone, so the next frame starts a fresh card.
		tick(2_000);
		await daemon.statusFrame(statusFrame(toolFinished("read", "completed")));
		expect(provider.sentCards).toHaveLength(2);
		expect(provider.sentMessageIds).toEqual(["om_status_1", "om_status_2"]);
	});

	test("a tool start after a long idle gap restarts the elapsed clock", async () => {
		const { daemon, provider, tick } = makeHarness();
		await daemon.statusFrame(statusFrame(toolStarted("bash")));
		tick(90_000);
		await daemon.statusFrame(statusFrame(toolStarted("read")));
		expect(provider.updates).toHaveLength(1);
		const body = cardBody(provider.updates[0].card);
		expect(body).toContain("`read`");
		expect(body).toContain("已运行 0s");
		expect(body).not.toContain("正在分析构建日志");
	});

	test("unrelated frame types never create a card", async () => {
		const { daemon, provider } = makeHarness();
		await daemon.statusFrame(statusFrame({ type: "identity_header", sessionId: SESSION_ID }));
		await daemon.statusFrame(statusFrame({ type: "action_needed", id: "a1" }));
		expect(provider.sentCards).toHaveLength(0);
		expect(provider.updates).toHaveLength(0);
	});

	test("failed first send retries on the next frame", async () => {
		const { daemon, provider } = makeHarness();
		provider.sendFailure = { ok: false, uncertain: false, detail: "rate limited" };
		await daemon.statusFrame(statusFrame(toolStarted("bash")));
		expect(provider.sentCards).toHaveLength(0);
		provider.sendFailure = undefined;
		await daemon.statusFrame(statusFrame(toolStarted("read")));
		expect(provider.sentCards).toHaveLength(1);
		expect(cardBody(provider.sentCards[0])).toContain("`read`");
	});
});

describe("status card rendering helpers", () => {
	test("formatStatusDuration renders compact spans", () => {
		expect(formatStatusDuration(0)).toBe("0s");
		expect(formatStatusDuration(59_400)).toBe("59s");
		expect(formatStatusDuration(60_000)).toBe("1m00s");
		expect(formatStatusDuration(83_000)).toBe("1m23s");
		expect(formatStatusDuration(3_661_000)).toBe("1h01m");
	});

	test("settledStatusCard renders the grey finished state", () => {
		const card = settledStatusCard("1m23s");
		expect(cardHeader(card)).toBe("GJC 回合已结束");
		expect(cardBody(card)).toContain("已完成 · 耗时 1m23s");
	});

	test("buildStatusCard renders the running state for a fresh session", () => {
		const { daemon, provider } = makeHarness();
		void daemon;
		const card = buildStatusCard(
			{
				sessionId: SESSION_ID,
				messageId: undefined,
				createdAt: 0,
				startedAt: 0,
				lastActivityAt: 0,
				lastUpdateAt: 0,
				toolName: "bash",
				toolOutcome: "started",
				toolAt: 0,
				text: undefined,
				model: undefined,
				tokenUsage: undefined,
				dirty: false,
				settled: false,
				chain: Promise.resolve(),
			},
			5_000,
		);
		expect(cardHeader(card)).toBe("GJC 运行中");
		expect(cardBody(card)).toContain("工具 `bash` · 5s");
		expect(cardBody(card)).toContain("已运行 5s");
		expect(provider.sentCards).toHaveLength(0);
	});
});
