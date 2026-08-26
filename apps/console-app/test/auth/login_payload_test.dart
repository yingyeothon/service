import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/auth/auth_service.dart';
import 'package:yyt_console/login_screen.dart';

void main() {
  const key = 'yyt_0123456789abcdef0123456789abcdef0123456789abcdef';

  test('parses the console App login QR payload', () {
    final p = ApiKeyLoginPayload.parse(
      '{"type":"yyt_api_key","apiKey":"$key","server":"console-dev.yyt.life"}',
    );
    expect(p.server, 'https://console-dev.yyt.life');
    expect(p.apiKey, key);
  });

  test('rejects legacy, malformed and userinfo payloads', () {
    expect(
      () => ApiKeyLoginPayload.parse(
        '{"type":"cata_api_key","apiKey":"$key","server":"x.example"}',
      ),
      throwsFormatException,
    );
    expect(() => ApiKeyLoginPayload.parse('not json'), throwsFormatException);
    expect(
      () => ApiKeyLoginPayload.parse(
        '{"type":"yyt_api_key","apiKey":"yyt_short","server":"x.example"}',
      ),
      throwsFormatException,
    );
    expect(
      () => ApiKeyLoginPayload.parse(
        '{"type":"yyt_api_key","apiKey":"$key","server":"https://a@x.example"}',
      ),
      throwsFormatException,
    );
  });

  test('profiles round-trip through json and drop broken entries', () {
    final p = Profile(
      id: 'p_1',
      server: 'https://x.example',
      apiKey: key,
      login: 'me',
      addedAt: DateTime.utc(2026, 8, 27),
    );
    final back = Profile.fromJson(p.toJson());
    expect(back?.id, 'p_1');
    expect(back?.host, 'x.example');
    expect(back?.addedAt, DateTime.utc(2026, 8, 27));
    expect(Profile.fromJson({'id': 'p_2'}), isNull);
    expect(Profile.fromJson('nope'), isNull);
  });
}
