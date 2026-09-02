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
import { EmptyState } from "./EmptyState";
import { Loading } from "./Loading";

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
      mb="md"
      aria-label="Sort entries"
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
        <Loading />
      </>
    );
  if (entries.length === 0)
    return (
      <>
        {toggle}
        <EmptyState title="Nothing on the wall yet." />
      </>
    );
  return (
    <>
      {toggle}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
        {entries.map((e) => (
          <Card key={e.id} padding="md">
            <Stack gap={8}>
              {e.shots[0] ? (
                <Image
                  src={e.shots[0].url}
                  h={160}
                  fit="cover"
                  alt=""
                  radius="sm"
                  loading="lazy"
                />
              ) : (
                <Group
                  h={160}
                  justify="center"
                  style={{
                    background: "var(--yyt-surface-soft)",
                    borderRadius: 6,
                  }}
                >
                  <Text size="xs" c="dimmed">
                    No screenshot
                  </Text>
                </Group>
              )}
              <Anchor
                component={Link}
                to={`/shows/${e.showId}/entries/${e.id}`}
                fw={500}
                size="lg"
              >
                {e.title}
              </Anchor>
              <Group gap="xs">
                <Badge size="xs">{e.target.kind}</Badge>
                <Text size="xs" c={e.target.available ? undefined : "dimmed"}>
                  {e.target.name}
                  {e.target.available ? "" : " (no longer available)"}
                </Text>
              </Group>
              <Group gap="md" className="tabular">
                <Group gap={4}>
                  <IconHeart size={14} aria-hidden="true" />
                  <Text size="xs" aria-label={`${e.likes} likes`}>
                    {e.likes}
                  </Text>
                </Group>
                <Group gap={4}>
                  <IconMessage size={14} aria-hidden="true" />
                  <Text size="xs" aria-label={`${e.commentCount} comments`}>
                    {e.commentCount}
                  </Text>
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
        <Button variant="default" mt="md" onClick={onMore}>
          Load more
        </Button>
      )}
    </>
  );
}
