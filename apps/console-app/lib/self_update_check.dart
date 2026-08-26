import 'dart:convert';

import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/check_if_need_to_update.dart';
import 'package:yyt_console/self_update_state.dart';
import 'package:http/http.dart' as http;

/// The newest build of this app the console serves, when it is newer than
/// the running one.
class ConsoleAppUpdate {
  const ConsoleAppUpdate({
    required this.installedVersion,
    required this.artifact,
    required this.packageName,
  });

  final String installedVersion;
  final ArtifactInfo artifact;

  /// The running app's applicationId: the downloads route carries no
  /// application id, and a self-update must target exactly this package.
  final String packageName;

  String get version => artifact.version;
}

/// Picks the highest-versioned Android entry of
/// `GET /catalog/installer/downloads`
/// (`{downloads:[{url,filename,platform,version,applicationId,createdAt}]}`)
/// whose `applicationId` is [packageName] (a missing id — an older console —
/// is accepted); `null` when there is none. Rows whose version does not parse
/// are skipped: an unparseable version would otherwise read as "newer" on
/// every launch.
Map<String, dynamic>? pickLatestConsoleDownload(
  Map<String, dynamic> body, {
  required String packageName,
  String platform = 'android',
}) {
  final rows = body['downloads'];
  if (rows is! List) return null;
  Map<String, dynamic>? best;
  for (final row in rows) {
    if (row is! Map<String, dynamic>) continue;
    if ((row['platform'] as String?)?.toLowerCase() != platform) continue;
    if (row['url'] is! String || row['version'] is! String) continue;
    // The APK is installed as this very app: only a TLS origin may serve it,
    // and a debug build (`….debug`) must not be offered the release package.
    if (Uri.tryParse(row['url'] as String)?.scheme != 'https') continue;
    final appId = row['applicationId'];
    if (appId is String && appId.isNotEmpty && appId != packageName) continue;
    try {
      if (best == null ||
          compareVersions(row['version'] as String, best['version'] as String) >
              0) {
        best = row;
      }
    } on FormatException {
      continue;
    }
  }
  return best;
}

/// Asks the console for the newest console app build and compares it with
/// the running version. Every failure (no installer configured, untrusted
/// team, pending seat, network) yields `null`: the banner is a courtesy, never
/// a gate.
Future<ConsoleAppUpdate?> checkConsoleAppUpdate({
  required String? token,
  http.Client? client,
  String? baseUrl,
  Future<String> Function()? currentVersion,
  Future<String> Function()? currentPackageName,
}) async {
  if (token == null || token.isEmpty) return null;
  final base = baseUrl ?? AuthConfig.apiBaseUrl;
  final http.Client c = client ?? http.Client();
  try {
    final response = await c
        .get(
          Uri.parse(AuthConfig.installerDownloadsUrlOf(base)),
          headers: {'Authorization': 'Bearer $token'},
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) return null;
    final body = jsonDecode(utf8.decode(response.bodyBytes));
    if (body is! Map<String, dynamic>) return null;
    final packageName = await (currentPackageName ?? getCurrentPackageName)();
    final latest = pickLatestConsoleDownload(body, packageName: packageName);
    if (latest == null) return null;
    final installed = await (currentVersion ?? getCurrentAppVersion)();
    final version = latest['version'] as String;
    // Not `checkIfNeedToUpdate`: that answers true when a version does not
    // parse, and the banner must stay hidden on "unknown".
    if (compareVersions(version, installed) <= 0) return null;
    final artifact = ArtifactInfo.fromJson({
      'id': 'installer:$version',
      'url': latest['url'],
      'platform': latest['platform'],
      'size': 0,
      'tags': {'version': version},
      'createdAt': latest['createdAt'] ?? 0,
    });
    return ConsoleAppUpdate(
      installedVersion: installed,
      artifact: artifact,
      packageName: packageName,
    );
  } catch (_) {
    return null;
  } finally {
    if (client == null) c.close();
  }
}
