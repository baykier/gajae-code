/**
 * Configure Telegram, Discord, Slack, Feishu webhook, or Feishu app notifications.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	assertStrictActivateThreadInvocation,
	assertStrictBindThreadInvocation,
	type NotifyAction,
	type NotifyCommandArgs,
	notifySetupProvider,
	runNotifyCliCommand,
} from "../cli/notify-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: NotifyAction[] = [
	"setup",
	"status",
	"health",
	"test",
	"recovery",
	"bind-thread",
	"activate-thread",
	"daemon-internal",
];

export default class Notify extends Command {
	static description = "Configure Telegram, Discord, Slack, Feishu webhook, or Feishu app notifications";

	static args = {
		action: Args.string({
			description: "Notify action (setup|status|health|test|recovery|bind-thread|activate-thread|daemon-internal)",
			required: false,
		}),
		extra: Args.string({
			description: "Provider or additional internal args",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		smoke: Flags.boolean({ description: "Run hidden daemon smoke" }),
		token: Flags.string({ description: "Telegram bot token (non-interactive setup)" }),
		"chat-id": Flags.string({ description: "Telegram chat id to pair (non-interactive setup)" }),
		"discord-bot-token": Flags.string({ description: "Discord bot token (non-interactive Discord setup)" }),
		"discord-application-id": Flags.string({ description: "Discord application id (non-interactive Discord setup)" }),
		"discord-guild-id": Flags.string({ description: "Discord guild id (non-interactive Discord setup)" }),
		"discord-parent-channel-id": Flags.string({
			description: "Discord parent channel id (non-interactive Discord setup)",
		}),
		"slack-bot-token": Flags.string({ description: "Slack bot token (non-interactive Slack setup)" }),
		"slack-app-token": Flags.string({ description: "Slack app token (non-interactive Slack setup)" }),
		"slack-workspace-id": Flags.string({ description: "Slack workspace id (non-interactive Slack setup)" }),
		"slack-channel-id": Flags.string({ description: "Slack channel id (non-interactive Slack setup)" }),
		"slack-authorized-user-id": Flags.string({
			description: "Slack user id authorized for inbound replies and commands",
		}),
		"feishu-webhook-url": Flags.string({
			description: "Feishu custom-bot webhook URL (non-interactive Feishu setup)",
		}),
		"feishu-secret": Flags.string({ description: "Feishu webhook signing secret (optional)" }),
		"feishu-app-id": Flags.string({ description: "Feishu app id (non-interactive Feishu app setup)" }),
		"feishu-app-secret": Flags.string({ description: "Feishu app secret (non-interactive Feishu app setup)" }),
		"feishu-app-chat-id": Flags.string({ description: "Feishu chat id bound for inbound and outbound" }),
		"feishu-app-authorized-open-ids": Flags.string({
			description: "Comma-separated Feishu open_id allowlist for inbound replies and commands",
		}),
		redact: Flags.boolean({ description: "Enable redaction of remote notification content" }),
		provider: Flags.string({
			description: "notify health/test: select telegram, discord, slack, feishu, or feishu-app",
			options: ["telegram", "discord", "slack", "feishu", "feishu-app"],
		}),
		probe: Flags.boolean({ description: "notify health: run the selected provider's REST diagnostic" }),
		message: Flags.string({ description: "notify test: custom message body" }),
		"session-id": Flags.string({ description: "Live GJC session to bind to an existing Slack thread" }),
		"thread-ts": Flags.string({ description: "Existing Slack root thread timestamp" }),
		"owner-id": Flags.string({ description: "Internal: daemon owner id" }),
		"agent-dir": Flags.string({ description: "Internal: agent dir for the daemon" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Notify);
		const action = args.action ?? "status";
		if (!ACTIONS.includes(action as NotifyAction)) {
			console.error(`Unknown notify action: ${action}`);
			console.error(`Valid actions: ${ACTIONS.join(", ")}`);
			process.exit(1);
		}
		const extra = Array.isArray(args.extra) ? args.extra : args.extra ? [args.extra] : [];
		const cmd = notifyCommandArgsFromInvocation({ action, flags: flags as Record<string, unknown>, extra });
		// `bind-thread` and `activate-thread` have no positional or internal form:
		// any extra argument or unrelated notify flag is rejected here rather than
		// silently ignored.
		if (action === "bind-thread") assertStrictBindThreadInvocation(cmd);
		if (action === "activate-thread") assertStrictActivateThreadInvocation(cmd);
		if (action !== "daemon-internal") await initTheme();
		await runNotifyCliCommand(cmd);
	}
}

/**
 * Pure mapping from a parsed CLI invocation to the NotifyCommandArgs the
 * notify-cli implementation consumes. Every new provider flag must be both
 * declared in Notify.flags and mapped here, or the value is silently dropped.
 */
