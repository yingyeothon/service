import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/share/share_models.dart';
import 'package:yyt_console/share/share_sheet.dart';

import '../projects/widget_test_support.dart';

const _base = 'https://console-dev.yyt.life';
const _url = '$_base/i/shr_0123456789abcdef0123456789abcdef';

void main() {
  final platform = TestPlatform();
  setUp(platform.install);
  tearDown(platform.uninstall);

  Future<List<String>> pump(
    WidgetTester tester,
    MockClient client, {
    bool canCreate = true,
  }) async {
    final shared = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppShareSheet(
            api: ProjectsApi(token: 'yyt_t', client: client, baseUrl: _base),
            appId: 'ca_1',
            title: '테스트 게임',
            version: '1.2.0',
            canCreate: canCreate,
            share: (text, _) async => shared.add(text),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return shared;
  }

  testWidgets('shares and copies the public link', (tester) async {
    final client = MockClient(
      (r) async => jsonResponse({
        'links': [],
        'publicUrl': '$_base/i/ca_1',
        'limit': 20,
      }),
    );
    final shared = await pump(tester, client, canCreate: false);

    await tester.tap(find.text('공개 링크 공유'));
    await tester.pumpAndSettle();
    expect(shared, ['테스트 게임 1.2.0 설치: $_base/i/ca_1']);

    await tester.tap(find.text('링크 복사'));
    await tester.pumpAndSettle();
    expect(platform.clipboard, '$_base/i/ca_1');
    expect(find.text('새 링크 만들기'), findsNothing);
  });

  testWidgets('creates a token link with the chosen expiry and shares it', (
    tester,
  ) async {
    final posts = <http.Request>[];
    final client = MockClient((r) async {
      if (r.method == 'GET') {
        expect(r.url.path, '/catalog/apps/ca_1/share-links');
        expect(r.headers['Authorization'], 'Bearer yyt_t');
        return jsonResponse({'links': [], 'publicUrl': null, 'limit': 20});
      }
      posts.add(r);
      return jsonResponse({
        'id': 'shl_1',
        'label': 'QA',
        'createdBy': 'alice',
        'createdAt': 1790000000,
        'expiresAt': 1790000000 + 30 * 86400,
        'revokedAt': null,
        'live': true,
        'url': _url,
      }, 201);
    });
    final shared = await pump(tester, client);
    expect(find.text('공개 링크 공유'), findsNothing);

    await tester.tap(find.text('30일'));
    await tester.enterText(find.byType(TextField), ' QA ');
    await tester.tap(find.widgetWithText(FilledButton, '새 링크 만들기'));
    await tester.pumpAndSettle();

    expect(posts, hasLength(1));
    expect(jsonDecode(posts.single.body), {'expiresInDays': 30, 'label': 'QA'});
    expect(shared, ['테스트 게임 1.2.0 설치: $_url']);
    expect(find.text(_url), findsOneWidget);

    await tester.tap(find.text('링크 복사'));
    await tester.pumpAndSettle();
    expect(platform.clipboard, _url);
  });

  testWidgets('the 21st link explains the cap', (tester) async {
    final client = MockClient((r) async {
      if (r.method == 'GET') {
        return jsonResponse({'links': [], 'publicUrl': null, 'limit': 20});
      }
      return jsonResponse({
        'error': {
          'code': 'conflict',
          'message': 'too many live share links (max 20 per app)',
          'details': {'limit': 20, 'value': 20},
        },
      }, 409);
    });
    final shared = await pump(tester, client);

    await tester.tap(find.widgetWithText(FilledButton, '새 링크 만들기'));
    await tester.pumpAndSettle();
    expect(find.textContaining('최대 20개'), findsOneWidget);
    expect(shared, isEmpty);
  });

  testWidgets('a label over 100 UTF-16 units blocks create', (tester) async {
    final client = MockClient(
      (r) async => jsonResponse({'links': [], 'publicUrl': null, 'limit': 20}),
    );
    await pump(tester, client);

    // 50 emoji: 50 graphemes, 100 UTF-16 units — the server's limit exactly.
    await tester.enterText(find.byType(TextField), '😀' * 50);
    await tester.pump();
    expect(find.text('100/100'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '새 링크 만들기'))
          .onPressed,
      isNotNull,
    );

    await tester.enterText(find.byType(TextField), '${'😀' * 50}a');
    await tester.pump();
    expect(find.textContaining('100자 이하'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '새 링크 만들기'))
          .onPressed,
      isNull,
    );
  });

  test('shareMessage drops an unknown version', () {
    expect(shareMessage('게임', 'unknown', 'u'), '게임 설치: u');
    expect(shareMessage('게임', '1.0.0', 'u'), '게임 1.0.0 설치: u');
  });
}
