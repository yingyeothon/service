// Catalog share links (docs/decisions.md *Catalog share links and install
// bridge*): the team's side (create, list) and the recipient's JSON twin
// (`GET /catalog/share/{ref}`, services/console/src/share-links.ts).

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/auth/auth_config.dart';

/// Expiry choices of a new link (decision #2); 7 is the default.
const shareLinkExpiryDays = <int>[1, 7, 30];
const shareLinkDefaultExpiryDays = 7;
const shareLinkLabelMaxLength = 100;
const shareLinkTitleMaxLength = 100;
const shareLinkSummaryMaxLength = 2000;
const shareLinkReasonMaxLength = 500;

/// The one build a token link may grant (decision #10), in display order.
const shareBuildKindLabels = <String, String>{
  'android-release': 'Android release APK',
  'android-debug': 'Android debug APK',
  'ios-ad-hoc': 'iOS ad-hoc',
};

/// The kinds [artifacts] hold a build for, by the server's rule
/// (`artifactOfKind` in services/console/src/share-links.ts): an `.apk`
/// tagged `build_type` debug/release, or an iOS build with an ad-hoc install
/// link.
List<String> availableShareKinds(Iterable<ArtifactInfo> artifacts) {
  bool has(String kind) => artifacts.any((a) {
    if (kind == 'ios-ad-hoc') return a.platform == 'ios' && a.ios != null;
    final type = kind == 'android-debug' ? 'debug' : 'release';
    // The server's `filenameOf`: the URL's last `/` segment as it is
    // (a query string included), decoded.
    final last = a.url.substring(a.url.lastIndexOf('/') + 1);
    final name = Uri.decodeComponent(last);
    return a.platform == 'android' &&
        a.tags['build_type'] == type &&
        name.toLowerCase().endsWith('.apk');
  });
  return [
    for (final k in shareBuildKindLabels.keys)
      if (has(k)) k,
  ];
}

DateTime? _unix(Object? v) => v is num
    ? DateTime.fromMillisecondsSinceEpoch(v.toInt() * 1000, isUtc: true)
    : null;

/// A token link as the team sees it; never carries the token.
class ShareLinkView {
  const ShareLinkView({
    required this.id,
    required this.label,
    required this.createdBy,
    required this.createdAt,
    required this.expiresAt,
    required this.revokedAt,
    required this.live,
    this.url,
  });

  final String id;
  final String? label;
  final String? createdBy;
  final DateTime? createdAt;
  final DateTime? expiresAt;
  final DateTime? revokedAt;
  final bool live;

  /// Only on the create answer: the one time the token is visible.
  final String? url;

  factory ShareLinkView.fromJson(Map<String, dynamic> j) => ShareLinkView(
    id: (j['id'] as String?) ?? '',
    label: j['label'] as String?,
    createdBy: j['createdBy'] as String?,
    createdAt: _unix(j['createdAt']),
    expiresAt: _unix(j['expiresAt']),
    revokedAt: _unix(j['revokedAt']),
    live: j['live'] == true,
    url: j['url'] as String?,
  );
}

/// `GET /catalog/apps/{app}/share-links`.
class ShareLinksView {
  const ShareLinksView({
    required this.links,
    required this.publicUrl,
    required this.limit,
  });

  final List<ShareLinkView> links;

  /// The permanent link while the listing is public and standing.
  final String? publicUrl;
  final int limit;

  factory ShareLinksView.fromJson(Map<String, dynamic> j) => ShareLinksView(
    links: [
      for (final l in (j['links'] as List?) ?? const [])
        if (l is Map<String, dynamic>) ShareLinkView.fromJson(l),
    ],
    publicUrl: j['publicUrl'] is String && (j['publicUrl'] as String).isNotEmpty
        ? j['publicUrl'] as String
        : null,
    limit: (j['limit'] as num?)?.toInt() ?? 20,
  );
}

/// The text handed to the system share sheet.
String shareMessage(String title, String version, String url) {
  final v = version.trim();
  return v.isEmpty || v == 'unknown' ? '$title 설치: $url' : '$title $v 설치: $url';
}

