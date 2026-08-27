/* The game actor: one Lambda invocation per match, driven by tslib's loop. */
import { runGameAllTogether } from "@yingyeothon/gamebase-all-together";
import {
  broadcast,
  handleActor,
  reply,
  type GamebaseContext,
  type GameActorStartEvent,
  type Transport,
} from "@yingyeothon/lambda-gamebase";
import type { Logger } from "@yingyeothon/logger";
import { keyPrefixes } from "./env.js";
import {
  attack,
  createDungeon,
  isCleared,
  snapshot,
  type DungeonMessage,
} from "./game.js";

export interface DungeonActorOptions {
  event: GameActorStartEvent;
  context: GamebaseContext;
  redisKeyPrefix: string;
  /**
   * Where the clients' sockets live. Absent = API Gateway through `context`;
   * in gateway mode it is `createRedisPubSubTransport` on the `q` channel.
   */
  transport?: Transport;
  logger: Logger;
  /** Wait for the party, then play. Keep the sum under the Lambda timeout. */
  gameWaitingSeconds?: number;
  gameRunningSeconds?: number;
}

export const DEFAULT_WAITING_SECONDS = 20;
export const DEFAULT_RUNNING_SECONDS = 120;
/** Lambda timeout must exceed waiting + running + this margin. */
export const LIFETIME_MARGIN_SECONDS = 20;

export async function runDungeonActor({
  event,
  context,
  redisKeyPrefix,
  transport,
  logger,
  gameWaitingSeconds = DEFAULT_WAITING_SECONDS,
  gameRunningSeconds = DEFAULT_RUNNING_SECONDS,
}: DungeonActorOptions): Promise<void> {
  const prefixes = keyPrefixes(redisKeyPrefix);
  const network = transport ? { transport } : { context };
  await handleActor<DungeonMessage>({
    event,
    context,
    logger,
    eventKeyPrefix: prefixes.eventKeyPrefix,
    awaiterKeyPrefix: prefixes.awaiterKeyPrefix,
    queueKeyPrefix: prefixes.queueKeyPrefix,
    lockKeyPrefix: prefixes.lockKeyPrefix,
    lifetimeSeconds:
      gameWaitingSeconds + gameRunningSeconds + LIFETIME_MARGIN_SECONDS,
    gameMain: (options) => {
      const state = createDungeon(options.members.length);
      type Ctx = { connectedUsers: Record<string, { memberId: string }> };
      const memberOf = (ctx: Ctx, connectionId: string) =>
        ctx.connectedUsers[connectionId]?.memberId;
      const connections = (ctx: Ctx) => Object.keys(ctx.connectedUsers);
      const party = (ctx: Ctx) => [
        ...new Set(Object.values(ctx.connectedUsers).map((u) => u.memberId)),
      ];
      return runGameAllTogether<DungeonMessage>({
        ...options,
        network,
        logger,
        gameWaitingSeconds,
        gameRunningSeconds,
        pollIntervalMillis: 100,
        snapshotIntervalMillis: 1000,
        // A partial match (timeout with fewer players) must still start.
        minPlayers: 1,
        isGameOver: () => isCleared(state),
        processMessage: async ({ context: ctx, message }) => {
          if (message.type !== "attack") return;
          const memberId = memberOf(ctx, message.connectionId);
          if (!memberId) return;
          const dealt = attack(state, memberId, message.power);
          await broadcast(
            connections(ctx),
            { type: "hit", payload: { memberId, dealt, bossHp: state.bossHp } },
            network,
          );
        },
        onMemberEntered: async ({ context: ctx, connectionId, memberId }) => {
          await broadcast(
            connections(ctx),
            { type: "enter", payload: { memberId } },
            network,
          );
          // Also the resync point for a reconnect.
          await reply(connectionId, snapshot(state, party(ctx)), network);
        },
        onSnapshot: async ({ context: ctx }) => {
          await broadcast(
            connections(ctx),
            snapshot(state, party(ctx)),
            network,
          );
        },
        onGameEnd: async ({ context: ctx, reason }) => {
          logger.info("dungeon ended", { gameId: options.gameId, reason });
          await broadcast(
            connections(ctx),
            { type: "result", payload: { reason, damage: state.damage } },
            network,
          );
        },
      });
    },
  });
}
