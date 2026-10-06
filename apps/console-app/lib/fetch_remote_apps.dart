import 'dart:convert';
import 'dart:math';

import 'package:yyt_console/app_home.dart';
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/remote_app.dart';
import 'package:http/http.dart' as http;

class UnauthorizedException implements Exception {
  UnauthorizedException(this.message);

  final String message;

  @override
  String toString() => 'UnauthorizedException: $message';
}

/// How long any catalog request of the app (the list, the older-console
/// fallback, the detail screen's artifacts) may take before it counts as
/// failed.
const catalogRequestTimeout = Duration(seconds: 20);

const _summaryQuery = {'artifacts': 'summary', 'platform': 'android'};

/// The whole app list in one request: `GET /catalog/apps?artifacts=summary&platform=android`
/// answers every app of every seated team with its newest Android artifact
/// and application ids, plus `teams` — the caller's seats. One request at a
/// launch keeps it on one Lambda container (rules/architecture.md).
Future<List<RemoteApp>> fetchRemoteApps({
  String? token,
  http.Client? client,
  String? baseUrl,
  Duration timeout = catalogRequestTimeout,
}) async {
  if (token == null || token.isEmpty) {
    throw UnauthorizedException('로그인이 필요합니다.');
  }
  // Captured once with the token: a profile switch mid-load must not send
  // this token to the other profile's server.
  final base = baseUrl ?? AuthConfig.apiBaseUrl;
  final http.Client c = client ?? http.Client();
  try {
    final get = _getter(c, token, timeout);
    final body = await get(
      Uri.parse(
        AuthConfig.catalogAppsUrlOf(base),
      ).replace(queryParameters: _summaryQuery),
    );
    // A console older than the flattened summary ignores the query and sends
    // no `teams`: list per team, as app builds up to 1.5.3 do. Remove once
    // every stage runs the flattened summary (todo/43).
    final appMaps = body.containsKey('teams')
        ? _withSeats(body['apps'], body['teams'])
        : await _perTeamApps(get, base);
    final results = [
      for (final appJson in appMaps)
        if (_toRemoteApp(appJson) case final app?) app,
    ];
    results.sort(
      (a, b) =>
          b.latestArtifact.createdAt.compareTo(a.latestArtifact.createdAt),
    );
    return results;
  } finally {
    if (client == null) c.close();
  }
}

typedef _Get = Future<Map<String, dynamic>> Function(Uri uri);

/// A GET with the bearer, the timeout and the status handling every catalog
/// list request shares.
_Get _getter(http.Client c, String token, Duration timeout) => (uri) async {
  final response = await c
      .get(uri, headers: {'Authorization': 'Bearer $token'})
      .timeout(timeout);
  if (response.statusCode == 401) {
    throw UnauthorizedException('인증이 만료되었습니다. 다시 로그인해주세요.');
  }
  if (response.statusCode == 403) {
    // /me accepts a pending member; the lists do not. Say so instead of a
    // bare status code.
    throw Exception('아직 승인되지 않은 계정입니다. 관리자 승인 후 다시 시도해주세요.');
  }
  if (response.statusCode != 200) {
    throw Exception('앱 목록 조회 실패: ${response.statusCode}');
  }
  return jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
};

/// The apps with the caller's seat in their team as `teamRole`, for the
/// detail screen's issues button; a team the seats do not name keeps
/// `AppHome.fromAppJson`'s default.
List<Map<String, dynamic>> _withSeats(Object? apps, Object? teams) {
  final roleOf = <String, String>{
    for (final team in (teams as List<dynamic>? ?? const []))
      if (team is Map<String, dynamic> &&
          team['id'] is String &&
          team['role'] is String)
        team['id'] as String: team['role'] as String,
  };
  return [
    for (final app in (apps as List<dynamic>).cast<Map<String, dynamic>>())
      {...app, if (roleOf[app['teamId']] case final role?) 'teamRole': role},
  ];
}

/// The older console's list: `/teams`, then each seated team's summary route
/// five at a time; one team failing (a seat revoked in between) hides only
/// that team. Deduplicated by app id in team order.
Future<List<Map<String, dynamic>>> _perTeamApps(_Get get, String base) async {
  final teams =
      ((await get(Uri.parse(AuthConfig.teamsUrlOf(base))))['teams']
              as List<dynamic>)
          .cast<Map<String, dynamic>>()
          .where((t) => t['id'] is String && t['role'] != 'pending')
          .toList();
  Future<List<Map<String, dynamic>>> appsOf(Map<String, dynamic> team) async {
    final Map<String, dynamic> body;
    try {
      body = await get(
        Uri.parse(
          AuthConfig.teamAppsUrlOf(base, team['id'] as String),
        ).replace(queryParameters: _summaryQuery),
      );
    } on UnauthorizedException {
      rethrow;
    } catch (_) {
      return const [];
    }
    return _withSeats(body['apps'], [team]);
  }

  final seen = <String>{};
  final apps = <Map<String, dynamic>>[];
  const maxParallel = 5;
  for (var i = 0; i < teams.length; i += maxParallel) {
    final batch = teams.sublist(i, min(i + maxParallel, teams.length));
    for (final list in await Future.wait(batch.map(appsOf))) {
      for (final app in list) {
        if (app['id'] case final String id when seen.add(id)) apps.add(app);
      }
    }
  }
  return apps;
}

