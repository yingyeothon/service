import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/projects_screen.dart';
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

Map<String, dynamic> _issue(int n, int updatedAt) => {
  'id': 'iss_$n',
  'projectId': 'prj_1',
  'number': n,
  'title': 'issue $n',
  'status': 'open',
  'createdBy': 'me',
  'createdAt': 1700000000,
  'updatedAt': updatedAt,
};

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

  testWidgets('first project starts expanded with its five latest issues; '
      'discussions sit above; project list below', (tester) async {
    final issueCalls = <String>[];
    final client = MockClient((req) async {
      switch (req.url.path) {
        case '/teams':
          return _json({
            'teams': [
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
        case '/projects/prj_1/issues':
          issueCalls.add(req.url.path);
          return _json({
            'issues': [for (var n = 1; n <= 7; n += 1) _issue(n, n)],
          });
        case '/projects/prj_2/issues':
          issueCalls.add(req.url.path);
          return _json({'issues': const []});
      }
      return http.Response('', 404);
    });

    // Tall surface so the lazily built project list below is on screen.
    await tester.binding.setSurfaceSize(const Size(800, 3200));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      MaterialApp(
        home: ProjectsScreen(
          authState: AuthState(),
          api: ProjectsApi(token: 'tok', client: client),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Only the auto-expanded first project fetched issues.
    expect(issueCalls, ['/projects/prj_1/issues']);
    expect(find.text('kickoff'), findsOneWidget);
    expect(find.text('#7 issue 7'), findsOneWidget);
    expect(find.text('#3 issue 3'), findsOneWidget);
    expect(find.text('#2 issue 2'), findsNothing);
    // Accordion title + project-list entry.
    expect(find.text('first'), findsNWidgets(2));
    expect(find.text('second'), findsNWidgets(2));

    // Opening the second accordion loads its issues.
    await tester.tap(find.text('second').first);
    await tester.pumpAndSettle();
    expect(issueCalls, ['/projects/prj_1/issues', '/projects/prj_2/issues']);
    expect(find.text('이슈가 없습니다.'), findsOneWidget);

    // A refresh refetches every open accordion instead of stranding the
    // manually opened one on a spinner.
    await tester.tap(find.byTooltip('새로고침'));
    await tester.pumpAndSettle();
    expect(issueCalls.length, 4);
    expect(find.text('이슈가 없습니다.'), findsOneWidget);
    expect(find.text('#7 issue 7'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });
}
