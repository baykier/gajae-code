import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { ChatDaemonRuntime } from "../src/sdk/bus/chat-daemon-runtime";
import type { FeishuAppInboundEnvelope, FeishuAppProviderClient } from "../src/sdk/bus/feishu-app-provider";
import { SESSION_PREPARED_EVENT } from "../src/sdk/host";
import type { SessionRouterClient } from "../src/sdk/router";

const SESSION_ID = "feishu-runtime-session";
const GENERATION = 2;

class FakeFeishuAppProvider implements FeishuAppProviderClient {
	handler: ((envelope: FeishuAppInboundEnvelope) => void | Promise<void>) | undefined;
	starts = 0;
	stops = 0;
	transportHealthy: boolean | undefined = true;
	startError: Error | undefined;

	async start(onEnvelope: (envelope: FeishuAppInboundEnvelope) => void | Promise<void>): Promise<void> {
		if (this.startError) throw this.startError;
		this.starts += 1;
		this.handler = onEnvelope;
	}

	async stop(): Promise<void> {
		this.stops += 1;
		this.handler = undefined;
	}

	async sendText(): Promise<{ ok: true; messageId: undefined }> {
		return { ok: true, messageId: undefined };
	}

	async sendCard(): Promise<{ ok: true; messageId: undefined }> {
		return { ok: true, messageId: undefined };
	}

	async updateCard(): Promise<{ ok: true; messageId: undefined }> {
		return { ok: true, messageId: undefined };
	}
}

function fakeRouterClient(frames: Record<string, unknown>[] = []): SessionRouterClient {
	return {
		onFrame: handler => {
			void handler;
			return () => undefined;
		},
		request: async frame => {
			frames.push(frame as Record<string, unknown>);
			if (
				(frame as { type?: string }).type === "control_request" &&
				(frame as { operation?: string }).operation === "turn.prompt"
			) {
				// Mirrors the real host control envelope: the acceptance receipt is
				// nested under `result`, not at the top level.
				return {
					ok: true,
					result: {
						version: 2,
						operationRef: "turn.prompt",
						status: "accepted",
						receipt: { accepted: true, clientRef: (frame as { idempotencyKey?: string }).idempotencyKey },
					},
				};
			}
			return {
				type: "event_replay_result",
				id: "replay-1",
				ok: true,
				events: [
					{ type: "event", name: SESSION_PREPARED_EVENT, sessionId: SESSION_ID, generation: GENERATION, seq: 1 },
					{ type: "event", name: "session_ready", sessionId: SESSION_ID, generation: GENERATION, seq: 2 },
				],
				generation: GENERATION,
				lastSeq: 2,
			};
		},
		close: async () => undefined,
		send: () => undefined,
	};
}

