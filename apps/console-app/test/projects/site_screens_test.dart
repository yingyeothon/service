import 'dart:convert';

import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/site_detail_screen.dart';
import 'package:yyt_console/projects/site_form_screen.dart';
import 'package:yyt_console/projects/site_models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'widget_test_support.dart';

const _team = Team(id: 'team_1', name: 'crew', role: 'member');
const _project = Project(
  id: 'prj_1',
  teamId: 'team_1',
  name: 'game',
  description: '',
);

Map<String, dynamic> _view({
  String slug = 'abcdefghi',
  String? domain,
  bool busy = false,
  String? movingTo,
  String? hostSuffix = 'g.example',
}) => {
  'id': 'st_1',
  'name': 'web-build',
  'slug': slug,
  'description': null,
  'createdBy': 'me',
  'publicUrl': 'https://g.example/$slug/',
  'basePath': '/$slug/',
  'hostUrl': hostSuffix == null ? null : 'https://$slug.$hostSuffix/',
  'hostSuffix': hostSuffix,
  'domain': domain,
  'movingTo': movingTo,
  'currentDeployId': 'sd_1',
  'busy': busy,
  'createdAt': 1700000000,
  'updatedAt': 1700000000,
};

Map<String, dynamic> _detail(Map<String, dynamic> view) => {
  ...view,
  'currentDeploy': {
    'id': 'sd_1',
    'siteId': 'st_1',
    'status': 'live',
    'zipBytes': 100,
    'bytes': 2048,
    'files': 3,
    'createdBy': 'me',
    'createdAt': 1700000000,
  },
  'deploys': [
    if (view['domain'] != null)
      {
        'id': 'sd_2',
        'siteId': 'st_1',
        'status': 'live',
        'zipBytes': 0,
        'bytes': 0,
        'files': 0,
        'createdBy': 'me',
        'createdAt': 1700000100,
        'moveTo': view['domain'],
      },
    {
      'id': 'sd_1',
      'siteId': 'st_1',
      'status': 'live',
      'zipBytes': 100,
      'bytes': 2048,
      'files': 3,
      'createdBy': 'me',
      'createdAt': 1700000000,
    },
  ],
  'warning': 'SHARED-ORIGIN-WARNING verbatim',
};

/// A fake console for one site. [onPatch] answers PATCH; a queued move keeps
/// the site busy for [busyReads] GETs, then lands.
class _SiteServer {
  _SiteServer({
    this.onPatch,
    this.busyReads = 1,
    this.hostSuffix = 'g.example',
  });

  final http.Response Function(Map<String, dynamic> body)? onPatch;
  final String? hostSuffix;
  int busyReads;
  String? movingTo;
  String? domain;

  /// Deleted elsewhere: every GET answers 404.
  bool gone = false;
  final calls = <String>[];
  final bodies = <Object?>[];

  int get gets => calls.where((c) => c == 'GET /sites/st_1').length;

