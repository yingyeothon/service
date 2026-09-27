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
    final appMaps =
        body.containsKey('teams')
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
  final artifacts =
      (body['artifacts'] as List<dynamic>)
          .map((item) => ArtifactInfo.fromJson(item as Map<String, dynamic>))
          .toList();

  artifacts.sort((a, b) => b.createdAt.compareTo(a.createdAt));
  return artifacts;
}

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
  return RemoteApp(
    id: id,
    name: name,
    package: packageName,
    description: (appJson['description'] as String?) ?? '',
    latestArtifact: latestArtifact,
    applicationIds: applicationIds,
    home: AppHome.fromAppJson(appJson),
  );
}
