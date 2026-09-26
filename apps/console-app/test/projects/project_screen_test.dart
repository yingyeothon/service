import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/project_screen.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'widget_test_support.dart';

const _project = Project(
  id: 'prj_1',
  teamId: 'team_1',
  name: 'game',
  description: '',
);

http.Client _client(List<String> calls) => MockClient((req) async {
  calls.add('${req.method} ${req.url.path}');
  switch (req.url.path) {
    case '/projects/prj_1/issues':
      return jsonResponse({
        'issues': [
          {
            'id': 'iss_1',
            'projectId': 'prj_1',
            'number': 1,
            'title': 'crash on start',
            'status': 'open',
            'createdBy': 'me',
            'createdAt': 1700000000,
            'updatedAt': 1700000000,
          },
        ],
      });
    case '/projects/prj_1/sites':
      return jsonResponse({
        'sites': [
          {
            'id': 'st_1',
            'name': 'web-build',
            'slug': 'abcdefghi',
            'publicUrl': 'https://g.example/abcdefghi/',
            'hostUrl': 'https://abcdefghi.g.example/',
            'basePath': '/abcdefghi/',
            'currentDeployId': 'sd_1',
            'busy': false,
            'createdAt': 1700000000,
            'updatedAt': 1700000000,
          },
        ],
      });
    case '/projects/prj_1/channels':
      return jsonResponse({
        'channels': [
          {
            'id': 'auth_1',
            'kind': 'auth',
            'name': 'login',
            'config': {'audience': 'game'},
            'createdAt': 1700000000,
            'expiresAt': 4102444800,
            'disabledAt': null,
            'status': 'active',
          },
        ],
      });
  }
  return http.Response('', 404);
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final platform = TestPlatform();
  setUp(platform.install);
  tearDown(platform.uninstall);

  Future<void> pump(
    WidgetTester tester, {
    required String role,
    required List<String> calls,
    ProjectTab initialTab = ProjectTab.issues,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: ProjectScreen(
          authState: AuthState(),
          team: Team(id: 'team_1', name: 'crew', role: role),
          project: _project,
          initialTab: initialTab,
          api: ProjectsApi(token: 'tok', client: _client(calls)),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('three tabs, each loaded once and kept alive', (tester) async {
    final calls = <String>[];
    await pump(tester, role: 'member', calls: calls);
    expect(find.text('crew / game'), findsOneWidget);
    expect(find.text('#1 crash on start'), findsOneWidget);
    expect(find.text('이슈 등록'), findsOneWidget);
    expect(find.textContaining('읽기 전용'), findsNothing);

    await tester.tap(find.text('사이트'));
    await tester.pumpAndSettle();
    expect(find.text('web-build'), findsOneWidget);
    // The site's own origin is what the row shows.
    expect(find.text('https://g.example/abcdefghi/'), findsOneWidget);
    expect(find.text('라이브'), findsOneWidget);
    expect(find.text('사이트 만들기'), findsOneWidget);

    await tester.tap(find.text('채널'));
    await tester.pumpAndSettle();
    expect(find.text('login'), findsOneWidget);
    expect(find.text('활성'), findsOneWidget);
    expect(find.text('채널 만들기'), findsOneWidget);

    await tester.tap(find.text('사이트'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('이슈'));
    await tester.pumpAndSettle();
    expect(calls, [
      'GET /projects/prj_1/issues',
      'GET /projects/prj_1/sites',
      'GET /projects/prj_1/channels',
    ]);
  });

  testWidgets('an unseated admin reads only and is told what it may do', (
    tester,
  ) async {
    final calls = <String>[];
    await pump(
      tester,
      role: 'admin',
      calls: calls,
      initialTab: ProjectTab.sites,
    );
    expect(calls, ['GET /projects/prj_1/sites']);
    expect(find.textContaining('플랫폼 관리자는 채널을 연장하거나 삭제'), findsOneWidget);
    expect(find.text('사이트 만들기'), findsNothing);
    await tester.tap(find.text('채널'));
    await tester.pumpAndSettle();
    expect(find.text('채널 만들기'), findsNothing);
    await tester.tap(find.text('이슈'));
    await tester.pumpAndSettle();
    expect(find.text('이슈 등록'), findsNothing);
  });

  testWidgets('a seat-less role gets the generic read-only notice', (
    tester,
  ) async {
    await pump(tester, role: 'pending', calls: []);
    expect(find.textContaining('팀 좌석(소유자·멤버)이 있어야'), findsOneWidget);
  });
}
