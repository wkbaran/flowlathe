import { Client, Events, GatewayIntentBits } from "discord.js";

export interface DiscordGatewayMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
}

/**
 * A thin seam over `discord.js`'s `Client`, so `DiscordTriggerSource` (discord.ts) can be driven
 * in tests by an injected fake instead of a real gateway connection — see
 * PLAN-INTEGRATIONS.md §8's "Drive DiscordTriggerSource through an injected event emitter."
 * Separate methods per event (rather than a generic `on(event, listener)` overload) to sidestep
 * TypeScript overload-resolution friction for no real benefit — this interface has exactly three
 * events and always will.
 */
export interface DiscordGateway {
  onMessage(listener: (message: DiscordGatewayMessage) => void): void;
  /** Fires once, with the bot's own user id — used for the self-message loop guard and to know
   *  when it's safe to run the post-reconnect recovery scan. */
  onReady(listener: (botUserId: string) => void): void;
  onError(listener: (err: Error) => void): void;
  login(token: string): Promise<unknown>;
  destroy(): Promise<void>;
}

export type DiscordGatewayFactory = (token: string) => DiscordGateway;

/**
 * The real implementation. `message_content` is a **privileged** Gateway Intent — without it
 * enabled in the Discord Developer Portal, the bot either fails to connect or silently receives
 * empty message bodies. This is the single most common Discord-bot setup failure (see
 * `describePrivilegedIntentsGuidance` in discord.ts, surfaced through `onError`).
 */
export function createDiscordJsGateway(): DiscordGateway {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  return {
    onMessage(listener) {
      client.on(Events.MessageCreate, (message) => {
        listener({
          id: message.id,
          channelId: message.channelId,
          authorId: message.author.id,
          authorIsBot: message.author.bot,
          content: message.content,
        });
      });
    },
    onReady(listener) {
      client.once(Events.ClientReady, (ready) => listener(ready.user.id));
    },
    onError(listener) {
      client.on(Events.Error, listener);
    },
    login: (token) => client.login(token),
    destroy: () => client.destroy(),
  };
}
