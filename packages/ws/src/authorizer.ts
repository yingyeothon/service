import type { APIGatewayAuthorizerResult } from "aws-lambda";

export type AuthorizerResult = APIGatewayAuthorizerResult;

function policy(
  principalId: string,
  effect: "Allow" | "Deny",
  methodArn: string,
  context?: Record<string, string | number | boolean>,
): AuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Action: "execute-api:Invoke", Effect: effect, Resource: methodArn },
      ],
    },
    ...(context ? { context } : {}),
  };
}

/** Allow `$connect`; `context` values become `event.requestContext.authorizer.*` downstream. */
export function allowPolicy(
  principalId: string,
  methodArn: string,
  context?: Record<string, string | number | boolean>,
): AuthorizerResult {
  return policy(principalId, "Allow", methodArn, context);
}

export function denyPolicy(methodArn: string): AuthorizerResult {
  return policy("anonymous", "Deny", methodArn);
}
