import 'dart:convert';

import 'package:yyt_console/listing/listing_form_screen.dart';
import 'package:yyt_console/listing/listing_section.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import '../projects/widget_test_support.dart';

Map<String, dynamic> _listing({
  String audience = 'members',
  bool takenDown = false,
}) => {
  'appId': 'ca_1',
  'appName': 'game',
  'teamId': 'team_1',
  'teamName': 'crew',
  'title': 'Great Game',
  'summary': 'fun for all',
  'tags': ['puzzle'],
  'audience': audience,
  'publishedBy': 'me',
  'publishedAt': 1700000000,
  'updatedAt': 1700000000,
  'takenDown': takenDown,
};

/// A fake console: the listing row (null = not published) and its viewers,
/// mutated by the writes the panel sends.
class _Server {
  _Server({this.listing});
  Map<String, dynamic>? listing;
  bool unauthorized = false;
  final viewers = <Map<String, dynamic>>[];
  final calls = <String>[];

  http.Client get client => MockClient((req) async {
    calls.add('${req.method} ${req.url.path}');
    final path = req.url.path;
    if (path == '/catalog/apps/ca_1/listing') {
      switch (req.method) {
        case 'GET':
          if (unauthorized) return http.Response('', 401);
          return listing == null ? _notFound() : jsonResponse(listing!);
        case 'PUT':
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          if ((body['tags'] as List).contains('server-refuses')) {
            return jsonResponse({
              'error': {
                'code': 'bad_request',
                'message': 'invalid body',
                'details': [
                  {'path': 'tags.0', 'message': 'lowercase slug, 1-32 chars'},
                ],
              },
            }, 400);
          }
          if (unauthorized) {
            return http.Response('', 401);
          }
          final created = listing == null;
          listing = {..._listing(), ...body};
          return jsonResponse(listing!, created ? 201 : 200);
        case 'DELETE':
          listing = null;
          viewers.clear();
          return http.Response('', 204);
      }
    }
    if (path == '/catalog/apps/ca_1/listing/viewers') {
      if (listing == null) return _notFound();
      if (req.method == 'GET') return jsonResponse({'viewers': viewers});
      final login = (jsonDecode(req.body) as Map)['login'] as String;
      if (login == 'full') {
        return jsonResponse({
          'error': {
            'code': 'conflict',
            'message': 'too many viewers (max 100 per listing)',
          },
        }, 409);
      }
      if (login == 'ghost') {
        return jsonResponse({
          'error': {'code': 'not_found', 'message': 'no such platform member'},
        }, 404);
      }
      final known = viewers.any((v) => v['login'] == login);
      if (!known) {
        viewers.add({'login': login, 'addedBy': 'me', 'addedAt': 1700000000});
      }
      return jsonResponse({'login': login, 'added': !known}, known ? 200 : 201);
    }
    if (path.startsWith('/catalog/apps/ca_1/listing/viewers/') &&
        req.method == 'DELETE') {
      viewers.removeWhere((v) => v['login'] == path.split('/').last);
      return http.Response('', 204);
    }
    return _notFound();
  });

  http.Response _notFound() => jsonResponse({
    'error': {'code': 'not_found', 'message': 'not found'},
  }, 404);
}

Widget _host(
  ProjectsApi api, {
  bool canWrite = true,
  Future<void> Function()? onUnauthorized,
}) => MaterialApp(
  home: Scaffold(
    body: ListView(
      children: [
        ListingSection(
          api: api,
          appId: 'ca_1',
          appName: 'game',
          canWrite: canWrite,
          onUnauthorized: onUnauthorized ?? () async {},
        ),
      ],
    ),
  ),
);

