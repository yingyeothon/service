/* The dungeon actor: one Lambda invocation per run, driven by tslib's loop at 5 Hz. */
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
import {
  isEmptyDelta,
  newCharacter,
  type CharacterSheet,
  type ResultDelta,
} from "./character.js";
import { keyPrefixes } from "./env.js";
import type { MapBundle } from "./map.js";
import {
  TICK_MILLIS,
  createSim,
  frame,
  handle,
  isClientCommand,
  results,
  step,
  type ClientCommand,
  type Sim,
} from "./sim.js";

export type DungeonMessage =
  | (ClientCommand & { connectionId: string })
  | { type: "enter"; connectionId: string; memberId: string }
  | { type: "leave"; connectionId: string };

export type CommitStatus =
  "applied" | "duplicate" | "failed" | "pending" | "skipped";

export interface DungeonActorOptions {
  event: GameActorStartEvent;
  context: GamebaseContext;
  redisKeyPrefix: string;
  /** The `q` channel transport (`createRedisPubSubTransport`). */
  transport: Transport;
  logger: Logger;
  loadMap: () => Promise<MapBundle>;
  loadCharacter: (memberId: string) => Promise<CharacterSheet | undefined>;
  /** Commits one member's delta; returns whether it was applied or a duplicate. */
  commit: (
    memberId: string,
    gameId: string,
    delta: ResultDelta,
  ) => Promise<"applied" | "duplicate">;
  /** Keeps a delta the commit could not land, for an operator to replay (idempotent by gameId). */
  parkCommit?: (
    memberId: string,
    gameId: string,
    delta: ResultDelta,
  ) => Promise<unknown>;
  gameWaitingSeconds?: number;
  gameRunningSeconds?: number;
  /** The commit phase must fit the lifetime margin; slower commits are parked as `pending`. */
  commitDeadlineMillis?: number;
  rng?: () => number;
}

export const DEFAULT_WAITING_SECONDS = 20;
export const DEFAULT_RUNNING_SECONDS = 600;
/** Lambda timeout must exceed waiting + running + this margin. */
export const LIFETIME_MARGIN_SECONDS = 20;
export const DEFAULT_COMMIT_DEADLINE_MILLIS = 10000;
/** The 900 s Lambda ceiling, minus what the wait stage and the margin need. */
export const MAX_RUNNING_SECONDS =
  900 - DEFAULT_WAITING_SECONDS - LIFETIME_MARGIN_SECONDS - 60;

/**
 * Commits every entered member concurrently under one deadline. A member whose
 * commit is still running at the deadline is `pending` (and parked); one whose
 * commit threw is `failed` (parked too). Both leave the delta in the log.
 */
