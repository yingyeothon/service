import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

/** Publishes `subject`/`message` to the stage's alarm topic. */
export type AlarmNotify = (subject: string, message: string) => Promise<void>;

const snsClients = new Map<string, SNSClient>();

/**
 * Publisher for the stage's alarm topic; `undefined` when the stage has none
 * (`topicArn` empty). The default is bounded like the CloudWatch reads (the
 * probe and the CDN guard wait on it); a request path passes a tighter bound.
 * Shared by `handler.ts` and `probe-handler.ts`, which pass the ARN in.
 */
export function createAlarmNotify(
  topicArn: string,
  {
    attempts = 2,
    timeoutMs = 5000,
  }: { attempts?: number; timeoutMs?: number } = {},
): AlarmNotify | undefined {
  if (!topicArn) return undefined;
  const k = `${attempts}:${timeoutMs}`;
  let sns = snsClients.get(k);
  if (!sns) {
    sns = new SNSClient({
      maxAttempts: attempts,
      requestHandler: {
        requestTimeout: timeoutMs,
        connectionTimeout: Math.min(3000, timeoutMs),
      },
    });
    snsClients.set(k, sns);
  }
  const client = sns;
  return async (subject, message) => {
    await client.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: subject,
        Message: message,
      }),
    );
  };
}