Future<List<ArtifactInfo>> fetchAppArtifacts({
  required String appId,
  required String token,
  String platform = 'android',
  String? baseUrl,
  http.Client? client,
  Duration timeout = catalogRequestTimeout,
}) async {
  final uri = Uri.parse(
    '${AuthConfig.appArtifactsUrlOf(baseUrl ?? AuthConfig.apiBaseUrl, appId)}?platform=$platform',
  );
  final http.Client c = client ?? http.Client();
  final http.Response response;
  try {
    response = await c
        .get(uri, headers: {'Authorization': 'Bearer $token'})
        .timeout(timeout);
  } finally {
    if (client == null) c.close();
  }

  if (response.statusCode == 401) {
    throw UnauthorizedException('인증이 만료되었습니다. 다시 로그인해주세요.');
  }
  if (response.statusCode != 200) {
    throw Exception('아티팩트 목록 조회 실패: ${response.statusCode}');
  }

  final body =
      jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
  final artifacts = (body['artifacts'] as List<dynamic>)
      .map((item) => ArtifactInfo.fromJson(item as Map<String, dynamic>))
      .toList();

  artifacts.sort((a, b) => b.createdAt.compareTo(a.createdAt));
  return artifacts;
}

/// The update-notice topic of an app or listing row, as the server named it.
String? _topicOf(Map<String, dynamic> row) => switch (row['topic']) {
  final String t when t.isNotEmpty => t,
  _ => null,
};

/// Builds an app from the `artifacts=summary` view; apps without an Android
/// artifact are skipped.
RemoteApp? _toRemoteApp(Map<String, dynamic> appJson) {
  final id = appJson['id'] as String?;
  final name = appJson['name'] as String?;
  final packageName = appJson['path'] as String?;
  final latestJson = appJson['latestArtifact'];
  if (id == null ||
      name == null ||
      packageName == null ||
      latestJson is! Map<String, dynamic>) {
    return null;
  }
  final latestArtifact = ArtifactInfo.fromJson(latestJson);
  if (latestArtifact.platform.toLowerCase() != 'android') {
    return null;
  }
  final applicationIds = <String>[
    for (final v in (appJson['applicationIds'] as List<dynamic>? ?? const []))
      if (v is String && v.isNotEmpty) v,
  ];
  final shared = appJson['access'] == 'listing';
  final listing = appJson['listing'];
  // A listing row shows under the title its team chose, like the browse tab.
  final title =
      shared && listing is Map<String, dynamic> && listing['title'] is String
      ? listing['title'] as String
      : name;
  return RemoteApp(
    id: id,
    name: title,
    package: packageName,
    description: (appJson['description'] as String?) ?? '',
    latestArtifact: latestArtifact,
    applicationIds: applicationIds,
    home: AppHome.fromAppJson(appJson),
    // A listing row carries no project crumb, so `home` is null by
    // construction; the flag is what the card's badge reads.
    shared: shared,
    topic: _topicOf(appJson),
  );
}

/// The browse tab: `GET /catalog/listings?platform=android` — every listing
/// the caller may read (public ones, the ones naming them, their own teams')
/// that has an Android build, newest published first, as installable apps.
/// The token is optional on the server; the app always has one, and sends it
/// so the named and seated listings are included.
Future<List<RemoteApp>> fetchPublicListings({
  String? token,
  http.Client? client,
  String? baseUrl,
  Duration timeout = catalogRequestTimeout,
}) async {
  if (token == null || token.isEmpty) {
    throw UnauthorizedException('로그인이 필요합니다.');
  }
  final base = baseUrl ?? AuthConfig.apiBaseUrl;
  final http.Client c = client ?? http.Client();
  try {
    final body = await _getter(c, token, timeout)(
      Uri.parse(
        AuthConfig.catalogListingsUrlOf(base),
      ).replace(queryParameters: const {'platform': 'android'}),
    );
    return [
      for (final row in (body['listings'] as List<dynamic>? ?? const []))
        if (row is Map<String, dynamic>)
          if (_toListedApp(row) case final app?) app,
    ];
  } finally {
    if (client == null) c.close();
  }
}

/// A browse row as an app: the listing's title and summary are what the
/// reader sees, the app id and its newest Android artifact are what install
/// needs. A row without an Android build is skipped, like the app list.
RemoteApp? _toListedApp(Map<String, dynamic> row) {
  final id = row['appId'] as String?;
  final title = row['title'] as String?;
  if (id == null || title == null) return null;
  // The Android entry of the per-platform list, whatever the newest build
  // overall is; `latestArtifact` is the fallback for an older console.
  final artifacts = [
    for (final a in (row['artifacts'] as List<dynamic>? ?? const []))
      if (a is Map<String, dynamic>) ArtifactInfo.fromJson(a),
  ];
  final latestJson = row['latestArtifact'];
  final latest = artifacts.cast<ArtifactInfo?>().firstWhere(
    (a) => a!.platform.toLowerCase() == 'android',
    orElse: () => latestJson is Map<String, dynamic>
        ? ArtifactInfo.fromJson(latestJson)
        : null,
  );
  if (latest == null || latest.platform.toLowerCase() != 'android') {
    return null;
  }
  final applicationIds = <String>[
    for (final v in (row['applicationIds'] as List<dynamic>? ?? const []))
      if (v is String && v.isNotEmpty) v,
  ];
  // The public row carries no `path`: the install checks key on the
  // application ids the artifacts declare, falling back to the app's name.
  final package = latest.applicationId.isNotEmpty
      ? latest.applicationId
      : applicationIds.isNotEmpty
      ? applicationIds.first
      : (row['appName'] as String?) ?? id;
  return RemoteApp(
    id: id,
    name: title,
    package: package,
    description: (row['summary'] as String?) ?? '',
    latestArtifact: latest,
    applicationIds: applicationIds,
    shared: true,
    topic: _topicOf(row),
  );
}
