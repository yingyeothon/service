import { notifications } from "@mantine/notifications";

/*
 * Success feedback is a toast with a fixed vocabulary, so the button that
 * said `Create team` yields the toast `Team created`. Errors never go here:
 * they stay inline next to the form that failed.
 */

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function show(message: string) {
  notifications.show({
    message,
    color: "ink",
    autoClose: 4000,
    withBorder: true,
  });
}

export const notify = {
  created: (noun: string) => show(`${cap(noun)} created`),
  saved: (noun: string) => show(`${cap(noun)} saved`),
  deleted: (noun: string) => show(`${cap(noun)} deleted`),
  /** A verb of its own: "Secret rotated", "Vote closed". */
  done: (message: string) => show(message),
};
