/* Lambda entry points. The only module besides env.ts touching process/console. */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { createJwtRequestAuthorizer } from "@yingyeothon/lambda-authorizer-jwt";
import {
  createGamebaseContext,
  gamebaseOptionsFromEnv,
  handleConnect,
  handleDisconnect,
  handleMessages,
  saveActorStartEvent,
  type GameActorStartEvent,
} from "@yingyeothon/lambda-gamebase";
import { createConsoleLogger } from "@yingyeothon/logger";
import { redisSet } from "@yingyeothon/naive-redis";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
  APIGatewayProxyResultV2,
  APIGatewayRequestAuthorizerHandler,
} from "aws-lambda";
import {
  DEFAULT_RUNNING_SECONDS,
  DEFAULT_WAITING_SECONDS,
  LIFETIME_MARGIN_SECONDS,
  runDungeonActor,
} from "./actor.js";
import { keyPrefixes, readDungeonEnv } from "./env.js";
import { isClientMessage, type DungeonMessage } from "./game.js";
import { createLobbyHandler } from "./lobby.js";
import { createTopicLobbyHandler } from "./topicLobby.js";

const env = readDungeonEnv();
const prefixes = keyPrefixes(env.redisKeyPrefix);
const logger = createConsoleLogger("info");
const context = createGamebaseContext(gamebaseOptionsFromEnv());

/* REQUEST authorizer on $connect: verifies the auth service's JWT unchanged. */
export const authorizer: APIGatewayRequestAuthorizerHandler =
  createJwtRequestAuthorizer({
    jwtSecret: env.jwtSecret,
    verifyOptions: { issuer: env.jwtIssuer, audience: env.jwtAudience },
    logger,
  });

function resolveMemberId(event: APIGatewayProxyEvent): string | undefined {
  const memberId: unknown = event.requestContext.authorizer?.["memberId"];
  return typeof memberId === "string" && memberId !== "" ? memberId : undefined;
}

export async function ws(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  switch (event.requestContext.routeKey) {
    case "$connect":
      return handleConnect({
        event,
        context,
        logger,
        connectionIdAndGameIdKeyPrefix: prefixes.connectionIdAndGameIdKeyPrefix,
        actorEventKeyPrefix: prefixes.eventKeyPrefix,
        actorQueueKeyPrefix: prefixes.queueKeyPrefix,
        resolveMemberId,
        selectSubprotocol: (offered) =>
          offered.includes("bearer") ? "bearer" : undefined,
      });
    case "$disconnect":
      return handleDisconnect({
        event,
        context,
        logger,
        connectionIdAndGameIdKeyPrefix: prefixes.connectionIdAndGameIdKeyPrefix,
        actorQueueKeyPrefix: prefixes.queueKeyPrefix,
      });
    default:
      return handleMessages<DungeonMessage>({
        event,
        context,
        logger,
        connectionIdAndGameIdKeyPrefix: prefixes.connectionIdAndGameIdKeyPrefix,
        actorQueueKeyPrefix: prefixes.queueKeyPrefix,
        validateMessage: isClientMessage,
      });
  }
}

export async function actor(event: GameActorStartEvent): Promise<void> {
  await runDungeonActor({
    event,
    context,
    logger,
    redisKeyPrefix: env.redisKeyPrefix,
  });
}

const lambda = new LambdaClient({});
const startEventTtlSeconds =
  DEFAULT_WAITING_SECONDS + DEFAULT_RUNNING_SECONDS + LIFETIME_MARGIN_SECONDS;

export const matchCallback = createLobbyHandler({
  matchApiKey: env.matchApiKey,
  wsUrl: env.wsUrl,
  log: (m, meta) => logger.info(m, meta),
  saveStartEvent: (startEvent) =>
    saveActorStartEvent({
      event: startEvent,
      eventKeyPrefix: prefixes.eventKeyPrefix,
      set: (key, value) =>
        redisSet(context.getRedisConnection(), key, value, {
          expirationMillis: startEventTtlSeconds * 1000,
        }),
    }),
  startActor: (startEvent) =>
    lambda.send(
      new InvokeCommand({
        FunctionName: env.actorFunctionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(startEvent)),
      }),
    ),
});

/* Server-less alternative: the party gets a topic room instead of an actor. */
export const matchCallbackTopic: (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyResultV2> = env.topic
  ? createTopicLobbyHandler({
      matchApiKey: env.topic.matchApiKey,
      topicBaseUrl: env.topic.baseUrl,
      topicApiKey: env.topic.apiKey,
      log: (m, meta) => logger.info(m, meta),
    })
  : async () => ({
      statusCode: 503,
      body: "TOPIC_BASE_URL/TOPIC_API_KEY not set",
    });
