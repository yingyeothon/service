import 'dart:convert';

import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/tracer_detail_screen.dart';
import 'package:yyt_console/projects/tracer_models.dart';
import 'package:yyt_console/projects/tracers_tab.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'widget_test_support.dart';

const _team = Team(id: 'team_1', name: 'crew', role: 'member');
const _id = 'trc_01hf7yavygfgdxpjfmr5r0g6ca';
const _mib = 1024 * 1024;

Map<String, dynamic> _view({String key = 'a', bool configured = true}) => {
  'id': _id,
  'name': 'game-debug',
  'description': 'debug builds',
  'teamId': 'team_1',
  'teamName': 'crew',
  'projectId': 'prj_1',
  'projectName': 'game',
  'createdBy': 'me',
  'writeKey': key * 32,
  'dsn': configured ? 'https://${key * 32}@trace.example/$_id' : null,
  'readUrl': configured ? 'https://trace.example' : null,
  'noBackup': true,
  'createdAt': 1700000000,
  'updatedAt': 1700000000,
};

/// A fake console for one tracer resource and its limits.
class _TracerServer {
  _TracerServer({this.configured = true});

  final bool configured;
  String key = 'a';
  final calls = <String>[];
  final bodies = <Object?>[];

  http.Client get client => MockClient((req) async {
    calls.add('${req.method} ${req.url.path}');
    bodies.add(req.body.isEmpty ? null : jsonDecode(req.body));
    final path = req.url.path;
    if (path == '/limits') {
      return jsonResponse({
        'scope': {'kind': 'tracer', 'id': _id},
        'teamId': 'team_1',
        'limits': [
          {
            'key': 'tracer.dailyBytes',
            'unit': 'bytes',
            'soft': 50 * _mib,
            'hard': 300 * _mib,
            'effective': 50 * _mib,
            'usage': null,
            'step': 50 * _mib,
            'next': null,
            'override': null,
          },
        ],
        'pending': [],
      });
    }
    switch ('${req.method} $path') {
      case 'GET /tracers/$_id':
        return jsonResponse(_view(key: key, configured: configured));
      case 'POST /tracers/$_id/rotate-key':
        key = 'b';
        return jsonResponse(_view(key: key, configured: configured));
      case 'PATCH /tracers/$_id':
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        return jsonResponse({..._view(key: key), ...body});
      case 'DELETE /tracers/$_id':
        return http.Response('', 204);
    }
    return http.Response('', 404);
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final platform = TestPlatform();
  setUp(platform.install);
  tearDown(platform.uninstall);

  Future<void> pumpDetail(
    WidgetTester tester,
    _TracerServer server, {
    Team team = _team,
  }) async {
    await tester.binding.setSurfaceSize(const Size(800, 2600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final api = ProjectsApi(token: 'tok', client: server.client);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => TracerDetailScreen(
                      authState: AuthState(),
                      team: team,
                      api: api,
                      tracerId: _id,
                    ),
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('shows the DSN, key, no-backup notice, reads and the limit', (
    tester,
  ) async {
    final server = _TracerServer();
    await pumpDetail(tester, server);
    expect(find.text(tracerNoBackupNotice), findsOneWidget);
    expect(find.text('https://${'a' * 32}@trace.example/$_id'), findsOneWidget);
    expect(find.text('a' * 32), findsOneWidget);
    expect(find.textContaining('yyt tracer issues $_id'), findsOneWidget);
    expect(find.text('하루 디버그 데이터'), findsOneWidget);
    expect(
      find.textContaining('--tracer $_id tracer.dailyBytes'),
      findsOneWidget,
    );
    expect(server.calls, contains('GET /limits'));

    await tester.tap(find.byTooltip('DSN 복사'));
    await tester.pumpAndSettle();
    expect(platform.clipboard, 'https://${'a' * 32}@trace.example/$_id');
  });

  testWidgets('says when the stage has no tracer', (tester) async {
    await pumpDetail(tester, _TracerServer(configured: false));
    expect(find.text(tracerNotConfigured), findsOneWidget);
    expect(find.byTooltip('DSN 복사'), findsNothing);
    expect(find.textContaining('yyt tracer issues'), findsNothing);
    expect(find.text('쓰기 키 교체'), findsNothing);
  });

  testWidgets('an older console without tracer routes gets a hint, no create', (
    tester,
  ) async {
    final calls = <String>[];
    final api = ProjectsApi(
      token: 'tok',
      client: MockClient((req) async {
        calls.add('${req.method} ${req.url.path}');
        return jsonResponse({
          'error': {'code': 'not_found', 'message': 'no route'},
        }, 404);
      }),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: TracersTab(
          authState: AuthState(),
          team: _team,
          project: const Project(
            id: 'prj_1',
            teamId: 'team_1',
            name: 'game',
            description: '',
          ),
          api: api,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('아직 트레이서를 지원하지 않습니다'), findsOneWidget);
    expect(find.text('트레이서 만들기'), findsNothing);
    expect(calls, ['GET /projects/prj_1/tracers']);
  });

  test('create leaves a blank description out', () async {
    Object? sent;
    final api = ProjectsApi(
      token: 'tok',
      client: MockClient((req) async {
        sent = jsonDecode(req.body);
        return jsonResponse(_view(), 201);
      }),
    );
    await api.createTracer('prj_1', name: ' game-debug ', description: '  ');
    expect(sent, {'name': 'game-debug'});
  });

  testWidgets('rotates only after the confirm and shows the new key', (
    tester,
  ) async {
    final server = _TracerServer();
    await pumpDetail(tester, server);
    await tester.tap(find.text('쓰기 키 교체'));
    await tester.pumpAndSettle();
    expect(find.text(tracerRotateNotice), findsOneWidget);
    await tester.tap(find.text('취소'));
    await tester.pumpAndSettle();
    expect(server.calls, isNot(contains('POST /tracers/$_id/rotate-key')));

    await tester.tap(find.text('쓰기 키 교체'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('키 교체'));
    await tester.pumpAndSettle();
    expect(server.calls, contains('POST /tracers/$_id/rotate-key'));
    expect(find.text('b' * 32), findsOneWidget);
    expect(find.text('a' * 32), findsNothing);
  });

  testWidgets('edit sends only the changed name', (tester) async {
    final server = _TracerServer();
    await pumpDetail(tester, server);
    await tester.tap(find.byTooltip('트레이서 편집'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, '이름'), 'game-dbg');
    await tester.tap(find.text('저장'));
    await tester.pumpAndSettle();
    final i = server.calls.indexOf('PATCH /tracers/$_id');
    expect(i, isNot(-1));
    expect(server.bodies[i], {'name': 'game-dbg'});
    expect(find.text('game-dbg'), findsWidgets);
  });

  testWidgets('delete asks first, then pops', (tester) async {
    final server = _TracerServer();
    await pumpDetail(tester, server);
    await tester.tap(find.byTooltip('더보기'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('트레이서 삭제'));
    await tester.pumpAndSettle();
    expect(find.text(tracerDeleteNotice), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '트레이서 삭제'));
    await tester.pumpAndSettle();
    expect(server.calls, contains('DELETE /tracers/$_id'));
    expect(find.text('open'), findsOneWidget);
  });

  testWidgets('a read-only standing sees no write controls', (tester) async {
    await pumpDetail(
      tester,
      _TracerServer(),
      team: const Team(id: 'team_1', name: 'crew', role: 'pending'),
    );
    expect(find.byTooltip('트레이서 편집'), findsNothing);
    expect(find.text('쓰기 키 교체'), findsNothing);
  });
}
