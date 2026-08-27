import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/projects_screen.dart';
import 'package:yyt_console/projects/team_expansion_store.dart';
import 'package:yyt_console/projects/team_issues_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json'},
);

Map<String, dynamic> _issue(String project, int n, int updatedAt) => {
  'id': '${project}_$n',
  'projectId': project,
  'number': n,
  'title': 'issue $n',
  'status': 'open',
  'createdBy': 'me',
  'createdAt': 1700000000,
  'updatedAt': updatedAt,
};

/// Two teams; `alpha` has two projects, `beta` one. The team feed of `alpha`
/// interleaves both projects (the server already sorted and capped it).
http.Client _client(List<String> calls) => MockClient((req) async {
  calls.add('${req.url.path}${req.url.hasQuery ? '?${req.url.query}' : ''}');
  switch (req.url.path) {
    case '/teams':
      return _json({
        'teams': [
          {'id': 'team_b', 'name': 'beta', 'role': 'member'},
          {'id': 'team_a', 'name': 'alpha', 'role': 'member'},
        ],
      });
    case '/teams/team_a/projects':
      return _json({
        'projects': [
          {'id': 'prj_1', 'teamId': 'team_a', 'name': 'first'},
          {'id': 'prj_2', 'teamId': 'team_a', 'name': 'second'},
        ],
      });
    case '/teams/team_b/projects':
      return _json({
        'projects': [
          {'id': 'prj_3', 'teamId': 'team_b', 'name': 'third'},
        ],
      });
    case '/teams/team_a/discussions':
      return _json({
        'discussions': [
          {
            'id': 'd1',
            'teamId': 'team_a',
            'title': 'kickoff',
            'createdBy': 'me',
            'createdAt': 1,
            'updatedAt': 1,
            'mine': true,
          },
        ],
      });
    case '/teams/team_b/discussions':
      return _json({'discussions': const []});
    case '/teams/team_a/issues':
      final limit = req.url.queryParameters['limit'];
      final all = [
        _issue('prj_2', 9, 9),
        _issue('prj_1', 7, 7),
        _issue('prj_1', 6, 6),
        _issue('prj_2', 5, 5),
        _issue('prj_1', 4, 4),
        _issue('prj_1', 3, 3),
      ];
      return _json({
        'issues': limit == null ? all : all.take(int.parse(limit)).toList(),
      });
    case '/teams/team_b/issues':
      return _json({'issues': const []});
  }
  return http.Response('', 404);
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    AuthConfig.setServerUrl('console-dev.yyt.life');
    // AuthState reads profiles from secure storage on construction.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
          (call) async => call.method == 'readAll' ? <String, String>{} : null,
        );
  });
  tearDown(AuthConfig.clearServerUrl);

  Future<void> pump(
    WidgetTester tester,
    http.Client client,
    TeamExpansionStore store,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 3200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: ProjectsScreen(
          authState: AuthState(),
          api: ProjectsApi(token: 'tok', client: client),
          expansionStore: store,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('first team opens with its five latest issues across projects; '
      'the other team stays closed until tapped and the choice is saved', (
    tester,
  ) async {
    final calls = <String>[];
    final store = MemoryTeamExpansionStore();
    await pump(tester, _client(calls), store);

    // Teams sort by name: alpha first and open, beta closed (no fetch yet).
    expect(calls.where((c) => c.contains('/issues')).toList(), [
      '/teams/team_a/issues?limit=5',
    ]);
    expect(find.text('kickoff'), findsOneWidget);
    expect(find.text('#9 issue 9'), findsOneWidget);
    expect(find.text('#4 issue 4'), findsOneWidget);
    expect(find.text('#3 issue 3'), findsNothing);
    // Rows carry their project name; the project list is inside the team.
    expect(find.textContaining('second · me'), findsNWidgets(2));
    expect(find.text('first'), findsOneWidget);
    expect(find.text('third'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    // Opening beta loads its feed and is remembered.
    await tester.tap(find.text('beta'));
    await tester.pumpAndSettle();
    expect(calls.last, '/teams/team_b/issues?limit=5');
    expect(find.text('third'), findsOneWidget);
    expect(store.state, {'team_b': true});
    // An empty feed shows the message without a "더보기" that leads nowhere.
    expect(find.text('이슈가 없습니다.'), findsOneWidget);
    expect(find.text('더보기'), findsOneWidget);

    // Closing alpha is remembered too, and a refresh only refetches open
    // accordions.
    await tester.tap(find.text('alpha'));
    await tester.pumpAndSettle();
    expect(store.state, {'team_b': true, 'team_a': false});
    calls.clear();
    await tester.tap(find.byTooltip('새로고침'));
    await tester.pumpAndSettle();
    expect(calls.where((c) => c.contains('/issues')).toList(), [
      '/teams/team_b/issues?limit=5',
    ]);
  });

  testWidgets('the saved layout wins over the first-team default', (
    tester,
  ) async {
    final calls = <String>[];
    await pump(
      tester,
      _client(calls),
      MemoryTeamExpansionStore({'team_a': false, 'team_b': true}),
    );
    expect(calls.where((c) => c.contains('/issues')).toList(), [
      '/teams/team_b/issues?limit=5',
    ]);
    expect(find.text('third'), findsOneWidget);
    expect(find.text('#9 issue 9'), findsNothing);
  });

  testWidgets('더보기 opens the team-wide list sorted by the server', (
    tester,
  ) async {
    final calls = <String>[];
    await pump(tester, _client(calls), MemoryTeamExpansionStore());
    await tester.tap(find.text('더보기'));
    await tester.pumpAndSettle();
    expect(find.byType(TeamIssuesScreen), findsOneWidget);
    expect(calls.last, '/teams/team_a/issues?limit=200');
    expect(find.text('#3 issue 3'), findsOneWidget);
    expect(find.textContaining('second · me'), findsNWidgets(2));
  });
}
