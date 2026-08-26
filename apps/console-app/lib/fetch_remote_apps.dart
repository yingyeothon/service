import 'dart:convert';
import 'dart:math';

import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/artifact_version_group.dart';
import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/remote_app.dart';
import 'package:http/http.dart' as http;

class UnauthorizedException implements Exception {
  UnauthorizedException(this.message);

  final String message;

  @override
  String toString() => 'UnauthorizedException: $message';
}

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
  );

  final results = <RemoteApp>[];
  const maxParallel = 5;

  for (var i = 0; i < appMaps.length; i += maxParallel) {
    final end = min(i + maxParallel, appMaps.length);
    final batch = appMaps.sublist(i, end);
    final batchResults = await Future.wait(
      batch.map((appJson) => _toRemoteApp(appJson, token: token, base: base)),
    );
    results.addAll(batchResults.whereType<RemoteApp>());
  }

  results.sort(
    (a, b) => b.latestArtifact.createdAt.compareTo(a.latestArtifact.createdAt),
  );
  return results;
}

/// Every catalog app of every team the caller is seated in (`/teams` then
/// `/teams/{id}/catalog/apps`), deduplicated by app id. Teams where the
/// caller is still `pending` are skipped: their app route answers 403.
Future<List<Map<String, dynamic>>> fetchTeamApps({
  required String token,
  http.Client? client,
  String? baseUrl,
}) async {
  final http.Client c = client ?? http.Client();
  try {
    return await _fetchTeamApps(c, token, baseUrl ?? AuthConfig.apiBaseUrl);
  } finally {
    if (client == null) c.close();
  }
}

Future<List<Map<String, dynamic>>> _fetchTeamApps(
  http.Client c,
  String token,
  String base,
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

  Future<List<Map<String, dynamic>>> appsOf(String teamId) async {
    final response = await c.get(
      Uri.parse(AuthConfig.teamAppsUrlOf(base, teamId)),
      headers: headers,
    );
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
    return (body['apps'] as List<dynamic>).cast<Map<String, dynamic>>();
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
}) async {
  final uri = Uri.parse(
    '${AuthConfig.appArtifactsUrlOf(baseUrl ?? AuthConfig.apiBaseUrl, appId)}?platform=$platform',
  );
  final response = await http.get(
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

Future<RemoteApp?> _toRemoteApp(
  Map<String, dynamic> appJson, {
  required String token,
  required String base,
}) async {
  final id = appJson['id'] as String?;
  final name = appJson['name'] as String?;
  final packageName = appJson['path'] as String?;
  if (id == null || name == null || packageName == null) {
    return null;
  }

  final artifactsUri = Uri.parse(
    '${AuthConfig.appArtifactsUrlOf(base, id)}?platform=android',
  );
  final response = await http.get(
    artifactsUri,
    headers: {'Authorization': 'Bearer $token'},
  );

  if (response.statusCode == 401) {
    throw UnauthorizedException('인증이 만료되었습니다. 다시 로그인해주세요.');
  }
  if (response.statusCode != 200) {
    return null;
  }

  final artifactsBody =
      jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
  final artifactsJson = artifactsBody['artifacts'] as List<dynamic>;
  if (artifactsJson.isEmpty) {
    return null;
  }

  final artifacts =
      artifactsJson
          .map((item) => ArtifactInfo.fromJson(item as Map<String, dynamic>))
          .where((artifact) => artifact.platform.toLowerCase() == 'android')
          .toList();
  if (artifacts.isEmpty) {
    return null;
  }

  final versionGroups = groupArtifactsByVersion(artifacts);
  if (versionGroups.isEmpty) {
    return null;
  }
  final latestArtifact = versionGroups.first.topArtifact;

  final applicationIds =
      <String>{
        for (final artifact in artifacts)
          if (artifact.applicationId.isNotEmpty) artifact.applicationId,
      }.toList();

  return RemoteApp(
    id: id,
    name: name,
    package: packageName,
    description: (appJson['description'] as String?) ?? '',
    latestArtifact: latestArtifact,
    applicationIds: applicationIds,
  );
}
