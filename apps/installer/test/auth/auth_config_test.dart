import 'package:catalog/auth/auth_config.dart';
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
}
