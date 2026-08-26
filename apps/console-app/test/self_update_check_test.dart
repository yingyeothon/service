import 'dart:convert';

import 'package:yyt_console/self_update_check.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  const base = 'https://console.example';

  http.Client serving(int status, Object body, {List<http.Request>? seen}) {
    return MockClient((request) async {
      seen?.add(request);
      return http.Response(jsonEncode(body), status);
    });
  }

  final downloads = {
    'downloads': [
      {
        'url': 'https://cdn.example/console-1.5.0.apk',
        'filename': 'console-1.5.0.apk',
        'platform': 'android',
        'version': '1.5.0+18',
        'applicationId': 'life.yyt.console',
        'createdAt': 1756300000,
      },
      {
        'url': 'https://cdn.example/console-1.6.0-debug.apk',
        'filename': 'console-1.6.0-debug.apk',
        'platform': 'android',
        'version': '1.6.0+20',
        'applicationId': 'life.yyt.console.debug',
        'createdAt': 1756500000,
      },
      {
        'url': 'https://cdn.example/console-bad.apk',
        'filename': 'console-bad.apk',
        'platform': 'android',
        'version': 'v9.9.9',
        'applicationId': 'life.yyt.console',
        'createdAt': 1756600000,
      },
      {
        'url': 'https://cdn.example/console-1.4.1.apk',
        'filename': 'console-1.4.1.apk',
        'platform': 'android',
        'version': '1.4.1+17',
        'applicationId': 'life.yyt.console',
        'createdAt': 1756200000,
      },
      {
        'url': 'https://cdn.example/console.ipa',
        'filename': 'console.ipa',
        'platform': 'ios',
        'version': '9.9.9',
        'createdAt': 1756400000,
      },
    ],
  };

  test('picks the highest android version of this package, ignoring ios, other '
      'packages, unparseable versions and plain http', () {
    const pkg = 'life.yyt.console';
    final latest = pickLatestConsoleDownload(downloads, packageName: pkg)!;
    expect(latest['version'], '1.5.0+18');
    expect(
      pickLatestConsoleDownload(
        downloads,
        packageName: 'life.yyt.console.debug',
      )!['version'],
      '1.6.0+20',
    );
    // List order must not matter: an old build re-uploaded after a newer
    // one is listed first by the server.
    final reversed = {
      'downloads': (downloads['downloads'] as List).reversed.toList(),
    };
    expect(
      pickLatestConsoleDownload(reversed, packageName: pkg)!['version'],
      '1.5.0+18',
    );
    expect(
      pickLatestConsoleDownload({'downloads': []}, packageName: pkg),
      isNull,
    );
    expect(
      pickLatestConsoleDownload({'downloads': 'nope'}, packageName: pkg),
      isNull,
    );
    expect(
      pickLatestConsoleDownload({
        'downloads': [
          {
            'url': 'http://cdn.example/plain.apk',
            'platform': 'android',
            'version': '9.0.0',
          },
        ],
      }, packageName: pkg),
      isNull,
    );
  });

  test('reports an update when the server build is newer', () async {
    final seen = <http.Request>[];
    final update = await checkConsoleAppUpdate(
      token: 'yyt_t',
      baseUrl: base,
      client: serving(200, downloads, seen: seen),
      currentVersion: () async => '1.4.1+17',
      currentPackageName: () async => 'life.yyt.console',
    );
    expect(seen.single.url.toString(), '$base/catalog/installer/downloads');
    expect(seen.single.headers['Authorization'], 'Bearer yyt_t');
    expect(update, isNotNull);
    expect(update!.version, '1.5.0+18');
    expect(update.installedVersion, '1.4.1+17');
    expect(update.packageName, 'life.yyt.console');
    expect(update.artifact.url, 'https://cdn.example/console-1.5.0.apk');
    expect(update.artifact.isInstallableAndroidApk, isTrue);
  });

  test('a row without applicationId (older console) is accepted', () {
    final row = pickLatestConsoleDownload({
      'downloads': [
        {
          'url': 'https://cdn.example/x.apk',
          'platform': 'android',
          'version': '1.0.0',
        },
      ],
    }, packageName: 'life.yyt.console');
    expect(row, isNotNull);
  });

  test('a build of another package is never offered', () async {
    expect(
      await checkConsoleAppUpdate(
        token: 'yyt_t',
        baseUrl: base,
        client: serving(200, downloads),
        currentVersion: () async => '0.0.1',
        currentPackageName: () async => 'life.yyt.other',
      ),
      isNull,
    );
  });

  test('stays quiet when up to date, newer, or the route fails', () async {
    for (final installed in ['1.5.0+18', '1.5.0+19', '2.0.0']) {
      expect(
        await checkConsoleAppUpdate(
          token: 'yyt_t',
          baseUrl: base,
          client: serving(200, downloads),
          currentVersion: () async => installed,
          currentPackageName: () async => 'life.yyt.console',
        ),
        isNull,
        reason: installed,
      );
    }
    for (final status in [401, 403, 503]) {
      expect(
        await checkConsoleAppUpdate(
          token: 'yyt_t',
          baseUrl: base,
          client: serving(status, {
            'error': {'code': 'x'},
          }),
          currentVersion: () async => '0.0.1',
          currentPackageName: () async => 'life.yyt.console',
        ),
        isNull,
        reason: '$status',
      );
    }
    expect(
      await checkConsoleAppUpdate(
        token: null,
        baseUrl: base,
        client: serving(200, downloads),
        currentVersion: () async => '0.0.1',
        currentPackageName: () async => 'life.yyt.console',
      ),
      isNull,
    );
    expect(
      await checkConsoleAppUpdate(
        token: 'yyt_t',
        baseUrl: base,
        client: MockClient((_) async => throw Exception('offline')),
        currentVersion: () async => '0.0.1',
        currentPackageName: () async => 'life.yyt.console',
      ),
      isNull,
    );
  });
}
