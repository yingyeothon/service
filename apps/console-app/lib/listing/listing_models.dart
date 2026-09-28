// A catalog listing (docs/decisions.md *Catalog listings*): how a team
// publishes an app — to everyone or to the platform members it names — and
// the grammar the server enforces on it (services/console/src/listings.ts).

/// Server caps, mirrored so the form can refuse before the round trip.
const listingTitleMaxLength = 100;
const listingSummaryMaxLength = 2000;
const listingTagsMax = 10;
const listingViewersMax = 100;

/// `LISTING_TAG` of @yyt/console-db: a lowercase slug of 1–32 characters.
final listingTagPattern = RegExp(r'^[a-z0-9-]{1,32}$');

enum ListingAudience {
  public,
  members;

  static ListingAudience parse(Object? v) => switch (v) {
    'members' => ListingAudience.members,
    _ => ListingAudience.public,
  };

  String get wire => name;

  String get label => switch (this) {
    ListingAudience.public => '모든 사용자',
    ListingAudience.members => '지정 멤버',
  };
}

class CatalogListing {
  const CatalogListing({
    required this.appId,
    required this.appName,
    required this.title,
    required this.summary,
    required this.tags,
    required this.audience,
    required this.publishedBy,
    required this.publishedAt,
    required this.updatedAt,
    required this.takenDown,
  });

  final String appId;
  final String appName;
  final String title;
  final String? summary;
  final List<String> tags;
  final ListingAudience audience;
  final String? publishedBy;
  final int publishedAt;
  final int updatedAt;

  /// A platform admin hid it: the team may edit or unpublish, not republish.
  final bool takenDown;

  factory CatalogListing.fromJson(Map<String, dynamic> j) => CatalogListing(
    appId: (j['appId'] as String?) ?? '',
    appName: (j['appName'] as String?) ?? '',
    title: (j['title'] as String?) ?? '',
    summary: j['summary'] as String?,
    tags: [
      for (final t in (j['tags'] as List<dynamic>? ?? const []))
        if (t is String) t,
    ],
    audience: ListingAudience.parse(j['audience']),
    publishedBy: j['publishedBy'] as String?,
    publishedAt: (j['publishedAt'] as num?)?.toInt() ?? 0,
    updatedAt: (j['updatedAt'] as num?)?.toInt() ?? 0,
    takenDown: j['takenDown'] == true,
  );
}

/// A member a `members` listing names; `login` is null once the member row
/// is gone.
class ListingViewer {
  const ListingViewer({
    required this.login,
    required this.addedBy,
    required this.addedAt,
  });

  final String? login;
  final String? addedBy;
  final int addedAt;

  factory ListingViewer.fromJson(Map<String, dynamic> j) => ListingViewer(
    login: j['login'] as String?,
    addedBy: j['addedBy'] as String?,
    addedAt: (j['addedAt'] as num?)?.toInt() ?? 0,
  );
}

/// The outcome of naming a member: 201 `added`, 200 when already named.
class ListingViewerAdded {
  const ListingViewerAdded({required this.login, required this.added});

  final String login;
  final bool added;
}

/// Tags typed as free text: split on commas, whitespace and `#`, lowercased,
/// deduplicated, in the order typed. Validity is [badListingTag]'s call.
List<String> parseListingTags(String text) {
  final out = <String>[];
  for (final raw in text.split(RegExp(r'[,\s#]+'))) {
    final t = raw.trim().toLowerCase();
    if (t.isNotEmpty && !out.contains(t)) out.add(t);
  }
  return out;
}

/// The first tag the grammar refuses, or null.
String? badListingTag(List<String> tags) => tags.cast<String?>().firstWhere(
  (t) => !listingTagPattern.hasMatch(t!),
  orElse: () => null,
);

/// The body of `PUT /catalog/apps/{app}/listing`, or the reason it cannot be
/// sent (Korean, for the field it is about) as [ListingFormError].
Map<String, Object?> buildListingBody({
  required String title,
  required String summary,
  required String tagsText,
  required ListingAudience audience,
}) {
  final t = title.trim();
  if (t.isEmpty) throw const ListingFormError('title', '제목을 입력하세요.');
  if (t.length > listingTitleMaxLength) {
    throw const ListingFormError(
      'title',
      '제목은 $listingTitleMaxLength자 이하여야 합니다.',
    );
  }
  if (RegExp(r'\p{Cc}', unicode: true).hasMatch(t)) {
    throw const ListingFormError('title', '제목에 제어 문자를 쓸 수 없습니다.');
  }
  final s = summary.trim();
  if (s.length > listingSummaryMaxLength) {
    throw const ListingFormError(
      'summary',
      '요약은 $listingSummaryMaxLength자 이하여야 합니다.',
    );
  }
  final tags = parseListingTags(tagsText);
  final bad = badListingTag(tags);
  if (bad != null) {
    throw ListingFormError('tags', '"$bad": 태그는 소문자·숫자·하이픈 1~32자입니다.');
  }
  if (tags.length > listingTagsMax) {
    throw const ListingFormError('tags', '태그는 $listingTagsMax개까지입니다.');
  }
  return {
    'title': t,
    'summary': s.isEmpty ? null : s,
    'tags': tags,
    'audience': audience.wire,
  };
}

class ListingFormError implements Exception {
  const ListingFormError(this.field, this.message);

  /// `title` | `summary` | `tags`.
  final String field;
  final String message;

  @override
  String toString() => message;
}
