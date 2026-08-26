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

/// The app list: `/teams`, then `/teams/{id}/catalog/apps?artifacts=summary&platform=android`
/// per seated team. The summary carries each app's newest Android artifact
/// and application ids, so no per-app `/artifacts` round trip is needed —
/// that was the N+1 that made the first load take seconds.
Future<List<RemoteApp>> fetchRemoteApps({
  String? token,
  http.Client? client,
  String? baseUrl,
}) async {
  if (token == null || token.isEmpty) {
    throw UnauthorizedException('로그인이 필요합니다.');
  }
  // Captured once with the token: a profile switch mid-load must not send
  // this token to the other profile's server.
  final base = baseUrl ?? AuthConfig.apiBaseUrl;
  final appMaps = await fetchTeamApps(
    token: token,
    client: client,
    baseUrl: base,
    query: const {'artifacts': 'summary', 'platform': 'android'},
  );

  // A console that predates `artifacts=summary` answers without the key
  // (`null` means "no artifact"); fall back to the per-app walk for those
  // so an updated app never shows an empty list against an older server.
  final http.Client c = client ?? http.Client();
  final results = <RemoteApp>[];
  try {
    final legacy = <Map<String, dynamic>>[];
    for (final appJson in appMaps) {
      if (!appJson.containsKey('latestArtifact')) {
        legacy.add(appJson);
      } else if (_toRemoteApp(appJson) case final app?) {
        results.add(app);
      }
    }
    const maxParallel = 5;
    for (var i = 0; i < legacy.length; i += maxParallel) {
      final batch = legacy.sublist(i, min(i + maxParallel, legacy.length));
      results.addAll(
        (await Future.wait(
          batch.map((a) => _withFetchedArtifacts(a, c, token, base)),
        )).whereType<RemoteApp>(),
      );
    }
  } finally {
    if (client == null) c.close();
  }
  results.sort(
    (a, b) => b.latestArtifact.createdAt.compareTo(a.latestArtifact.createdAt),
  );
  return results;
}

/// Every catalog app of every team the caller is seated in (`/teams` then
/// `/teams/{id}/catalog/apps`), deduplicated by app id. Teams where the
/// caller is still `pending` are skipped: their app route answers 403.
///
/// One `http.Client` serves every request so the TLS connection is reused.
/// `query` is appended to each team's app route.
Future<List<Map<String, dynamic>>> fetchTeamApps({
  required String token,
  http.Client? client,
  String? baseUrl,
  Map<String, String> query = const {},
}) async {
  final http.Client c = client ?? http.Client();
  try {
    return await _fetchTeamApps(
      c,
      token,
      baseUrl ?? AuthConfig.apiBaseUrl,
      query,
    );
  } finally {
    if (client == null) c.close();
  }
}

Future<List<Map<String, dynamic>>> _fetchTeamApps(
  http.Client c,
  String token,
  String base,
  Map<String, String> query,
) async {
  final headers = <String, String>{'Authorization': 'Bearer $token'};
  final teamsResponse = await c.get(
    Uri.parse(AuthConfig.teamsUrlOf(base)),
    headers: headers,
  );
  if (teamsResponse.statusCode == 401) {
    throw UnauthorizedException('인증이 만료되었습니다. 다시 로그인해주세요.');
  }
  if (teamsResponse.statusCode == 403) {
    // /me accepts a pending member; /teams does not. Say so instead of a
    // bare status code.
    throw Exception('아직 승인되지 않은 계정입니다. 관리자 승인 후 다시 시도해주세요.');
  }
  if (teamsResponse.statusCode != 200) {
    throw Exception('팀 목록 조회 실패: ${teamsResponse.statusCode}');
  }
  final teamsBody =
      jsonDecode(utf8.decode(teamsResponse.bodyBytes)) as Map<String, dynamic>;
  final teams =
      (teamsBody['teams'] as List<dynamic>).cast<Map<String, dynamic>>();

  final teamIds = <String>[
    for (final team in teams)
      if (team['id'] is String && team['role'] != 'pending')
        team['id'] as String,
  ];
  final roleOf = <String, String>{
    for (final team in teams)
      if (team['id'] is String && team['role'] is String)
        team['id'] as String: team['role'] as String,
  };

  Future<List<Map<String, dynamic>>> appsOf(String teamId) async {
    var uri = Uri.parse(AuthConfig.teamAppsUrlOf(base, teamId));
    if (query.isNotEmpty) uri = uri.replace(queryParameters: query);
    final response = await c.get(uri, headers: headers);
    if (response.statusCode == 401) {
      throw UnauthorizedException('인증이 만료되었습니다. 다시 로그인해주세요.');
    }
    if (response.statusCode != 200) {
      // A single team failing (e.g. seat revoked between the two calls)
      // must not hide every other team's apps.
      return const [];
    }
    final body =
        jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    // The caller's seat in the team an app was listed under: the detail
    // screen needs it to open the project's issues with the right role.
    return [
      for (final app
          in (body['apps'] as List<dynamic>).cast<Map<String, dynamic>>())
        {...app, 'teamRole': roleOf[teamId] ?? 'member'},
    ];
  }

  // Team order is kept so the dedupe below is deterministic.
  final seen = <String>{};
  final apps = <Map<String, dynamic>>[];
  const maxParallel = 5;
  for (var i = 0; i < teamIds.length; i += maxParallel) {
    final batch = teamIds.sublist(i, min(i + maxParallel, teamIds.length));
    for (final list in await Future.wait(batch.map(appsOf))) {
      for (final app in list) {
        final id = app['id'];
        if (id is String && seen.add(id)) {
          apps.add(app);
        }
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
}) async {
  final uri = Uri.parse(
    '${AuthConfig.appArtifactsUrlOf(baseUrl ?? AuthConfig.apiBaseUrl, appId)}?platform=$platform',
  );
  final response = await (client ?? http.Client()).get(
    uri,
    headers: {'Authorization': 'Bearer $token'},
  );

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

/// Legacy path: fills the summary fields from `/catalog/apps/{id}/artifacts`.
Future<RemoteApp?> _withFetchedArtifacts(
  Map<String, dynamic> appJson,
  http.Client c,
  String token,
  String base,
) async {
  final id = appJson['id'];
  if (id is! String) return null;
  final List<ArtifactInfo> artifacts;
  try {
    artifacts = await fetchAppArtifacts(
      appId: id,
      token: token,
      baseUrl: base,
      client: c,
    );
  } on UnauthorizedException {
    rethrow;
  } catch (_) {
    return null; // one app failing must not hide the others
  }
  // Newest first, as the server orders them: the first is the summary's pick.
  final android =
      artifacts.where((a) => a.platform.toLowerCase() == 'android').toList();
  if (android.isEmpty) return null;
  return _toRemoteApp({
    ...appJson,
    'latestArtifact': android.first.toJson(),
    'applicationIds':
        <String>{
          for (final a in android)
            if (a.applicationId.isNotEmpty) a.applicationId,
        }.toList(),
  });
}

/// Builds an app from the `artifacts=summary` view; apps without an Android
/// artifact are skipped, like before.
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