export async function commitAll({
  gameId,
  deltas,
  entered,
  commit,
  parkCommit,
  deadlineMillis,
  logger,
}: {
  gameId: string;
  deltas: Record<string, ResultDelta>;
  entered: Set<string>;
  commit: DungeonActorOptions["commit"];
  parkCommit?: DungeonActorOptions["parkCommit"];
  deadlineMillis: number;
  logger: Logger;
}): Promise<Record<string, CommitStatus>> {
  const committed: Record<string, CommitStatus> = {};
  const park = async (memberId: string, delta: ResultDelta) => {
    try {
      await parkCommit?.(memberId, gameId, delta);
    } catch (e) {
      logger.error("park failed", {
        gameId,
        memberId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const jobs = Object.entries(deltas).map(async ([memberId, delta]) => {
    if (!entered.has(memberId) || isEmptyDelta(delta)) {
      committed[memberId] = "skipped";
      return;
    }
    committed[memberId] = "pending";
    try {
      committed[memberId] = await commit(memberId, gameId, delta);
    } catch (e) {
      committed[memberId] = "failed";
      logger.error("commit failed", {
        gameId,
        memberId,
        delta,
        error: e instanceof Error ? e.message : String(e),
      });
      await park(memberId, delta);
    }
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMillis);
  });
  await Promise.race([Promise.all(jobs), deadline]);
  clearTimeout(timer);
  for (const [memberId, status] of Object.entries(committed))
    if (status === "pending") {
      logger.error("commit pending at deadline", {
        gameId,
        memberId,
        delta: deltas[memberId],
      });
      await park(memberId, deltas[memberId]!);
    }
  return committed;
}

export async function runDungeonActor({
  event,
  context,
  redisKeyPrefix,
  transport,
  logger,
  loadMap,
  loadCharacter,
  commit,
  parkCommit,
  gameWaitingSeconds = DEFAULT_WAITING_SECONDS,
  gameRunningSeconds = DEFAULT_RUNNING_SECONDS,
  commitDeadlineMillis = DEFAULT_COMMIT_DEADLINE_MILLIS,
  rng,
}: DungeonActorOptions): Promise<void> {
  const prefixes = keyPrefixes(redisKeyPrefix);
  const network = { transport };
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
    gameMain: async (options) => {
      // Everything the run needs is fetched once, before the wait stage. A
      // failure here must still end in a `result` frame and dropped sockets —
      // the party already holds a wsUrl — so the loop runs with an empty world
      // that is over the moment it starts.
      let sim: Sim | undefined;
      let setupError: string | undefined;
      try {
        const map = await loadMap();
        const members = await Promise.all(
          options.members.map(async (m) => ({
            id: m.memberId,
            sheet: (await loadCharacter(m.memberId)) ?? newCharacter(),
          })),
        );
        sim = createSim(map, members, rng);
      } catch (e) {
        setupError = e instanceof Error ? e.message : String(e);
        logger.error("dungeon setup failed", {
          gameId: options.gameId,
          error: setupError,
        });
      }
      type Ctx = { connectedUsers: Record<string, { memberId: string }> };
      const memberOf = (ctx: Ctx, connectionId: string) =>
        ctx.connectedUsers[connectionId]?.memberId;
      const connections = (ctx: Ctx) => Object.keys(ctx.connectedUsers);
      // Only members who actually entered get a commit: a roster member who
      // never connected has nothing to gain and must not be written to.
      const entered = new Set<string>();
      return runGameAllTogether<DungeonMessage>({
        ...options,
        network,
        logger,
        gameWaitingSeconds,
        gameRunningSeconds,
        pollIntervalMillis: 50,
        tick: { mode: "fixed", intervalMillis: TICK_MILLIS },
        snapshotIntervalMillis: TICK_MILLIS,
        minPlayers: 1,
        // Pub/sub has no redelivery: repeat the end frame and the drop (tslib docs).
        endRepeatCount: 2,
        isGameOver: () => !sim || sim.cleared,
        updateTimeDelta: async ({ delta }) => {
          if (sim) step(sim, delta);
        },
        processMessage: async ({ context: ctx, message }) => {
          const memberId = memberOf(ctx, message.connectionId);
          if (!sim || !memberId || !isClientCommand(message)) return;
          const refused = handle(sim, memberId, message);
          if (refused)
            await reply(
              message.connectionId,
              {
                type: "refused",
                payload: { command: message.type, code: refused },
              },
              network,
            );
        },
        onMemberEntered: async ({ context: ctx, connectionId, memberId }) => {
          entered.add(memberId);
          await broadcast(
            connections(ctx),
            { type: "enter", payload: { memberId } },
            network,
          );
          if (!sim) return;
          // Also the reconnect resync: one frame is the whole world. The
          // events stay for the tick broadcast (`drain: false`).
          await reply(
            connectionId,
            {
              type: "hello",
              payload: {
                gameId: options.gameId,
                mapId: sim.map.id,
                mapVersion: sim.map.version,
                you: memberId,
              },
            },
            network,
          );
          await reply(connectionId, frame(sim, { drain: false }), network);
        },
        onSnapshot: async ({ context: ctx }) => {
          if (sim) await broadcast(connections(ctx), frame(sim), network);
        },
        onGameEnd: async ({ context: ctx, reason }) => {
          const deltas = sim ? results(sim) : {};
          // Commit before the result frame so a client returning to the lobby
          // reads the persisted sheet (README §4.3). A run nobody joined has
          // nothing to commit.
          const committed =
            sim && reason !== "notEnoughPlayers"
              ? await commitAll({
                  gameId: options.gameId,
                  deltas,
                  entered,
                  commit,
                  parkCommit,
                  deadlineMillis: commitDeadlineMillis,
                  logger,
                })
              : {};
          const cleared = sim?.cleared ?? false;
          logger.info("dungeon ended", {
            gameId: options.gameId,
            reason: setupError ? "error" : reason,
            cleared,
            committed,
          });
          await broadcast(
            connections(ctx),
            {
              type: "result",
              payload: {
                reason: setupError ? "error" : reason,
                cleared,
                rewards: deltas,
                committed,
              },
            },
            network,
          );
        },
      });
    },
  });
}