  http.Client get client => MockClient((req) async {
    calls.add('${req.method} ${req.url.path}');
    bodies.add(req.body.isEmpty ? null : jsonDecode(req.body));
    switch (req.method) {
      case 'GET':
        if (gone) {
          return jsonResponse({
            'error': {'code': 'not_found', 'message': 'site not found'},
          }, 404);
        }
        if (movingTo != null && busyReads > 0) {
          busyReads -= 1;
          return jsonResponse(
            _detail(
              _view(busy: true, movingTo: movingTo, hostSuffix: hostSuffix),
            ),
          );
        }
        if (movingTo != null) {
          domain = movingTo;
          movingTo = null;
        }
        return jsonResponse(
          _detail(
            _view(
              slug: domain ?? 'abcdefghi',
              domain: domain,
              hostSuffix: hostSuffix,
            ),
          ),
        );
      case 'PATCH':
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        return onPatch!(body);
      case 'DELETE':
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
    _SiteServer server, {
    Team team = _team,
  }) async {
    await tester.binding.setSurfaceSize(const Size(800, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final api = ProjectsApi(token: 'tok', client: server.client);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder:
              (context) => Scaffold(
                body: Center(
                  child: TextButton(
                    onPressed:
                        () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder:
                                (_) => SiteDetailScreen(
                                  authState: AuthState(),
                                  team: team,
                                  api: api,
                                  siteId: 'st_1',
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

  testWidgets('detail shows the warning verbatim, both URLs and deploys', (
    tester,
  ) async {
    final server = _SiteServer();
    await pumpDetail(tester, server);
    expect(find.text('SHARED-ORIGIN-WARNING verbatim'), findsOneWidget);
    expect(find.text('https://abcdefghi.g.example/'), findsOneWidget);
    expect(find.text('https://g.example/abcdefghi/'), findsOneWidget);
    expect(find.text('없음 (무작위 주소 abcdefghi)'), findsOneWidget);
    expect(find.textContaining('yyt site deploy'), findsOneWidget);
    expect(find.text('업로드 · 파일 3개 · 2.0 KB'), findsNWidgets(2));
    // Only one read: an idle site is not polled.
    await tester.pump(const Duration(seconds: 10));
    expect(server.gets, 1);
  });

  testWidgets('create has no domain field; edit shows it with the suffix', (
    tester,
  ) async {
    final api = ProjectsApi(
      token: 'tok',
      client: MockClient((_) async => http.Response('', 500)),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: SiteFormScreen.create(
          api: api,
          project: _project,
          onUnauthorized: () async {},
        ),
      ),
    );
    expect(find.text('사이트 이름 (주소)'), findsNothing);
    expect(find.textContaining('다시 빌드해야 합니다'), findsNothing);
    // The shared-origin rule, before the server can say it.
    expect(find.text(siteSharedOriginWarning), findsOneWidget);

    final server = _SiteServer();
    await pumpDetail(tester, server);
    await tester.tap(find.byTooltip('사이트 편집'));
    await tester.pumpAndSettle();
    expect(find.text('사이트 이름 (주소)'), findsOneWidget);
    expect(find.text('.g.example'), findsOneWidget);
    // A claim changes the slug: a build for the old base path is rebuilt.
    expect(
      find.textContaining('기본 경로 /abcdefghi/(으)로 빌드했다면 다시 빌드해야 합니다'),
      findsOneWidget,
    );
    expect(
      find.textContaining('상대 경로(./)는 두 주소 모두에서, /는 사이트 전용 주소에서만'),
      findsOneWidget,
    );
    expect(find.text(siteSharedOriginWarning), findsNothing);
    await tester.enterText(
      find.widgetWithText(TextField, '사이트 이름 (주소)'),
      'My-Game',
    );
    await tester.pump();
    expect(find.textContaining('https://my-game.g.example/'), findsOneWidget);
  });

  testWidgets('without the name host the domain reads as a path', (
    tester,
  ) async {
    final server = _SiteServer(hostSuffix: null);
    await pumpDetail(tester, server);
    // No own origin: the path URL is the one address.
    expect(find.text('https://g.example/abcdefghi/'), findsOneWidget);
    expect(find.text('경로 주소'), findsNothing);
    await tester.tap(find.byTooltip('사이트 편집'));
    await tester.pumpAndSettle();
    expect(find.text('.g.example'), findsNothing);
    expect(find.textContaining('주소: g.example/<이름>/'), findsOneWidget);
    expect(find.textContaining('주소가 바뀌어도 그대로 동작합니다'), findsOneWidget);
  });

  testWidgets('a taken name is reported under the domain field', (
    tester,
  ) async {
    final server = _SiteServer(
      onPatch:
          (_) => jsonResponse({
            'error': {
              'code': 'conflict',
              'message': 'domain is taken',
              'details': {'reason': 'domain_taken'},
            },
          }, 409),
    );
    await pumpDetail(tester, server);
    await tester.tap(find.byTooltip('사이트 편집'));
    await tester.pumpAndSettle();
    final field = find.widgetWithText(TextField, '사이트 이름 (주소)');
    // A client-side hint first: no request for an invalid name.
    await tester.enterText(field, 'a--b');
    await tester.tap(find.text('저장'));
    await tester.pumpAndSettle();
    expect(find.text('-를 연달아 쓸 수 없습니다.'), findsOneWidget);
    expect(server.calls.where((c) => c.startsWith('PATCH')), isEmpty);

    await tester.enterText(field, 'taken');
    await tester.tap(find.text('저장'));
    await tester.pumpAndSettle();
    expect(server.bodies.last, {'domain': 'taken'});
    expect(find.text('이미 쓰이고 있거나 다른 팀이 쓴 적 있는 이름입니다.'), findsOneWidget);
    // Still on the form, nothing else sent.
    expect(find.text('사이트 이름 (주소)'), findsOneWidget);
  });

  testWidgets('domain_cap lists the counted names under the field', (
    tester,
  ) async {
    final server = _SiteServer(
      onPatch:
          (_) => jsonResponse({
            'error': {
              'code': 'conflict',
              'message': 'too many site names',
              'details': {
                'reason': 'domain_cap',
                'names': [
                  {'name': 'one', 'releasedAt': null},
                  {'name': 'two', 'releasedAt': 1700000000},
                ],
              },
            },
          }, 409),
    );
    await pumpDetail(tester, server);
    await tester.tap(find.byTooltip('사이트 편집'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, '사이트 이름 (주소)'),
      'three',
    );
    await tester.tap(find.text('저장'));
    await tester.pumpAndSettle();
    expect(find.textContaining('팀의 이름 한도(20개)에 도달했습니다.'), findsOneWidget);
    expect(find.textContaining('세는 이름: one, two.'), findsOneWidget);
  });

  testWidgets('a busy site locks the domain and never sends it', (
    tester,
  ) async {
    final server = _SiteServer(
      busyReads: 100,
      onPatch: (body) => jsonResponse(_view(busy: true, movingTo: 'my-game')),
    )..movingTo = 'my-game';
    await pumpDetail(tester, server);
    await tester.tap(find.byTooltip('사이트 편집'));
    await tester.pumpAndSettle();
    final field = find.widgetWithText(TextField, '사이트 이름 (주소)');
    expect(tester.widget<TextField>(field).enabled, isFalse);
    expect(find.text(SiteFormScreen.domainHeldHint), findsOneWidget);
    // The name still saves; the domain key stays out of the body.
    await tester.enterText(find.widgetWithText(TextField, '이름'), 'web2');
    await tester.tap(find.text('저장'));
    await tester.pumpAndSettle();
    expect(server.calls.where((c) => c.startsWith('PATCH')), hasLength(1));
    expect(server.bodies.whereType<Map<String, dynamic>>().last, {
      'name': 'web2',
    });
  });

  testWidgets('a site deleted while polling shows the gone state and stops', (
    tester,
  ) async {
    final server = _SiteServer(busyReads: 100)..movingTo = 'my-game';
    await pumpDetail(tester, server);
    expect(find.text('이동 중'), findsOneWidget);
    server.gone = true;
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.text('이 사이트는 삭제되었거나 더 이상 볼 수 없습니다.'), findsOneWidget);
    expect(find.byTooltip('사이트 편집'), findsNothing);
    final reads = server.gets;
    await tester.pump(const Duration(seconds: 10));
    expect(server.gets, reads);
  });

  testWidgets('a queued move (202) polls every 3 s until the site settles', (
    tester,
  ) async {
    final server = _SiteServer(
      busyReads: 1,
      onPatch:
          (body) => jsonResponse(
            _view(busy: true, movingTo: body['domain'] as String),
            202,
          ),
    );
    await pumpDetail(tester, server);
    await tester.tap(find.byTooltip('사이트 편집'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, '사이트 이름 (주소)'),
      'my-game',
    );
    await tester.tap(find.text('저장'));
    server.movingTo = 'my-game';
    await tester.pumpAndSettle();
    expect(server.bodies.firstWhere((b) => b != null), {'domain': 'my-game'});
    expect(find.textContaining('새 이름으로 옮기는 중'), findsOneWidget);
    expect(find.text('이동 중'), findsOneWidget);
    expect(find.textContaining('my-game(으)로 옮기는 중입니다'), findsOneWidget);
    expect(server.gets, 2);

    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(server.gets, 3);
    expect(find.text('이동 중'), findsNothing);
    expect(find.text('my-game'), findsOneWidget);
    expect(find.text('이름 이동 → my-game'), findsOneWidget);

    // Settled: no more reads.
    await tester.pump(const Duration(seconds: 10));
    expect(server.gets, 3);
  });

  testWidgets('delete asks first, repeating the verb, then leaves', (
    tester,
  ) async {
    final server = _SiteServer();
    await pumpDetail(tester, server);
    await tester.tap(find.byTooltip('더보기'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('사이트 삭제'));
    await tester.pumpAndSettle();
    expect(find.text('web-build 사이트를 삭제할까요?'), findsOneWidget);
    await tester.tap(find.text('취소'));
    await tester.pumpAndSettle();
    expect(server.calls.where((c) => c.startsWith('DELETE')), isEmpty);

    await tester.tap(find.byTooltip('더보기'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('사이트 삭제'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '사이트 삭제'));
    await tester.pumpAndSettle();
    expect(server.calls.last, 'DELETE /sites/st_1');
    expect(find.byType(SiteDetailScreen), findsNothing);
    expect(find.text('open'), findsOneWidget);
  });

  testWidgets('delete is disabled while the site is busy', (tester) async {
    final server = _SiteServer(busyReads: 100)..movingTo = 'my-game';
    await pumpDetail(tester, server);
    await tester.tap(find.byTooltip('더보기'));
    await tester.pumpAndSettle();
    final item = tester.widget<PopupMenuItem<String>>(
      find.byType(PopupMenuItem<String>),
    );
    expect(item.enabled, isFalse);
    // Leaving stops the polling (no timer outlives the screen).
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();
    await tester.pageBack();
    await tester.pumpAndSettle();
    final reads = server.gets;
    await tester.pump(const Duration(seconds: 10));
    expect(server.gets, reads);
  });

  testWidgets('a reader has neither edit nor delete', (tester) async {
    await pumpDetail(
      tester,
      _SiteServer(),
      team: const Team(id: 'team_1', name: 'crew', role: 'admin'),
    );
    expect(find.byTooltip('사이트 편집'), findsNothing);
    expect(find.byTooltip('더보기'), findsNothing);
  });
}