/// What a share link grants (decision #2): the app's name and its newest
/// artifact per platform.
class SharedApp {
  const SharedApp({
    required this.kind,
    required this.appId,
    required this.appName,
    required this.title,
    required this.summary,
    required this.teamName,
    required this.expiresAt,
    required this.topic,
    required this.artifacts,
  });

  /// `public` (a listing) or `token`.
  final String kind;
  final String appId;
  final String appName;
  final String title;
  final String? summary;
  final String? teamName;
  final DateTime? expiresAt;
  final String? topic;
  final List<ArtifactInfo> artifacts;

  factory SharedApp.fromJson(Map<String, dynamic> j) => SharedApp(
    kind: (j['kind'] as String?) ?? 'public',
    appId: (j['appId'] as String?) ?? '',
    appName: (j['appName'] as String?) ?? '',
    title: (j['title'] as String?) ?? (j['appName'] as String?) ?? '',
    summary: j['summary'] as String?,
    teamName: j['teamName'] as String?,
    expiresAt: _unix(j['expiresAt']),
    topic: j['topic'] as String?,
    artifacts: [
      for (final a in (j['artifacts'] as List?) ?? const [])
        if (a is Map<String, dynamic>) ?_artifact(a),
    ],
  );

  static ArtifactInfo? _artifact(Map<String, dynamic> a) {
    try {
      return ArtifactInfo.fromJson(a);
    } catch (_) {
      return null;
    }
  }

  /// The newest Android build when it is an `.apk` (an `.aab` does not
  /// install), the bridge page's rule (decision #5).
  ArtifactInfo? get installableAndroid {
    final a = _newest('android');
    return a != null && a.fileName.toLowerCase().endsWith('.apk') ? a : null;
  }

  /// The newest iOS build when it carries an ad-hoc install URL.
  ArtifactInfo? get installableIos {
    final a = _newest('ios');
    return a?.ios != null ? a : null;
  }

  ArtifactInfo? _newest(String platform) {
    ArtifactInfo? best;
    for (final a in artifacts) {
      if (a.platform.toLowerCase() != platform) continue;
      if (best == null || a.createdAt.isAfter(best.createdAt)) best = a;
    }
    return best;
  }
}

/// The link is unknown, expired, revoked, taken down or unlisted: the server
/// answers all of them with the same 404 (decision #1).
class ShareUnavailableException implements Exception {
  const ShareUnavailableException();
  @override
  String toString() => '링크를 사용할 수 없습니다';
}

/// Any other failure to read the twin; [toString] is the Korean message.
class ShareFetchException implements Exception {
  const ShareFetchException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// `GET {server}/catalog/share/{ref}` without credentials: a recipient may
/// be signed out, or signed in to another console.
Future<SharedApp> fetchSharedApp({
  required String server,
  required String ref,
  required http.Client client,
  Duration timeout = const Duration(seconds: 20),
}) async {
  final http.Response r;
  try {
    r = await client
        .get(
          Uri.parse(AuthConfig.catalogShareUrlOf(server, ref)),
          headers: const {'Accept': 'application/json'},
        )
        .timeout(timeout);
  } on TimeoutException {
    throw ShareFetchException('콘솔 서버가 응답하지 않습니다. 잠시 후 다시 시도해주세요.');
  } on http.ClientException catch (e) {
    throw ShareFetchException('콘솔 서버에 연결하지 못했습니다: ${e.message}');
  }
  if (r.statusCode == 404) throw const ShareUnavailableException();
  if (r.statusCode != 200) {
    throw ShareFetchException('공유 정보를 불러오지 못했습니다: ${r.statusCode}');
  }
  final Object? body;
  try {
    body = jsonDecode(utf8.decode(r.bodyBytes));
  } on FormatException {
    throw ShareFetchException('공유 정보 응답을 읽을 수 없습니다.');
  }
  if (body is! Map<String, dynamic>) {
    throw ShareFetchException('공유 정보 응답을 읽을 수 없습니다.');
  }
  return SharedApp.fromJson(body);
}
