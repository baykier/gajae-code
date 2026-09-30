import * as crypto from "node:crypto";
import { logger } from "@gajae-code/utils";

/**
 * Feishu custom-bot webhook transport.
 *
 * A Feishu custom bot (群自定义机器人) is push-only: the group admin creates it,
 * hands out one webhook URL, and every message is an authenticated HTTP POST to
 * that URL. Unlike the Telegram transport there is no Bot API surface, no
 * polling, and no daemon ownership — delivery is stateless, which is why the
 * notifications extension can host this sink inside the session process.
 *
 * Verified against the official custom-bot guide
 * (open.feishu.cn/document/client-docs/bot-v3/add-custom-bot):
 *  - `POST <webhookUrl>` with a JSON body `{ msg_type, content, timestamp?, sign? }`
 *  - request body must stay under 20 KB
 *  - flow control is 5 msg/s and 100 msg/min per bot (error code 11232)
 *  - signature security: `sign = base64(hmac_sha256(key = `${timestamp}\n${secret}`, message = empty))`
 *    with `timestamp` in whole seconds no more than one hour from the server clock
 *  - success is `{ code: 0, msg: "success" }` (legacy spellings `StatusCode`/`StatusMessage` ride along)
 *  - 19021 signature mismatch/expired, 19022 IP not allowed, 19024 keyword not
 *    found, 9499 malformed body
 */

/** Prefix of every Feishu custom-bot webhook URL. */
export const FEISHU_WEBHOOK_URL_PREFIX = "https://open.feishu.cn/open-apis/bot/v2/hook/";

/** Feishu rejects any webhook request body over 20 KB. */
export const FEISHU_WEBHOOK_BODY_LIMIT_BYTES = 20 * 1024;

/**
 * Per-chunk character budget. CJK text is up to 3 UTF-8 bytes per char, so
 * 3 800 chars peak near 11.4 KB — inside the 20 KB body limit even after the
 * signature envelope and JSON escaping.
 */
export const FEISHU_TEXT_CHUNK_CHARS = 3_800;

/** Bounded retries for transient failures, matching the Telegram transport's budget. */
export const FEISHU_WEBHOOK_RETRY_ATTEMPTS = 3;

const FEISHU_RETRY_BASE_DELAY_MS = 1_000;

/** Feishu flow-control error: per-bot 5 msg/s / 100 msg/min limits were exceeded. */
const FEISHU_FLOW_LIMIT_CODE = 11232;

/** Feishu custom-bot webhook verification failures, in request-field order. */
export type FeishuWebhookRequest = {
	msg_type: "text";
	content: { text: string };
	/** Present only when signature security is configured. Timestamp in seconds. */
	timestamp?: string;
	/** Present only when signature security is configured. */
	sign?: string;
};

/**
 * Compute the custom-bot signature: the `${timestamp}\n${secret}` string is the
 * HMAC *key* and the signed message is empty — deliberately unlike every
 * conventional HMAC construction, per the official samples.
 */
export function feishuWebhookSign(secret: string, timestampSeconds: string): string {
	return crypto.createHmac("sha256", `${timestampSeconds}\n${secret}`).digest().toString("base64");
}

/** Build one webhook request body, attaching the signature pair when a secret is set. */
export function buildFeishuWebhookTextBody(input: {
	text: string;
	secret?: string;
	timestampSeconds?: string;
}): FeishuWebhookRequest {
	return {
		msg_type: "text",
		content: { text: input.text },
		...(input.secret && input.timestampSeconds
			? { timestamp: input.timestampSeconds, sign: feishuWebhookSign(input.secret, input.timestampSeconds) }
			: {}),
	};
}

/** Split text into webhook-sized chunks without splitting surrogate pairs. */
export function splitFeishuText(text: string, maxChars: number = FEISHU_TEXT_CHUNK_CHARS): string[] {
	const chars = [...text];
	if (chars.length <= maxChars) return [text];
	const chunks: string[] = [];
	for (let offset = 0; offset < chars.length; offset += maxChars) {
		chunks.push(chars.slice(offset, offset + maxChars).join(""));
	}
	return chunks;
}

