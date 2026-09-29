import 'dart:convert';

import 'package:yyt_console/projects/limits_section.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'widget_test_support.dart';

Map<String, dynamic> _row({
  String key = 'asset.fileBytes',
  String unit = 'bytes',
  int soft = 2097152,
  Object hard = 268435456,
  Object effective = 2097152,
  int? usage = 1000,
  int? step,
  int? next,
  Map<String, dynamic>? override,
}) => {
  'key': key,
  'unit': unit,
  'soft': soft,
  'hard': hard,
  'effective': effective,
  'usage': usage,
  'step': step,
  'next': next,
  'override': override,
};

Map<String, dynamic> _pending({String createdByLogin = 'alice'}) => {
  'id': 'lr_1',
  'teamId': 'team_1',
  'scope': {'kind': 'bundle', 'id': 'ab_1', 'name': 'maps'},
  'key': 'asset.bundleBytes',
  'unit': 'bytes',
  'hard': 3221225472,
  'requestedValue': 104857600,
  'reason': 'r',
  'status': 'pending',
  'createdBy': 'm_1',
  'createdByLogin': createdByLogin,
  'createdAt': 1700000000,
};

/// A fake console: the scope's rows and pending requests, and what the
/// panel sent.
class _Server {
  _Server({required this.limits, this.pending = const []});
  List<Map<String, dynamic>> limits;
  List<Map<String, dynamic>> pending;
  int status = 200;
  Map<String, dynamic>? refusal;
  final calls = <String>[];
  final bodies = <Object?>[];

  http.Client get client => MockClient((req) async {
    calls.add('${req.method} ${req.url.path}');
    if (req.url.path == '/limits') {
      if (status != 200) return http.Response('', status);
      return jsonResponse({
        'scope': {'kind': 'bundle', 'id': 'ab_1'},
        'teamId': 'team_1',
        'limits': limits,
        'pending': pending,
      });
    }
    if (req.url.path == '/limit-requests') {
      bodies.add(jsonDecode(req.body));
      if (refusal != null) return jsonResponse({'error': refusal}, 400);
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      final row = {
        ..._pending(),
        'key': body['key'],
        'requestedValue': body['value'],
      };
      pending = [...pending, row];
      return jsonResponse(row, 201);
    }
    if (req.url.path.endsWith('/cancel')) {
      pending = const [];
      return jsonResponse({..._pending(), 'status': 'cancelled'});
    }
    return http.Response('', 404);
  });
}

