import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "@gajae-code/utils";
import {
	createFeishuWebhookSink,
	FEISHU_TEXT_CHUNK_CHARS,
	type FeishuWebhookResult,
	sendFeishuWebhookText,
} from "../src/sdk/bus/feishu-webhook";

interface RecordedCall {
	url: string;
	init: RequestInit;
}

interface FeishuTextBody {
	msg_type: string;
	content: { text: string };
	timestamp?: string;
	sign?: string;
}

function recorder(responses: Array<{ status: number; body: unknown }>): {
	calls: RecordedCall[];
	fetchImpl: typeof fetch;
} {
	const calls: RecordedCall[] = [];
	let index = 0;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		const response = responses[Math.min(index, responses.length - 1)];
		index += 1;
		return new Response(JSON.stringify(response.body), { status: response.status });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

const WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/test-token";
const FAST_DEPS = { sleep: () => Promise.resolve() };

describe("sendFeishuWebhookText", () => {
	test("posts one text message and treats code 0 as success", async () => {
		const { calls, fetchImpl } = recorder([{ status: 200, body: { code: 0, msg: "success" } }]);
		const result = await sendFeishuWebhookText(
			{ webhookUrl: WEBHOOK, secret: "test-secret", text: "hello feishu" },
			{ fetchImpl },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.chunks).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(WEBHOOK);
		expect(calls[0].init.method).toBe("POST");
		const headers = new Headers(calls[0].init.headers);
		expect(headers.get("content-type")).toBe("application/json");
		const body = JSON.parse(String(calls[0].init.body)) as FeishuTextBody;
		expect(body.msg_type).toBe("text");
		expect(body.content.text).toBe("hello feishu");
		expect(body.timestamp).toBe(String(Math.floor(Date.now() / 1000)));
		expect(typeof body.sign).toBe("string");
	});

	test("treats empty text as a no-op success without an HTTP request", async () => {
		const { calls, fetchImpl } = recorder([{ status: 200, body: { code: 0, msg: "success" } }]);
		const result = await sendFeishuWebhookText({ webhookUrl: WEBHOOK, text: "" }, { fetchImpl });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.chunks).toBe(0);
		expect(calls).toHaveLength(0);
	});

	test("signs in the body: HMAC key is timestamp + newline + secret over an empty message", async () => {
		const { calls, fetchImpl } = recorder([{ status: 200, body: { code: 0, msg: "success" } }]);
		const result = await sendFeishuWebhookText(
			{ webhookUrl: WEBHOOK, secret: "test-secret", text: "signed" },
			{ fetchImpl, now: () => 1_700_000_000_000 },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		const body = JSON.parse(String(calls[0].init.body)) as FeishuTextBody;
		expect(body.timestamp).toBe("1700000000");
		// Independent openssl vector: base64(HMAC-SHA256(key="1700000000\ntest-secret", message="")).
		expect(body.sign).toBe("mbm4Y4oluIPQ00qlBIhX8vAZ0EKv3nw0LuTb91jPL84=");
	});

	test("sends unsigned bodies when no secret is configured", async () => {
		const { calls, fetchImpl } = recorder([{ status: 200, body: { code: 0, msg: "success" } }]);
		const result = await sendFeishuWebhookText({ webhookUrl: WEBHOOK, text: "plain" }, { fetchImpl });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		const body = JSON.parse(String(calls[0].init.body)) as FeishuTextBody;
		expect(body.timestamp).toBeUndefined();
		expect(body.sign).toBeUndefined();
	});

	test("rejects non-https and malformed webhook URLs before any network call", async () => {
		const { calls, fetchImpl } = recorder([{ status: 200, body: { code: 0, msg: "success" } }]);
		const insecure = await sendFeishuWebhookText(
			{ webhookUrl: "http://open.feishu.cn/open-apis/bot/v2/hook/x", text: "x" },
			{ fetchImpl },
		);
		expect(insecure.ok).toBe(false);
		if (insecure.ok) throw new Error("expected failure");
		expect(insecure.uncertain).toBe(false);
		expect(insecure.detail).toBe("configured Feishu webhook URL must use https.");
		const malformed = await sendFeishuWebhookText({ webhookUrl: "not a url", text: "x" }, { fetchImpl });
		expect(malformed.ok).toBe(false);
		if (malformed.ok) throw new Error("expected failure");
		expect(malformed.uncertain).toBe(false);
		expect(malformed.detail).toBe("configured Feishu webhook URL is not a valid URL.");
		expect(calls).toHaveLength(0);
	});

	test("splits an oversized message into chunked deliveries without losing content", async () => {
		const { calls, fetchImpl } = recorder([{ status: 200, body: { code: 0, msg: "success" } }]);
		const text = "字".repeat(12_000);
		const result = await sendFeishuWebhookText({ webhookUrl: WEBHOOK, text }, { fetchImpl });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.chunks).toBe(4);
		expect(calls).toHaveLength(4);
		for (const call of calls) {
			const body = JSON.parse(String(call.init.body)) as FeishuTextBody;
			expect(body.content.text.length).toBeGreaterThan(0);
			expect(body.content.text.length <= FEISHU_TEXT_CHUNK_CHARS).toBe(true);
		}
		const delivered = calls.map(call => (JSON.parse(String(call.init.body)) as FeishuTextBody).content.text).join("");
		expect(delivered).toBe(text);
	});

	test("maps known Feishu business codes to actionable details", async () => {
		for (const [code, expected] of [
			[19021, "Feishu signature verification failed (check the secret and server clock)."],
			[19022, "Feishu rejected the request source IP (IP allowlist security is enabled)."],
			[19024, "Feishu keyword security rejected the message (no configured keyword matched)."],
		] as const) {
			const { fetchImpl } = recorder([{ status: 200, body: { code, msg: "boom" } }]);
			const result = await sendFeishuWebhookText({ webhookUrl: WEBHOOK, text: "x" }, { fetchImpl });
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("expected failure");
			if (result.ok) throw new Error("expected failure");
			expect(result.detail).toBe(expected);
			// HTTP 200 with a parsed business error stays ambiguous by design.
			expect(result.uncertain).toBe(true);
		}
	});

	test("retries the flow-limit code, then reports the flow-limit detail", async () => {
		const { calls, fetchImpl } = recorder([{ status: 200, body: { code: 11232, msg: "frequency limited" } }]);
		const result = await sendFeishuWebhookText({ webhookUrl: WEBHOOK, text: "x" }, { fetchImpl, ...FAST_DEPS });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(calls).toHaveLength(3);
		expect(result.detail).toBe("Feishu flow limit hit (5 msg/s, 100 msg/min per bot).");
	});

	test("surfaces an unknown error code with the API message", async () => {
		const { fetchImpl } = recorder([{ status: 200, body: { code: 4242, msg: "odd failure" } }]);
		const result = await sendFeishuWebhookText({ webhookUrl: WEBHOOK, text: "x" }, { fetchImpl });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.uncertain).toBe(true);
		expect(result.detail).toBe("Feishu webhook rejected the message: odd failure");
	});

	test("retries transient network failures, then reports an uncertain failure", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const result = await sendFeishuWebhookText({ webhookUrl: WEBHOOK, text: "x" }, { fetchImpl, ...FAST_DEPS });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(calls).toBe(3);
		expect(result.uncertain).toBe(true);
		expect(result.detail).toBe("network error after 3 attempts: fetch failed");
	});

	test("does not retry a 404 webhook URL and reports it uncertain without a parsable body", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
		const result = await sendFeishuWebhookText({ webhookUrl: WEBHOOK, text: "x" }, { fetchImpl, ...FAST_DEPS });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(calls).toBe(1);
		expect(result.uncertain).toBe(true);
		expect(result.detail).toBe("Feishu webhook failed (HTTP 404).");
	});

	test("reports a definite refusal when a 4xx carries a parsed business error", async () => {
		const { fetchImpl } = recorder([{ status: 400, body: { code: 19024, msg: "Key Words Not Found" } }]);
		const result = await sendFeishuWebhookText({ webhookUrl: WEBHOOK, text: "x" }, { fetchImpl });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.uncertain).toBe(false);
		expect(result.detail).toBe("Feishu keyword security rejected the message (no configured keyword matched).");
	});

	test("reports partial chunk progress when a later chunk fails", async () => {
		const responses = [
			{ status: 200, body: { code: 0, msg: "success" } },
			{ status: 200, body: { code: 19024, msg: "Key Words Not Found" } },
		];
		const { fetchImpl } = recorder(responses);
		const result = await sendFeishuWebhookText(
			{ webhookUrl: WEBHOOK, text: "一".repeat(FEISHU_TEXT_CHUNK_CHARS * 2) },
			{ fetchImpl },
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.detail).toBe(
			`delivered 1/2 chunks; Feishu keyword security rejected the message (no configured keyword matched).`,
		);
	});

	test("cancels delivery when the signal aborts mid-flight", async () => {
		const controller = new AbortController();
		const fetchImpl = (async () => {
			controller.abort();
			throw new Error("aborted");
		}) as unknown as typeof fetch;
		const result = await sendFeishuWebhookText(
			{ webhookUrl: WEBHOOK, text: "x", signal: controller.signal },
			{ fetchImpl, ...FAST_DEPS },
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.uncertain).toBe(true);
		expect(result.detail).toBe("delivery was cancelled.");
	});
});