async function withStartedRuntime(
	run: (input: {
		provider: FakeFeishuAppProvider;
		runtime: ChatDaemonRuntime;
		frames: Record<string, unknown>[];
	}) => Promise<void>,
	providerOverrides: Partial<FakeFeishuAppProvider> = {},
): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-feishu-runtime-"));
	let runtime: ChatDaemonRuntime | undefined;
	const frames: Record<string, unknown>[] = [];
	try {
		const stateRoot = path.join(agentDir, ".gjc", "state");
		const endpointFile = path.join(stateRoot, "sdk", `${SESSION_ID}.json`);
		await fs.mkdir(path.dirname(endpointFile), { recursive: true });
		await fs.writeFile(
			endpointFile,
			`${JSON.stringify({ version: 1, sessionId: SESSION_ID, url: "ws://localhost:1/", token: "not-persisted", pid: process.pid })}\n`,
		);
		const endpointMtimeMs = (await fs.stat(endpointFile)).mtimeMs;
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: SESSION_ID,
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: GENERATION,
			pid: process.pid,
			endpointMtimeMs,
		});
		await index.append({
			type: "host_heartbeat",
			sessionId: SESSION_ID,
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: GENERATION,
			pid: process.pid,
			endpointMtimeMs,
			activity: { state: "idle", at: Date.now() },
		});

		const provider = new FakeFeishuAppProvider();
		Object.assign(provider, providerOverrides);
		runtime = new ChatDaemonRuntime(
			{
				kind: "feishu-app",
				agentDir,
				config: {
					identity: "feishu-app-identity",
					notifications: {
						"feishu-app": {
							appId: "cli_a",
							appSecret: "secret",
							chatId: "oc_bound",
							authorizedOpenIds: "ou_alice, ou_bob",
						},
					},
				},
			},
			{
				createFeishuAppProvider: config => {
					expect(config).toEqual({
						appId: "cli_a",
						appSecret: "secret",
						chatId: "oc_bound",
						authorizedOpenIds: "ou_alice, ou_bob",
					});
					return provider;
				},
				routerDeps: {
					createIndex: () => index,
					createClient: async () => fakeRouterClient(frames),
					setInterval: (() => 0) as unknown as typeof setInterval,
					clearInterval: (() => undefined) as unknown as typeof clearInterval,
				},
			},
		);
		await runtime.start();
		await run({ provider, runtime, frames });
	} finally {
		await runtime?.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

describe("chat daemon runtime feishu-app branch", () => {
	test("configured feishu-app wires the daemon from settings and reports health", async () => {
		await withStartedRuntime(async ({ provider, runtime }) => {
			expect(provider.starts).toBe(1);
			expect(provider.handler).toBeDefined();
			expect(runtime.transportHealthy()).toBe(true);
			provider.transportHealthy = false;
			expect(runtime.transportHealthy()).toBe(false);
			provider.transportHealthy = undefined;
			// A missing provider observation degrades to router readiness only.
			expect(runtime.transportHealthy()).toBe(true);
			// Inbound envelopes flow through the daemon wiring without crashing
			// when no session attachment exists.
			await provider.handler?.({
				kind: "message",
				senderOpenId: "ou_alice",
				text: "1",
				value: undefined,
				messageId: "om_1",
			});
		});
	});
	test("malformed /sdk commands answer with a usage hint instead of silence", async () => {
		const texts: string[] = [];
		await withStartedRuntime(
			async ({ provider, runtime }) => {
				// Reconcile attaches the index-registered session and publishes the
				// readiness message, which binds the chat daemon to the session.
				await runtime.reconcile({ waitForReplay: true });
				for (let attempt = 0; attempt < 2_000 && texts.length === 0; attempt++) await Bun.sleep(1);
				const bound = texts.length;
				await provider.handler?.({
					kind: "message",
					senderOpenId: "ou_alice",
					text: "/sdk",
					value: undefined,
					messageId: "om_2",
				});
				for (let attempt = 0; attempt < 2_000 && texts.length <= bound; attempt++) await Bun.sleep(1);
				expect(texts.length).toBeGreaterThan(bound);
				expect(texts[texts.length - 1]).toContain("/sdk <control|query|global>");
			},
			{
				sendText: (content?: string) => {
					texts.push(content ?? "");
					return Promise.resolve({ ok: true as const, messageId: undefined });
				},
			},
		);
	});
	test("free-form messages dispatch a durable turn.prompt and answer with an acceptance ack", async () => {
		const texts: string[] = [];
		await withStartedRuntime(
			async ({ provider, runtime, frames }) => {
				await runtime.reconcile({ waitForReplay: true });
				for (let attempt = 0; attempt < 2_000 && texts.length === 0; attempt++) await Bun.sleep(1);
				const bound = texts.length;
				await provider.handler?.({
					kind: "message",
					senderOpenId: "ou_alice",
					text: "@_user_1 检查一下构建状态",
					value: undefined,
					messageId: "om_3",
				});
				for (let attempt = 0; attempt < 2_000 && texts.length <= bound; attempt++) await Bun.sleep(1);
				expect(texts[texts.length - 1]).toBe("已提交到会话。");
				const prompt = frames.find(
					frame => frame.type === "control_request" && frame.operation === "turn.prompt",
				) as { input?: { text?: string; clientRef?: string }; idempotencyKey?: string } | undefined;
				expect(prompt).toBeDefined();
				expect(prompt?.input?.text).toBe("检查一下构建状态");
				expect(prompt?.input?.clientRef).toBe(prompt?.idempotencyKey);
				expect(frames.some(frame => (frame as { type?: string }).type === "user_message")).toBe(false);
			},
			{
				sendText: (content?: string) => {
					texts.push(content ?? "");
					return Promise.resolve({ ok: true as const, messageId: undefined });
				},
			},
		);
	});

	test("unconfigured feishu-app kind fails fast", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-feishu-runtime-empty-"));
		try {
			const index = await new SessionIndex(agentDir).open();
			const runtime = new ChatDaemonRuntime(
				{ kind: "feishu-app", agentDir, config: { identity: "empty", notifications: {} } },
				{
					createFeishuAppProvider: () => {
						throw new Error("provider factory must not run without config");
					},
					routerDeps: {
						createIndex: () => index,
						createClient: async () => fakeRouterClient(),
						setInterval: (() => 0) as unknown as typeof setInterval,
						clearInterval: (() => undefined) as unknown as typeof clearInterval,
					},
				},
			);
			await expect(runtime.start()).rejects.toThrow("configuration is unavailable");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("provider start failure rejects runtime start", async () => {
		await withStartedRuntime(
			async () => {
				throw new Error("runtime.start should have rejected before run");
			},
			{ startError: new Error("ws refused") },
		).then(
			() => {
				throw new Error("expected rejection");
			},
			error => {
				expect(String(error)).toContain("ws refused");
			},
		);
	});
});
