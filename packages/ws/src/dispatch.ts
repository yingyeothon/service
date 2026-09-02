import { AppError, nullLogger, type Logger } from "@yyt/core";
import type {
  APIGatewayProxyResult,
  APIGatewayProxyWebsocketEventV2,
} from "aws-lambda";
import type { Poster } from "./poster.js";

/**
 * A `poster.send` that logs instead of throwing. Terminal messages must not
 * take the handler down with them, and the socket is left open on purpose:
 * closing right after `PostToConnection` races the delivery.
 */
export function quietPoster(
  poster: Pick<Poster, "send">,
  logger: Logger = nullLogger,
): (connId: string, message: unknown) => Promise<void> {
  return async (connId, message) => {
    try {
      await poster.send(connId, message);
    } catch (e) {
      logger.warn("post failed", {
        connId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
}

type WsHandler = (
  event: APIGatewayProxyWebsocketEventV2,
) => Promise<APIGatewayProxyResult>;

export interface WsDispatcherOptions {
  connect: WsHandler;
  disconnect: WsHandler;
  /** Every route key other than `$connect`/`$disconnect`. */
  message: WsHandler;
  logger?: Logger;
}

/**
 * The WebSocket entry point shared by the socket stacks: route on
 * `routeKey`, map an `AppError` to its status (anything else is a 500), log
 * 5xx as errors and 4xx as rejections, and answer with an empty body.
 */
export function createWsDispatcher({
  connect,
  disconnect,
  message,
  logger = nullLogger,
}: WsDispatcherOptions): WsHandler {
  return async (event) => {
    const route = event.requestContext.routeKey;
    try {
      if (route === "$connect") return await connect(event);
      if (route === "$disconnect") return await disconnect(event);
      return await message(event);
    } catch (e) {
      const status = e instanceof AppError ? e.status : 500;
      if (status >= 500)
        logger.error("ws handler error", {
          route,
          message: e instanceof Error ? e.message : String(e),
        });
      else logger.info("ws handler rejected", { route, status });
      return { statusCode: status, body: "" };
    }
  };
}