void main() {
  final platform = TestPlatform();
  setUp(platform.install);
  tearDown(platform.uninstall);

  testWidgets('not published: the hint and a publish button that PUTs', (
    tester,
  ) async {
    final server = _Server();
    await tester.pumpWidget(
      _host(ProjectsApi(token: 't', client: server.client)),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('게시하지 않았습니다'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, '게시'));
    await tester.pumpAndSettle();
    expect(find.byType(ListingFormScreen), findsOneWidget);
    // The title is seeded with the app's name; pick named members.
    expect(find.widgetWithText(TextField, 'game'), findsOneWidget);
    await tester.enterText(find.byType(TextField).at(0), ' Great Game ');
    await tester.enterText(find.byType(TextField).at(2), 'Puzzle co-op');
    await tester.tap(find.text('지정 멤버'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '게시'));
    await tester.pumpAndSettle();

    expect(find.byType(ListingFormScreen), findsNothing);
    expect(server.calls, contains('PUT /catalog/apps/ca_1/listing'));
    expect(server.listing!['title'], 'Great Game');
    expect(server.listing!['tags'], ['puzzle', 'co-op']);
    expect(server.listing!['audience'], 'members');
    expect(find.text('Great Game'), findsOneWidget);
    expect(find.text('게시했습니다.'), findsOneWidget);
    // Viewers load once a listing exists.
    expect(server.calls, contains('GET /catalog/apps/ca_1/listing/viewers'));
    expect(find.textContaining('아직 지정한 멤버가 없습니다'), findsOneWidget);
  });

  testWidgets('a bad tag is refused under its field before any request', (
    tester,
  ) async {
    final server = _Server();
    await tester.pumpWidget(
      _host(ProjectsApi(token: 't', client: server.client)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '게시'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(2), 'Bad_Tag');
    await tester.tap(find.widgetWithText(FilledButton, '게시'));
    await tester.pumpAndSettle();
    expect(find.textContaining('"bad_tag"'), findsOneWidget);
    expect(server.calls.where((c) => c.startsWith('PUT')), isEmpty);
  });

  testWidgets('published to members: viewers are listed, added, removed', (
    tester,
  ) async {
    final server = _Server(listing: _listing())
      ..viewers.add({'login': 'octocat', 'addedBy': 'me', 'addedAt': 1});
    await tester.pumpWidget(
      _host(ProjectsApi(token: 't', client: server.client)),
    );
    await tester.pumpAndSettle();
    expect(find.text('Great Game'), findsOneWidget);
    expect(find.text('지정 멤버'), findsWidgets);
    expect(find.widgetWithText(ListTile, 'octocat'), findsOneWidget);

    // Unknown login: the server's 404 is a SnackBar, nothing added.
    await tester.enterText(
      find.widgetWithText(TextField, 'GitHub 로그인'),
      'ghost',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '추가'));
    await tester.pumpAndSettle();
    expect(find.textContaining('플랫폼 멤버가 아니거나'), findsOneWidget);
    expect(server.viewers, hasLength(1));
    // The field keeps the typed login; typing clears the error.
    expect(find.widgetWithText(TextField, 'ghost'), findsOneWidget);

    await tester.enterText(
      find.widgetWithText(TextField, 'GitHub 로그인'),
      'hubot',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '추가'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(ListTile, 'hubot'), findsOneWidget);

    await tester.tap(find.byTooltip('octocat 제외'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '제외'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(ListTile, 'octocat'), findsNothing);
    expect(
      server.calls,
      contains('DELETE /catalog/apps/ca_1/listing/viewers/octocat'),
    );
  });

  testWidgets('unpublish asks, DELETEs and returns to the unpublished state', (
    tester,
  ) async {
    final server = _Server(listing: _listing(audience: 'public'));
    await tester.pumpWidget(
      _host(ProjectsApi(token: 't', client: server.client)),
    );
    await tester.pumpAndSettle();
    expect(find.text('모든 사용자'), findsOneWidget);
    await tester.tap(find.text('게시 취소'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '게시 취소'));
    await tester.pumpAndSettle();
    expect(server.calls, contains('DELETE /catalog/apps/ca_1/listing'));
    expect(find.textContaining('게시하지 않았습니다'), findsOneWidget);
  });

  testWidgets('taken down shows the notice; read-only hides every control', (
    tester,
  ) async {
    final server = _Server(listing: _listing(takenDown: true));
    await tester.pumpWidget(
      _host(ProjectsApi(token: 't', client: server.client), canWrite: false),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('플랫폼 관리자가 이 게시를 내렸습니다'), findsOneWidget);
    expect(find.text('편집'), findsNothing);
    expect(find.text('게시 취소'), findsNothing);
    expect(find.widgetWithText(TextField, 'GitHub 로그인'), findsNothing);
  });

  testWidgets('edit: the form is seeded with the listing and PUTs whole', (
    tester,
  ) async {
    final server = _Server(listing: _listing(audience: 'public'));
    await tester.pumpWidget(
      _host(ProjectsApi(token: 't', client: server.client)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('편집'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextField, 'Great Game'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'puzzle'), findsOneWidget);
    await tester.enterText(find.byType(TextField).at(0), 'Greater Game');
    await tester.tap(find.widgetWithText(FilledButton, '저장'));
    await tester.pumpAndSettle();
    expect(server.listing!['title'], 'Greater Game');
    expect(server.listing!['summary'], 'fun for all');
    expect(server.listing!['tags'], ['puzzle']);
    expect(server.listing!['audience'], 'public');
    expect(find.text('Greater Game'), findsOneWidget);
    expect(find.text('게시 정보를 저장했습니다.'), findsOneWidget);
  });

  testWidgets('a server 400 on tags.0 lands under the tags field', (
    tester,
  ) async {
    final server = _Server();
    await tester.pumpWidget(
      _host(ProjectsApi(token: 't', client: server.client)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '게시'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(2), 'server-refuses');
    await tester.tap(find.widgetWithText(FilledButton, '게시'));
    await tester.pumpAndSettle();
    expect(find.byType(ListingFormScreen), findsOneWidget);
    expect(find.text('lowercase slug, 1-32 chars'), findsOneWidget);
    expect(server.listing, isNull);
  });

  testWidgets('the viewer cap is shown under the field and the list re-read', (
    tester,
  ) async {
    final server = _Server(listing: _listing());
    await tester.pumpWidget(
      _host(ProjectsApi(token: 't', client: server.client)),
    );
    await tester.pumpAndSettle();
    final before = server.calls.where((c) => c.endsWith('/viewers')).length;
    await tester.enterText(
      find.widgetWithText(TextField, 'GitHub 로그인'),
      'full',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '추가'));
    await tester.pumpAndSettle();
    expect(find.textContaining('최대 100명'), findsOneWidget);
    expect(
      server.calls
          .where((c) => c == 'GET /catalog/apps/ca_1/listing/viewers')
          .length,
      greaterThan(before - 1),
    );
  });

  testWidgets('a 401 on load invalidates and leaves an error, not a spinner', (
    tester,
  ) async {
    final server = _Server()..unauthorized = true;
    var invalidated = 0;
    await tester.pumpWidget(
      _host(
        ProjectsApi(token: 't', client: server.client),
        onUnauthorized: () async => invalidated++,
      ),
    );
    await tester.pumpAndSettle();
    expect(invalidated, 1);
    expect(find.byType(LinearProgressIndicator), findsNothing);
    expect(find.text('다시 시도'), findsOneWidget);
  });
}