Widget _app(_Server s, {String role = 'member', String? login = 'alice'}) =>
    MaterialApp(
      home: Scaffold(
        body: ListView(
          children: [
            LimitsSection(
              api: ProjectsApi(token: 'tok', client: s.client),
              scopeKind: 'bundle',
              scopeId: 'ab_1',
              team: Team(id: 'team_1', name: 'crew', role: role),
              currentLogin: login,
              onUnauthorized: () async {},
            ),
          ],
        ),
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final platform = TestPlatform();
  setUp(platform.install);
  tearDown(platform.uninstall);

  testWidgets(
    'shows usage, effective and ceiling per row, and the grant chip',
    (tester) async {
      final s = _Server(
        limits: [
          _row(
            usage: 10485760,
            effective: 33554432,
            override: {
              'value': 33554432,
              'expiresAt': null,
              'note': 'ok',
              'grantedByLogin': 'boss',
              'grantedAt': 1700000000,
            },
          ),
          _row(
            key: 'asset.versionsPerBundle',
            unit: 'count',
            soft: 50,
            hard: 500,
            effective: 50,
            usage: 60,
          ),
        ],
      );
      await tester.pumpWidget(_app(s));
      await tester.pumpAndSettle();
      expect(find.text('한도'), findsOneWidget);
      expect(find.text('파일 크기'), findsOneWidget);
      expect(find.text('10 MiB / 32 MiB · 상한 256 MiB'), findsOneWidget);
      expect(find.text('승인됨'), findsOneWidget);
      expect(find.text('60 / 50 · 상한 500'), findsOneWidget);
      expect(find.text('한도 초과'), findsOneWidget);
      expect(find.widgetWithText(TextButton, '요청'), findsNWidgets(2));
      expect(s.calls, ['GET /limits']);
    },
  );

  testWidgets(
    'a reader sees no request button; a stepped key below its limit offers none either',
    (tester) async {
      final s = _Server(
        limits: [
          _row(
            key: 'team.projects',
            unit: 'count',
            soft: 20,
            hard: 1000,
            effective: 20,
            usage: 3,
            step: 5,
          ),
        ],
      );
      // A plain row would offer a request to a member; a seatless admin
      // (a reader) gets no button on it.
      final reader = _Server(limits: [_row()]);
      await tester.pumpWidget(_app(reader, role: 'admin'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextButton, '요청'), findsNothing);
      await tester.pumpWidget(_app(reader));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextButton, '요청'), findsOneWidget);
      // A stepped key below its limit offers none to anyone. (A new server
      // needs a new element: the card's state survives a same-slot pump.)
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(_app(s));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextButton, '요청'), findsNothing);
      expect(find.textContaining('모든 슬롯'), findsOneWidget);
    },
  );

  testWidgets(
    'a request dialog validates the value and sends the reason; the panel reloads',
    (tester) async {
      final s = _Server(limits: [_row()]);
      await tester.pumpWidget(_app(s));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, '요청'));
      await tester.pumpAndSettle();
      expect(find.text('파일 크기 한도 요청'), findsOneWidget);
      await tester.enterText(find.widgetWithText(TextField, '요청 값'), '1MiB');
      await tester.tap(find.text('요청 보내기'));
      await tester.pumpAndSettle();
      expect(find.textContaining('보다 커야'), findsOneWidget);
      await tester.enterText(find.widgetWithText(TextField, '요청 값'), '64MiB');
      await tester.tap(find.text('요청 보내기'));
      await tester.pumpAndSettle();
      expect(find.text('이유를 적어주세요.'), findsOneWidget);
      await tester.enterText(
        find.widgetWithText(TextField, '이유'),
        'music packs',
      );
      await tester.tap(find.text('요청 보내기'));
      await tester.pumpAndSettle();
      expect(s.bodies.single, {
        'scope': 'bundle:ab_1',
        'key': 'asset.fileBytes',
        'value': 64 << 20,
        'reason': 'music packs',
      });
      expect(s.calls, ['GET /limits', 'POST /limit-requests', 'GET /limits']);
      // Reloaded: the row now has a pending request, so its button is gone
      // and the request is listed with its cancel.
      expect(find.text('대기 중인 요청'), findsOneWidget);
      expect(find.widgetWithText(TextButton, '요청'), findsNothing);
      expect(find.widgetWithText(TextButton, '철회'), findsOneWidget);
    },
  );

  testWidgets('a stepped key is asked for as next with a fixed value', (
    tester,
  ) async {
    final s = _Server(
      limits: [
        _row(
          key: 'team.projects',
          unit: 'count',
          soft: 20,
          hard: 1000,
          effective: 20,
          usage: 20,
          step: 5,
          next: 25,
        ),
      ],
    );
    await tester.pumpWidget(_app(s));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '요청'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextField, '요청 값'), findsNothing);
    expect(find.textContaining('요청 값: 25'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, '이유'), 'more');
    await tester.tap(find.text('요청 보내기'));
    await tester.pumpAndSettle();
    expect(s.bodies.single, {
      'scope': 'bundle:ab_1',
      'key': 'team.projects',
      'value': 25,
      'reason': 'more',
    });
  });

  testWidgets('the server refusal of a stepped value names the next one', (
    tester,
  ) async {
    final s = _Server(
      limits: [
        _row(
          key: 'team.projects',
          unit: 'count',
          soft: 20,
          hard: 1000,
          effective: 20,
          usage: 20,
          step: 5,
          next: 25,
        ),
      ],
    );
    s.refusal = {
      'code': 'bad_request',
      'message': 'ask for 30',
      'details': {
        'limit': 'team.projects',
        'value': 25,
        'usage': 25,
        'next': 30,
      },
    };
    await tester.pumpWidget(_app(s));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '요청'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, '이유'), 'more');
    await tester.tap(find.text('요청 보내기'));
    await tester.pumpAndSettle();
    expect(find.textContaining('요청 가능한 값은 30뿐입니다'), findsOneWidget);
  });

  testWidgets('only the requester or an owner may cancel a pending request', (
    tester,
  ) async {
    final s = _Server(
      limits: [_row()],
      pending: [_pending(createdByLogin: 'bob')],
    );
    await tester.pumpWidget(_app(s, login: 'alice'));
    await tester.pumpAndSettle();
    expect(find.textContaining('번들 크기 → 100 MiB'), findsOneWidget);
    expect(find.widgetWithText(TextButton, '철회'), findsNothing);
    // The requester, while seated, may; the same login without a seat
    // (a seatless admin) may not.
    await tester.pumpWidget(_app(s, login: 'bob'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextButton, '철회'), findsOneWidget);
    await tester.pumpWidget(_app(s, role: 'admin', login: 'bob'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextButton, '철회'), findsNothing);
    await tester.pumpWidget(_app(s, role: 'owner', login: 'alice'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '철회'));
    await tester.pumpAndSettle();
    expect(find.text('요청을 철회할까요?'), findsOneWidget);
    expect(find.text('요청 유지'), findsOneWidget);
    await tester.tap(find.text('요청 철회'));
    await tester.pumpAndSettle();
    expect(s.calls.last, 'GET /limits');
    expect(s.calls, contains('POST /limit-requests/lr_1/cancel'));
    expect(find.text('대기 중인 요청'), findsNothing);
  });

  testWidgets(
    'a lifetime already without expiry offers no request; a changed reload token re-reads',
    (tester) async {
      final s = _Server(
        limits: [
          _row(
            key: 'channel.lifetime',
            unit: 'seconds',
            soft: 2419200,
            hard: 'unlimited',
            effective: 'unlimited',
            usage: null,
            override: {
              'value': 'unlimited',
              'expiresAt': null,
              'note': 'n',
              'grantedByLogin': 'boss',
              'grantedAt': 1700000000,
            },
          ),
        ],
      );
      Widget app(Object token) => MaterialApp(
        home: Scaffold(
          body: ListView(
            children: [
              LimitsSection(
                api: ProjectsApi(token: 'tok', client: s.client),
                scopeKind: 'channel',
                scopeId: 'auth_1',
                team: const Team(id: 'team_1', name: 'crew', role: 'member'),
                currentLogin: 'alice',
                onUnauthorized: () async {},
                reloadToken: token,
              ),
            ],
          ),
        ),
      );
      await tester.pumpWidget(app(1));
      await tester.pumpAndSettle();
      expect(find.text('만료 없음'), findsOneWidget);
      expect(find.text('승인됨'), findsOneWidget);
      expect(find.widgetWithText(TextButton, '요청'), findsNothing);
      expect(s.calls, ['GET /limits']);
      await tester.pumpWidget(app(2));
      await tester.pumpAndSettle();
      expect(s.calls, ['GET /limits', 'GET /limits']);
    },
  );

  testWidgets('an older console without /limits shows a hint, not an error', (
    tester,
  ) async {
    final s = _Server(limits: const [])..status = 404;
    await tester.pumpWidget(_app(s));
    await tester.pumpAndSettle();
    expect(find.textContaining('지원하지 않습니다'), findsOneWidget);
    expect(find.text('다시 시도'), findsNothing);
  });
}
