import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type { SlackMemberChannelEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

const DEFAULT_BOT_JOIN_PROMPT =
  "I've just been added to this channel. I'd like to set myself up properly here. " +
  "Could you let me know: " +
  "1) Should I require a direct @mention to respond, or respond to all messages in this channel? " +
  "2) Should I respond to messages from everyone, or only specific users?";

export function registerSlackMemberEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  account: ResolvedSlackAccount;
  handleSlackMessage?: SlackMessageHandler;
}) {
  const { ctx, trackEvent, account, handleSlackMessage } = params;

  const handleMemberChannelEvent = async (params: {
    verb: "joined" | "left";
    event: SlackMemberChannelEvent;
    body: unknown;
  }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(params.body)) {
        return;
      }
      trackEvent?.();
      const payload = params.event;
      const channelId = payload.channel;
      const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
      const channelType = payload.channel_type ?? channelInfo?.type;
      // When the bot itself joins a channel and onBotJoinChannel is enabled,
      // trigger an AI response before the normal system-event auth gate so
      // the bot-join greeting works even in channels with user allowlists
      // (the bot's own ID would otherwise be blocked by the allowlist check).
      if (params.verb === "joined") {
        const isBotJoin = Boolean(ctx.botUserId && payload.user === ctx.botUserId);
        const onBotJoinCfg = account.config.onBotJoinChannel;
        if (isBotJoin && onBotJoinCfg?.enabled && handleSlackMessage && channelId) {
          const prompt = onBotJoinCfg.prompt?.trim() || DEFAULT_BOT_JOIN_PROMPT;
          const syntheticMessage: SlackMessageEvent = {
            type: "message",
            channel: channelId,
            channel_type: (channelType ?? "channel") as SlackMessageEvent["channel_type"],
            user: ctx.botUserId,
            text: prompt,
            ts: payload.event_ts ?? String(Date.now() / 1000),
          };
          await handleSlackMessage(syntheticMessage, {
            source: "app_mention",
            wasMentioned: true,
            bypassUserAuth: true,
          });
        }
      }

      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx,
        senderId: payload.user,
        channelId,
        channelType,
        eventKind: `member-${params.verb}`,
      });
      if (!ingressContext) {
        return;
      }
      const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
      const userLabel = userInfo?.name ?? payload.user ?? "someone";
      enqueueSystemEvent(`Slack: ${userLabel} ${params.verb} ${ingressContext.channelLabel}.`, {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:member:${params.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack ${params.verb} handler failed: ${String(err)}`));
    }
  };

  ctx.app.event(
    "member_joined_channel",
    async ({ event, body }: SlackEventMiddlewareArgs<"member_joined_channel">) => {
      await handleMemberChannelEvent({
        verb: "joined",
        event: event as SlackMemberChannelEvent,
        body,
      });
    },
  );

  ctx.app.event(
    "member_left_channel",
    async ({ event, body }: SlackEventMiddlewareArgs<"member_left_channel">) => {
      await handleMemberChannelEvent({
        verb: "left",
        event: event as SlackMemberChannelEvent,
        body,
      });
    },
  );
}
