import {
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Image,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { IconHeart, IconMessage } from "@tabler/icons-react";
import { Link } from "react-router";
import { fmtTime } from "../lib/format";
import type { ShowEntry } from "../types";

/**
 * The card grid with its sort toggle, shared by the show page and the event
 * page. Deliberately not a link to the target: a card links to the entry, and
 * the entry page is what carries the exhibited link and its "no longer
 * available" state.
 */
export function EntryGrid({
  entries,
  sort,
  onSort,
  loading,
  onMore,
}: {
  entries: ShowEntry[];
  sort?: "new" | "likes";
  onSort?: (sort: "new" | "likes") => void;
  loading?: boolean;
  /** Present when the API said there is another page. */
  onMore?: () => void;
}) {
  const toggle = onSort && sort && (
    <SegmentedControl
      size="xs"
      mb="xs"
      value={sort}
      onChange={(v) => onSort(v as "new" | "likes")}
      data={[
        { value: "new", label: "Newest" },
        { value: "likes", label: "Most liked" },
      ]}
    />
  );
  if (loading)
    return (
      <>
        {toggle}
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      </>
    );
  if (entries.length === 0)
    return (
      <>
        {toggle}
        <Text size="sm" c="dimmed">
          Nothing on the wall yet.
        </Text>
      </>
    );
  return (
    <>
      {toggle}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {entries.map((e) => (
          <Card key={e.id} withBorder padding="sm">
            <Stack gap={6}>
              {e.shots[0] ? (
                <Image
                  src={e.shots[0].url}
                  h={140}
                  fit="cover"
                  alt=""
                  radius="sm"
                />
              ) : (
                <Text size="xs" c="dimmed" h={140}>
                  No screenshot
                </Text>
              )}
              <Anchor
                component={Link}
                to={`/shows/${e.showId}/entries/${e.id}`}
                fw={600}
              >
                {e.title}
              </Anchor>
              <Group gap="xs">
                <Badge size="xs" variant="light">
                  {e.target.kind}
                </Badge>
                <Text size="xs" c={e.target.available ? undefined : "dimmed"}>
                  {e.target.name}
                  {e.target.available ? "" : " (no longer available)"}
                </Text>
              </Group>
              <Group gap="md">
                <Group gap={4}>
                  <IconHeart size={14} />
                  <Text size="xs">{e.likes}</Text>
                </Group>
                <Group gap={4}>
                  <IconMessage size={14} />
                  <Text size="xs">{e.commentCount}</Text>
                </Group>
                <Text size="xs" c="dimmed">
                  {e.createdBy ?? "—"} · {fmtTime(e.createdAt)}
                </Text>
              </Group>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>
      {onMore && (
        <Button size="compact-sm" variant="default" mt="sm" onClick={onMore}>
          Load more
        </Button>
      )}
    </>
  );
}
