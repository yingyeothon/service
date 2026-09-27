import 'package:yyt_console/auth/auth_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUp(() {
    AuthConfig.clearServerUrl();
  });

  group('AuthConfig.normalizeServerUrl', () {
    test('adds https scheme when omitted', () {
      final result = AuthConfig.normalizeServerUrl('dev-cata.yyt.life');
      expect(result, 'https://dev-cata.yyt.life');
    });

    test('removes trailing slash', () {
      final result = AuthConfig.normalizeServerUrl(
        'https://dev-cata.yyt.life/',
      );
      expect(result, 'https://dev-cata.yyt.life');
    });

    test('accepts explicit http scheme', () {
      final result = AuthConfig.normalizeServerUrl('http://10.0.2.2:8080');
      expect(result, 'http://10.0.2.2:8080');
    });

    test('rejects path segment', () {
      expect(
        () => AuthConfig.normalizeServerUrl('https://dev-cata.yyt.life/api'),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects empty input', () {
      expect(
        () => AuthConfig.normalizeServerUrl('   '),
        throwsA(isA<FormatException>()),
      );
    });
  });

  test(
    'setServerUrl stores normalized value and clearServerUrl removes it',
    () {
      final saved = AuthConfig.setServerUrl('dev-cata.yyt.life');
      expect(saved, 'https://dev-cata.yyt.life');
      expect(AuthConfig.serverUrl, 'https://dev-cata.yyt.life');
      expect(AuthConfig.apiBaseUrl, 'https://dev-cata.yyt.life');

      AuthConfig.clearServerUrl();
      expect(AuthConfig.serverUrl, isNull);
      expect(() => AuthConfig.apiBaseUrl, throwsStateError);
    },
  );

  test('API urls: /me probe and id-keyed artifact routes', () {
    AuthConfig.setServerUrl('console-dev.yyt.life');
    expect(AuthConfig.meUrl, 'https://console-dev.yyt.life/me');
    expect(AuthConfig.teamsUrl, 'https://console-dev.yyt.life/teams');
    expect(
      AuthConfig.catalogAppsUrlOf(AuthConfig.apiBaseUrl),
      'https://console-dev.yyt.life/catalog/apps',
    );
    expect(
      AuthConfig.projectIssueUrl('prj_1', 7),
      'https://console-dev.yyt.life/projects/prj_1/issues/7',
    );
    expect(
      AuthConfig.appArtifactUrl('ca_0123abcd', 'art 1'),
      'https://console-dev.yyt.life/catalog/apps/ca_0123abcd/artifacts/art%201',
    );
  });

  test('site and channel urls encode their path segments', () {
    const base = 'https://one.example';
    expect(
      AuthConfig.projectSitesUrlOf(base, 'prj 1'),
      'https://one.example/projects/prj%201/sites',
    );
    expect(
      AuthConfig.siteUrlOf(base, 'st/1'),
      'https://one.example/sites/st%2F1',
    );
    expect(
      AuthConfig.projectChannelsUrlOf(base, 'prj_1'),
      'https://one.example/projects/prj_1/channels',
    );
    expect(
      AuthConfig.channelUrlOf(base, 'auth?x'),
      'https://one.example/channels/auth%3Fx',
    );
    expect(
      AuthConfig.channelExtendUrlOf(base, 'q_1'),
      'https://one.example/channels/q_1/extend',
    );
  });

  test('rejects a server URL carrying userinfo', () {
    expect(
      () => AuthConfig.normalizeServerUrl(
        'https://console.yyt.life@evil.example',
      ),
      throwsA(isA<FormatException>()),
    );
  });
}