describe("createFeishuWebhookSink", () => {
	function flush(): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, 0));
	}

	test("does not send when canDeliver is false", async () => {
		const sent: string[] = [];
		const sink = createFeishuWebhookSink({
			webhookUrl: WEBHOOK,
			canDeliver: () => false,
			send: async text => {
				sent.push(text);
				return { ok: true, chunks: 1 };
			},
		});
		sink.publish("session-1", "hello");
		await flush();
		expect(sent).toEqual([]);
	});

	test("delivers queued publications in order", async () => {
		const sent: string[] = [];
		const sink = createFeishuWebhookSink({
			webhookUrl: WEBHOOK,
			canDeliver: () => true,
			send: async text => {
				sent.push(text);
				return { ok: true, chunks: 1 };
			},
		});
		sink.publish("session-1", "first");
		sink.publish("session-1", "second");
		await flush();
		expect(sent).toEqual(["first", "second"]);
	});

	test("re-checks canDeliver at dequeue time", async () => {
		const sent: string[] = [];
		let allowed = true;
		const sink = createFeishuWebhookSink({
			webhookUrl: WEBHOOK,
			canDeliver: () => allowed,
			send: async text => {
				sent.push(text);
				return { ok: true, chunks: 1 };
			},
		});
		sink.publish("session-1", "queued");
		allowed = false;
		await flush();
		expect(sent).toEqual([]);
	});

	test("drops publications past the pending cap with a warning instead of stalling", async () => {
		const warn = spyOn(logger, "warn");
		const release = Promise.withResolvers<void>();
		let deliveries = 0;
		const sink = createFeishuWebhookSink({
			webhookUrl: WEBHOOK,
			canDeliver: () => true,
			send: async () => {
				deliveries += 1;
				await release.promise;
				return { ok: true, chunks: 1 } satisfies FeishuWebhookResult;
			},
		});
		for (let index = 0; index < 9; index += 1) sink.publish("session-1", `m${index}`);
		release.resolve();
		await flush();
		expect(deliveries).toBe(8);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("dropped notification for session …sion-1");
		warn.mockRestore();
	});

	test("never rejects: a failing send is logged and swallowed", async () => {
		const warn = spyOn(logger, "warn");
		const sink = createFeishuWebhookSink({
			webhookUrl: WEBHOOK,
			canDeliver: () => true,
			send: async () => ({ ok: false, uncertain: true, detail: "network error after 3 attempts: fetch failed" }),
		});
		sink.publish("session-42", "doomed");
		await flush();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("feishu: notification delivery failed for session …ion-42");
		warn.mockRestore();
	});
});
