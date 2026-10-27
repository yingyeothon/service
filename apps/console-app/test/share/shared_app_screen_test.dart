import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:yyt_console/auth/app_handoff.dart';
import 'package:yyt_console/share/shared_app_screen.dart';

import '../projects/widget_test_support.dart';

const _token = 'shr_0123456789abcdef0123456789abcdef';

Map<String, Object?> _artifact(
  String id,
  String platform,
  String file, {
  int createdAt = 1790000000,
  String version = '1.2.0',
}) => {
  'id': id,
  'appId': 'ca_1',
  'platform': platform,
  'url': 'https://cdn.example/catalog/$file',
  'size': 2048,
  'hash': 'h',
  'tags': {'version': version, 'application_id': 'life.yyt.game'},
  'createdAt': createdAt,
};

Map<String, Object?> _shared(List<Map<String, Object?>> artifacts) => {
  'kind': 'token',
  'appId': 'ca_1',
  'appName': 'game',
  'title': '테스트 게임',
  'summary': null,
  'teamName': 'Team A',
  'expiresAt': 1790600000,
  'topic': 'yyt.catalog.dev.ca_1',
  'artifacts': artifacts,
};

void main() {
  final requests = <http.Request>[];

  Future<void> pump(WidgetTester tester, MockClient client) async {
    await tester.pumpWidget(
      MaterialApp(
        home: SharedAppScreen(
          link: const ShareLink(
            server: 'https://console-dev.yyt.life',
            ref: _token,
          ),
          client: client,
          findInstalledVersionFn: (_) async => null,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  setUp(requests.clear);

  testWidgets('shows the shared app and its installable APK, signed out', (
    tester,
  ) async {
    final client = MockClient((r) async {
      requests.add(r);
      return jsonResponse(
        _shared([
          _artifact('a_ios', 'ios', 'game.ipa', createdAt: 1790000500),
          _artifact('a_old', 'android', 'old.apk', version: '1.1.0'),
          _artifact('a_new', 'android', 'game.apk', createdAt: 1790000100),
        ]),
      );
    });
    await pump(tester, client);

    expect(requests, hasLength(1));
    expect(
      requests.single.url.toString(),
      'https://console-dev.yyt.life/catalog/share/$_token',
    );
    expect(requests.single.headers.containsKey('Authorization'), isFalse);
    expect(find.text('테스트 게임'), findsWidgets);
    expect(find.text('팀: Team A'), findsOneWidget);
    expect(find.text('버전: 1.2.0'), findsOneWidget);
    expect(find.textContaining('링크 만료: '), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '설치'), findsOneWidget);
  });

  testWidgets('a newest .aab means no Android install', (tester) async {
    final client = MockClient(
      (r) async => jsonResponse(
        _shared([
          _artifact('a_apk', 'android', 'game.apk'),
          _artifact('a_aab', 'android', 'game.aab', createdAt: 1790000900),
        ]),
      ),
    );
    await pump(tester, client);

    expect(find.widgetWithText(FilledButton, '설치'), findsNothing);
    expect(find.textContaining('설치할 수 있는 APK 빌드가 없습니다'), findsOneWidget);
  });

  testWidgets('404 says the link is unavailable', (tester) async {
    final client = MockClient(
      (r) async => jsonResponse({
        'error': {'code': 'not_found', 'message': 'not found'},
      }, 404),
    );
    await pump(tester, client);

    expect(find.text('링크를 사용할 수 없습니다'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('a server error offers a retry', (tester) async {
    var calls = 0;
    final client = MockClient((r) async {
      calls++;
      return calls == 1
          ? http.Response('oops', 502)
          : jsonResponse(_shared([_artifact('a', 'android', 'game.apk')]));
    });
    await pump(tester, client);

    expect(find.text('공유 정보를 불러오지 못했습니다'), findsOneWidget);
    await tester.tap(find.text('다시 시도'));
    await tester.pumpAndSettle();
    expect(find.text('팀: Team A'), findsOneWidget);
  });
}