export type FeishuWebhookResult = { ok: true; chunks: number } | { ok: false; uncertain: boolean; detail: string };

export interface FeishuWebhookSendOptions {
	webhookUrl: string;
	secret?: string;
	text: string;
	signal?: AbortSignal;
}

export interface FeishuWebhookSendDeps {
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	/** Clock for signature timestamps; seconds precision, defaults to `Date.now`. */
	now?: () => number;
}

type FeishuWebhookResponse = {
	code?: number;
	msg?: string;
	StatusCode?: number;
	StatusMessage?: string;
};

function feishuWebhookFailureDetail(code: number | undefined, message: string | undefined, httpStatus: number): string {
	if (code === 19021) return "Feishu signature verification failed (check the secret and server clock).";
	if (code === 19022) return "Feishu rejected the request source IP (IP allowlist security is enabled).";
	if (code === 19024) return "Feishu keyword security rejected the message (no configured keyword matched).";
	if (code === FEISHU_FLOW_LIMIT_CODE) return "Feishu flow limit hit (5 msg/s, 100 msg/min per bot).";
	const stated = message ?? (typeof code === "number" ? `code ${code}` : undefined);
	return stated ? `Feishu webhook rejected the message: ${stated}` : `Feishu webhook failed (HTTP ${httpStatus}).`;
}