export function notifyCommandArgsFromInvocation(input: {
	action: string;
	flags: Record<string, unknown>;
	extra: string[];
}): NotifyCommandArgs {
	const { action, flags, extra } = input;
	const flagRec = flags;
	const ownerId = flagRec["owner-id"] as string | undefined;
	const agentDir = flagRec["agent-dir"] as string | undefined;
	const rawArgs = [
		...(flags.smoke ? ["--smoke"] : []),
		...(ownerId ? ["--owner-id", ownerId] : []),
		...(agentDir ? ["--agent-dir", agentDir] : []),
		...extra,
	];
	const positionalProvider = action === "setup" ? extra[0] : undefined;
	if (positionalProvider !== undefined && notifySetupProvider(positionalProvider) === undefined) {
		throw new Error(`Unknown notification provider: ${positionalProvider}`);
	}
	const providerFlag = flagRec.provider as string | undefined;
	if (providerFlag && action !== "health" && action !== "test") {
		throw new Error("--provider is valid only for notify health and notify test.");
	}
	if (action !== "setup" && action !== "daemon-internal" && extra.length > 0) {
		throw new Error(`Unexpected notify arguments: ${extra.join(" ")}`);
	}
	const provider = providerFlag ?? positionalProvider;
	return {
		action: action as NotifyAction,
		smoke: flags.smoke === true,
		rawArgs,
		provider: notifySetupProvider(provider),
		token: flags.token as string | undefined,
		chatId: flagRec["chat-id"] as string | undefined,
		discordBotToken: flagRec["discord-bot-token"] as string | undefined,
		discordApplicationId: flagRec["discord-application-id"] as string | undefined,
		discordGuildId: flagRec["discord-guild-id"] as string | undefined,
		discordParentChannelId: flagRec["discord-parent-channel-id"] as string | undefined,
		slackBotToken: flagRec["slack-bot-token"] as string | undefined,
		slackAppToken: flagRec["slack-app-token"] as string | undefined,
		slackWorkspaceId: flagRec["slack-workspace-id"] as string | undefined,
		slackChannelId: flagRec["slack-channel-id"] as string | undefined,
		slackAuthorizedUserId: flagRec["slack-authorized-user-id"] as string | undefined,
		feishuWebhookUrl: flagRec["feishu-webhook-url"] as string | undefined,
		feishuSecret: flagRec["feishu-secret"] as string | undefined,
		feishuAppId: flagRec["feishu-app-id"] as string | undefined,
		feishuAppSecret: flagRec["feishu-app-secret"] as string | undefined,
		feishuAppChatId: flagRec["feishu-app-chat-id"] as string | undefined,
		feishuAppAuthorizedOpenIds: flagRec["feishu-app-authorized-open-ids"] as string | undefined,
		redact: flags.redact === true,
		probe: flags.probe === true,
		message: flags.message as string | undefined,
		sessionId: flagRec["session-id"] as string | undefined,
		threadTs: flagRec["thread-ts"] as string | undefined,
	};
}
