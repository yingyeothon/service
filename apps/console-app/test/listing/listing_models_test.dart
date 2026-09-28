import 'package:yyt_console/listing/listing_models.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parseListingTags splits, lowercases, deduplicates in order', () {
    expect(parseListingTags(' Puzzle, multiplayer  #puzzle\nco-op '), [
      'puzzle',
      'multiplayer',
      'co-op',
    ]);
    expect(parseListingTags(''), isEmpty);
  });

  test('badListingTag names the first slug the grammar refuses', () {
    expect(badListingTag(['ok', 'a-1']), isNull);
    expect(badListingTag(['ok', 'bad_tag', 'Bad']), 'bad_tag');
    expect(badListingTag(['a' * 33]), 'a' * 33);
  });

  group('buildListingBody', () {
    test('trims, clears an empty summary, sends the wire audience', () {
      expect(
        buildListingBody(
          title: '  My Game ',
          summary: '  ',
          tagsText: 'b, a',
          audience: ListingAudience.members,
        ),
        {
          'title': 'My Game',
          'summary': null,
          'tags': ['b', 'a'],
          'audience': 'members',
        },
      );
    });

    Matcher refuses(String field) =>
        throwsA(isA<ListingFormError>().having((e) => e.field, 'field', field));

    test('refuses what the server would', () {
      expect(
        () => buildListingBody(
          title: ' ',
          summary: '',
          tagsText: '',
          audience: ListingAudience.public,
        ),
        refuses('title'),
      );
      expect(
        () => buildListingBody(
          title: 'x' * 101,
          summary: '',
          tagsText: '',
          audience: ListingAudience.public,
        ),
        refuses('title'),
      );
      expect(
        () => buildListingBody(
          title: 'a\tb',
          summary: '',
          tagsText: '',
          audience: ListingAudience.public,
        ),
        refuses('title'),
      );
      expect(
        () => buildListingBody(
          title: 'ok',
          summary: 'x' * 2001,
          tagsText: '',
          audience: ListingAudience.public,
        ),
        refuses('summary'),
      );
      expect(
        () => buildListingBody(
          title: 'ok',
          summary: '',
          tagsText: 'bad_tag',
          audience: ListingAudience.public,
        ),
        refuses('tags'),
      );
      expect(
        () => buildListingBody(
          title: 'ok',
          summary: '',
          tagsText: List.generate(11, (i) => 't$i').join(' '),
          audience: ListingAudience.public,
        ),
        refuses('tags'),
      );
    });
  });

  test('CatalogListing.fromJson reads the server view', () {
    final l = CatalogListing.fromJson({
      'appId': 'ca_1',
      'appName': 'game',
      'teamId': 'team_1',
      'teamName': 'crew',
      'title': 'Game',
      'summary': null,
      'tags': ['a', 1],
      'audience': 'members',
      'publishedBy': 'me',
      'publishedAt': 1700000000,
      'updatedAt': 1700000100,
      'takenDown': true,
    });
    expect(l.audience, ListingAudience.members);
    expect(l.tags, ['a']);
    expect(l.takenDown, isTrue);
    expect(l.summary, isNull);
    expect(ListingAudience.parse('nonsense'), ListingAudience.public);
  });

  test('Team.canPublish: seats and the seatless platform admin', () {
    Team of(String role) => Team(id: 't', name: 't', role: role);
    expect(of('owner').canPublish, isTrue);
    expect(of('member').canPublish, isTrue);
    expect(of('admin').canPublish, isTrue);
    expect(of('pending').canPublish, isFalse);
    expect(of('reader').canPublish, isFalse);
  });
}
