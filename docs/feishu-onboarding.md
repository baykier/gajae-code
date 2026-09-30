# Feishu notification onboarding

This document covers both Feishu (Lark) notification adapters: the push-only
**custom-bot webhook** and the conversation-capable **enterprise app bot**.
The webhook is outbound-only: local GJC sessions push settled final answers to
a Feishu group through a custom bot webhook. Feishu custom bots have no
inbound message surface, so there is no daemon, no thread binding, and no
reply routing — answers to the agent stay in the terminal (or in another
adapter such as [Telegram](./telegram-onboarding.md) or
[Slack](./slack-onboarding.md)). For two-way conversation inside Feishu, use
the enterprise app bot in the [conversation adapter
section](#conversation-adapter-enterprise-app-bot) below.

## Prerequisites

In the target Feishu group, add a **custom bot** (群设置 → 群机器人 → 添加机器人
→ 自定义机器人) and copy its webhook URL:

```text
https://open.feishu.cn/open-apis/bot/v2/hook/<token>
```

The webhook token inside the URL is the credential: anyone holding it can post
to the group. Keep the group private to people authorized to see local session
output.

If the bot's security settings require a signature, copy the **signature
secret** too. With a secret configured, every request carries a `timestamp` and
`sign` pair in the JSON body: `sign` is
`Base64(HmacSHA256(key = timestamp + "\n" + secret, message = ""))`, exactly as
the Feishu custom-bot docs specify. Without a secret, requests are sent
unsigned.

Feishu enforces security settings per bot. When enabled, the message must pass
the configured keyword filter, come from an allowed IP range, and respect flow
limits (5 messages/second, 100 messages/minute per bot). The adapter surfaces
the matching official error codes (`19021` signature, `19022` IP allowlist,
`19024` keyword, `11232` flow limit) in `gjc notify status`, `/notify test`,
and delivery logs.

## Configure the adapter

`gjc notify setup feishu` is non-interactive when both flags are supplied:

- `--feishu-webhook-url` — the full custom-bot webhook URL (must be https)
- `--feishu-secret` — optional signing secret; omit it for unsigned requests

Setup writes:

- `notifications.enabled = true`
- `notifications.feishu.enabled = true`
- `notifications.feishu.webhookUrl`
- `notifications.feishu.secret` when supplied
- `notifications.redact = true` when `--redact` is requested

`gjc notify status` reports Feishu configuration, effective enablement, and
masked secrets. `/notify test --provider feishu` sends a real probe message
through the configured webhook and prints the delivery verdict, including the
failure details above. In `/settings`, the Feishu webhook URL and secret follow
the same explicit `keep`/`replace`/`remove` editing model as the other
providers; removing the webhook URL turns the provider off without touching
the global master switch.

## Delivery behavior

Notifications are published only for settled final answers: a turn that has
finalized with a non-empty final answer. Because the webhook is fire-and-forget
from Feishu's side, the adapter:

- splits long answers into chunks that stay inside Feishu's 20 KB request-body
  limit and reports partial progress (`delivered 2/4 chunks; …`) when a later
  chunk fails;
- retries transient failures (network errors, HTTP 5xx/429, and the `11232`
  flow-limit code) with capped backoff, then reports the outcome as uncertain
  when Feishu never confirmed or refused the delivery;
- serializes sends per session, drops new publications instead of queueing
  unboundedly when more than 8 are already pending, and re-checks the global
  notification gate both when a message is queued and again when it is
  dequeued, so a mid-session disable never sends a queued frame.

There is no delivery cursor and no resume: Feishu webhooks are one-way, and a
failed send is logged, not replayed.

## Conversation adapter (enterprise app bot)

`gjc notify setup feishu-app` configures the conversation-capable counterpart:
an enterprise **self-built app bot** (企业自建应用机器人) that both pushes
notifications and accepts replies and `/sdk` commands over Feishu's WebSocket
long connection (长连接事件订阅). No public inbound URL, callback server, or
port forwarding is required — the bot dials out to Feishu.

Prerequisites in the Feishu open platform:

1. Create an enterprise self-built app and enable the **bot** capability
   (应用能力 → 机器人).
2. Under event subscription (事件与回调 → 订阅方式), select **长连接**
   (long connection) so events arrive over the SDK's WebSocket client instead
   of an HTTP callback.
3. Grant the IM scopes the bot needs to send and receive group messages
   (`im:message` send/receive), then publish a version so tenants see them.
4. Add the bot to the target group and copy its `chat_id` (`oc_…`, visible via
   the group info or the API explorer). Record the `app_id` (`cli_…`) and
   `app_secret`, plus the `open_id` (`ou_…`) of every user allowed to talk to
   the agent.

Non-interactive setup:

```sh
gjc notify setup feishu-app \
  --feishu-app-id <cli_...> \
  --feishu-app-secret <secret> \
  --feishu-app-chat-id <oc_...> \
  --feishu-app-authorized-open-ids <ou_a,ou_b>
```

`--feishu-app-chat-id` is required (the daemon is bound to exactly one
chat). `--feishu-app-authorized-open-ids` is optional: omit the flag and setup
prompts for it, and leaving it empty keeps inbound traffic denied — the daemon
only accepts messages from senders whose `open_id` is on the list, so it stays
inactive until an allowlist exists. Omit any flag to be prompted
interactively; secrets are prompted without echo. Setup writes
`notifications.feishu-app.{enabled,appId,appSecret,chatId,authorizedOpenIds}`
and activates the `feishu-app-internal` daemon. `/notify test --provider
feishu-app` sends a probe message; `gjc notify health --provider feishu-app`
reports transport health from the live WebSocket session. In `/settings`, the
app secret follows the same explicit `keep`/`replace`/`remove` editing model
as the other provider secrets.

Runtime behavior:

- The bot is bound to exactly one chat; messages routed from any other chat
  are dropped regardless of what the payload claims. Bot echoes and non-user
  senders are ignored.
- Outbound answers reuse the webhook adapter's 3,800-character chunking.
- Ask-style questions (approvals, prompts) render as interactive cards with
  one button per option; the card payload carries the routing identity
  (`sessionId`, `actionId`, `answerIndex`), so a button click answers in
  place — the card turns grey showing the chosen answer. Plain-number replies
  (`1`, `2`, …) answer the most recent pending ask as a fallback.
- `/sdk …` commands dispatch to the most recently delivered session with a
  fresh idempotency key per dispatch; command results are posted back to the
  chat. A `/sdk`-prefixed message that does not match the
  `/sdk <control|query|global> <operation> [json]` grammar answers with a usage
  hint instead of staying silent.
- Any other text message is free-form chat: it is dispatched into the bound
  session as a durable `turn.prompt` control request, and the bot acks with
  「已提交到会话。」on acceptance. A prompt submitted while the session is
  mid-run queues for the next idle boundary instead of steering the live run.
  Failures post a rejection reason instead of staying silent. Without an
  active bound session free-form text stays silent — send `/sdk` to see the
  no-session hint.
- Live status cards: while a turn runs, the bot keeps one ephemeral card in the
  chat that mirrors the active tool (with ✓/✗ outcome and elapsed duration),
  the latest streamed text (truncated preview), and model/token context,
  redrawn at most once every 3 seconds. The card is deleted when the final
  answer arrives or the session closes; if deletion fails it turns grey with a
  「已完成 · 耗时 …」 summary. Controlled by
  `notifications.feishu-app.streaming.enabled` (default on). While the lane is
  active, the mirrored live frames (tool activity, reasoning summaries, context
  updates) are not also posted as plain text — finalized answers are unaffected.
- Feishu API rejections (non-zero result code) are definitive failures;
  transport failures are reported as uncertain. Failures are logged through
  `gjc notify status` and delivery logs. Like the webhook transport there is
  no delivery cursor and no replay.

The push-only `feishu` webhook adapter remains unchanged and stays the right
choice when replies should stay in the terminal.