async function postFeishuWebhookChunk(input: {
	url: URL;
	chunk: string;
	secret: string | undefined;
	signal: AbortSignal | undefined;
	attempt: number;
	deps: Required<Pick<FeishuWebhookSendDeps, "fetchImpl" | "sleep" | "now">>;
}): Promise<FeishuWebhookResult> {
	const timestampSeconds = input.secret ? String(Math.floor(input.deps.now() / 1000)) : undefined;
	const body = buildFeishuWebhookTextBody({ text: input.chunk, secret: input.secret, timestampSeconds });
	const encoded = JSON.stringify(body);
	if (Buffer.byteLength(encoded, "utf8") > FEISHU_WEBHOOK_BODY_LIMIT_BYTES) {
		return { ok: false, uncertain: false, detail: "message exceeds the Feishu 20 KB webhook body limit." };
	}
	try {
		const response = await input.deps.fetchImpl(input.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: encoded,
			...(input.signal ? { signal: input.signal } : {}),
		});
		const payload = (await response.json().catch(() => undefined)) as FeishuWebhookResponse | undefined;
		const code =
			typeof payload?.code === "number"
				? payload.code
				: typeof payload?.StatusCode === "number"
					? payload.StatusCode
					: undefined;
		if (response.ok && code === 0) return { ok: true, chunks: 1 };
		const retryable = response.status === 429 || response.status >= 500 || code === FEISHU_FLOW_LIMIT_CODE;
		if (retryable && input.attempt < FEISHU_WEBHOOK_RETRY_ATTEMPTS) {
			await input.deps.sleep(FEISHU_RETRY_BASE_DELAY_MS * input.attempt);
			return await postFeishuWebhookChunk({ ...input, attempt: input.attempt + 1 });
		}
		return {
			ok: false,
			// A 4xx-class rejection with a parsed body is a definite refusal; anything
			// else (odd HTTP status, unparsable body) stays uncertain.
			uncertain: !(response.status >= 400 && response.status < 500 && payload !== undefined),
			detail: feishuWebhookFailureDetail(code, payload?.msg ?? payload?.StatusMessage, response.status),
		};
	} catch (error) {
		if (input.signal?.aborted) return { ok: false, uncertain: true, detail: "delivery was cancelled." };
		if (input.attempt < FEISHU_WEBHOOK_RETRY_ATTEMPTS) {
			await input.deps.sleep(FEISHU_RETRY_BASE_DELAY_MS * input.attempt);
			return await postFeishuWebhookChunk({ ...input, attempt: input.attempt + 1 });
		}
		return {
			ok: false,
			uncertain: true,
			detail: `network error after ${input.attempt} attempts: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

/** Send text to a Feishu group through the custom-bot webhook, chunked and retried. */
export async function sendFeishuWebhookText(
	options: FeishuWebhookSendOptions,
	deps: FeishuWebhookSendDeps = {},
): Promise<FeishuWebhookResult> {
	let url: URL;
	try {
		url = new URL(options.webhookUrl);
	} catch {
		return { ok: false, uncertain: false, detail: "configured Feishu webhook URL is not a valid URL." };
	}
	if (url.protocol !== "https:") {
		return { ok: false, uncertain: false, detail: "configured Feishu webhook URL must use https." };
	}
	const resolvedDeps = {
		fetchImpl: deps.fetchImpl ?? globalThis.fetch,
		sleep: deps.sleep ?? ((ms: number) => Bun.sleep(ms)),
		now: deps.now ?? Date.now,
	};
	const chunks = splitFeishuText(options.text);
	let delivered = 0;
	for (const chunk of chunks) {
		const result = await postFeishuWebhookChunk({
			url,
			chunk,
			secret: options.secret,
			signal: options.signal,
			attempt: 1,
			deps: resolvedDeps,
		});
		if (!result.ok) {
			return {
				ok: false,
				uncertain: result.uncertain,
				detail: delivered > 0 ? `delivered ${delivered}/${chunks.length} chunks; ${result.detail}` : result.detail,
			};
		}
		delivered += 1;
	}
	return { ok: true, chunks: delivered };
}

/** Serialized, best-effort outbound queue feeding one Feishu group webhook. */
export interface FeishuWebhookSink {
	/** Publishes one finalized answer; fire-and-forget, never throws. */
	publish(sessionId: string, text: string): void;
}

/** Publications allowed to queue behind an in-flight send before older ones drop. */
const FEISHU_SINK_MAX_PENDING = 8;

export interface FeishuWebhookSinkOptions {
	webhookUrl: string;
	secret?: string;
	/** Re-checked at publish time so policy epochs and redaction gate delivery. */
	canDeliver: () => boolean;
	send?: (text: string) => Promise<FeishuWebhookResult>;
}

/**
 * Create the session-side Feishu delivery sink.
 *
 * Publications are serialized (Feishu allows 5 msg/s per bot) and capped: once
 * `FEISHU_SINK_MAX_PENDING` are waiting, the oldest queued publication is
 * dropped with a warning instead of silently stalling the chain. Every failure
 * is logged and swallowed — chat delivery must never corrupt the session that
 * emitted the frame.
 */
export function createFeishuWebhookSink(options: FeishuWebhookSinkOptions): FeishuWebhookSink {
	const send =
		options.send ??
		((text: string) => sendFeishuWebhookText({ webhookUrl: options.webhookUrl, secret: options.secret, text }));
	let chain: Promise<void> = Promise.resolve();
	let pending = 0;
	return {
		publish(sessionId: string, text: string): void {
			if (!options.canDeliver()) return;
			if (pending >= FEISHU_SINK_MAX_PENDING) {
				logger.warn(
					`feishu: dropped notification for session …${sessionId.slice(-6)}; ${pending} sends already queued.`,
				);
				return;
			}
			pending += 1;
			const settled = chain.then(async () => {
				pending -= 1;
				if (!options.canDeliver()) return;
				const result = await send(text);
				if (!result.ok) {
					logger.warn(
						`feishu: notification delivery failed for session …${sessionId.slice(-6)}: ${result.detail}`,
					);
				}
			});
			// The chain must never reject: a logged failure is a settled publication.
			chain = settled.then(
				() => undefined,
				() => undefined,
			);
		},
	};
}
