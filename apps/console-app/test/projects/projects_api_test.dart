import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/fetch_remote_apps.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

void main() {
  setUp(() => AuthConfig.setServerUrl('console-dev.yyt.life'));
  tearDown(AuthConfig.clearServerUrl);

  test('lists teams, projects and issues with the bearer token', () async {
    final calls = <String>[];
    final client = MockClient((req) async {
      calls.add(
        '${req.method} ${req.url.path}${req.url.hasQuery ? '?${req.url.query}' : ''}',
      );
      expect(req.headers['Authorization'], 'Bearer tok');
      switch (req.url.path) {
        case '/teams':
          return _json({
            'teams': [
              {'id': 'team_a', 'name': 'a', 'role': 'member'},
              {'id': 'team_p', 'name': 'p', 'role': 'pending'},
            ],
          });
        case '/teams/team_a/projects':
          return _json({
            'projects': [
              {'id': 'prj_1', 'teamId': 'team_a', 'name': 'one'},
            ],
          });
        case '/projects/prj_1/issues':
          return _json({
            'issues': [
              {
                'id': 'iss_1',
                'projectId': 'prj_1',
                'number': 3,
                'title': 'crash',
                'status': 'open',
                'createdBy': 'me',
                'createdAt': 1700000000,
                'updatedAt': 1700000000,
              },
            ],
          });
      }
      return http.Response('', 404);
    });
    final api = ProjectsApi(token: 'tok', client: client);

    final teams = await api.listTeams();
    expect(teams.map((t) => t.canRead), [true, false]);
    expect(teams.first.canWrite, isTrue);
    expect(Team(id: 'x', name: 'x', role: 'admin').canWrite, isFalse);

    final projects = await api.listProjects('team_a');
    expect(projects.single.description, '');

    final issues = await api.listIssues('prj_1', status: 'open');
    expect(issues.single.number, 3);
    expect(issues.single.isOpen, isTrue);
    expect(issues.single.bodyMd, '');
    expect(issues.single.createdAt, DateTime.utc(2023, 11, 14, 22, 13, 20));
    expect(calls.last, 'GET /projects/prj_1/issues?status=open');
  });

  test('posts issue, comment and status changes', () async {
    final bodies = <String, String>{};
    final client = MockClient((req) async {
      bodies['${req.method} ${req.url.path}'] = req.body;
      if (req.url.path.endsWith('/comments')) {
        return _json({
          'id': 'cmt_1',
          'bodyMd': 'hi',
          'createdBy': 'me',
          'createdAt': 1,
          'mine': true,
        }, 201);
      }
      return _json({
        'id': 'iss_1',
        'projectId': 'prj_1',
        'number': 4,
        'title': 't',
        'status': req.url.path.endsWith('/close') ? 'closed' : 'open',
        'createdAt': 1,
        'updatedAt': 1,
      }, 201);
    });
    final api = ProjectsApi(token: 'tok', client: client);

    final created = await api.createIssue('prj_1', title: 't', bodyMd: 'b');
    expect(created.number, 4);
    expect(jsonDecode(bodies['POST /projects/prj_1/issues']!), {
      'title': 't',
      'bodyMd': 'b',
    });

    final closed = await api.setIssueStatus('prj_1', 4, open: false);
    expect(closed.isOpen, isFalse);
    expect(bodies['POST /projects/prj_1/issues/4/close'], '');

    final comment = await api.addComment('prj_1', 4, 'hi');
    expect(comment.mine, isTrue);
  });

  test(
    'maps 401 to UnauthorizedException and others to the server message',
    () async {
      final api401 = ProjectsApi(
        token: 'tok',
        client: MockClient((_) async => http.Response('', 401)),
      );
      expect(api401.listTeams(), throwsA(isA<UnauthorizedException>()));

      final api409 = ProjectsApi(
        token: 'tok',
        client: MockClient(
          (_) async => _json({
            'error': {'code': 'conflict', 'message': 'issue is already closed'},
          }, 409),
        ),
      );
      await expectLater(
        api409.setIssueStatus('prj_1', 1, open: false),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 409)
              .having((e) => e.code, 'code', 'conflict')
              .having(
                (e) => e.toString(),
                'message',
                '요청이 현재 상태와 충돌합니다. (issue is already closed)',
              ),
        ),
      );

      final api403 = ProjectsApi(
        token: 'tok',
        client: MockClient((_) async => http.Response('nope', 403)),
      );
      await expectLater(
        api403.listProjects('team_a'),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 403)),
      );
    },
  );

  test('fetchTeamApps walks seated teams and dedupes app ids', () async {
    final client = MockClient((req) async {
      switch (req.url.path) {
        case '/teams':
          return _json({
            'teams': [
              {'id': 'team_a', 'name': 'a', 'role': 'owner'},
              {'id': 'team_b', 'name': 'b', 'role': 'member'},
              {'id': 'team_p', 'name': 'p', 'role': 'pending'},
              {'id': 'team_x', 'name': 'x', 'role': 'member'},
            ],
          });
        case '/teams/team_a/catalog/apps':
          return _json({
            'apps': [
              {'id': 'ca_1', 'name': 'one', 'path': 'p.one'},
            ],
          });
        case '/teams/team_b/catalog/apps':
          return _json({
            'apps': [
              {'id': 'ca_1', 'name': 'one', 'path': 'p.one'},
              {'id': 'ca_2', 'name': 'two', 'path': 'p.two'},
            ],
          });
        case '/teams/team_x/catalog/apps':
          return http.Response('', 403);
      }
      fail('unexpected ${req.url.path}');
    });
    final apps = await fetchTeamApps(token: 'tok', client: client);
    expect(apps.map((a) => a['id']), ['ca_1', 'ca_2']);
  });

  test('empty single-entity responses are reported, not cast errors', () async {
    final api = ProjectsApi(
      token: 'tok',
      client: MockClient((_) async => http.Response('', 200)),
    );
    await expectLater(api.getIssue('prj_1', 1), throwsA(isA<ApiException>()));
    expect(
      ProjectsApi.describeError(403, 'forbidden', null),
      '권한이 없습니다. 팀 승인 여부를 확인해주세요.',
    );
    expect(
      Issue.fromJson({
        'id': 'i',
        'projectId': 'p',
        'number': 1,
        'title': 't',
        'createdBy': null,
      }).createdBy,
      '(알 수 없음)',
    );
  });

  test('requests stay on the server captured at construction', () async {
    final hosts = <String>[];
    final client = MockClient((req) async {
      hosts.add(req.url.host);
      return _json({'teams': []});
    });
    final api = ProjectsApi(
      token: 'tok',
      client: client,
      baseUrl: 'https://one.example',
    );
    AuthConfig.setServerUrl('two.example'); // a profile switch mid-flight
    await api.listTeams();
    expect(hosts, ['one.example']);
    expect(
      await fetchTeamApps(
        token: 'tok',
        client: client,
        baseUrl: 'https://one.example',
      ),
      isEmpty,
    );
    expect(hosts, ['one.example', 'one.example']);
  });

  test('fetchTeamApps reports pending accounts and expired tokens', () async {
    expect(
      fetchTeamApps(
        token: 'tok',
        client: MockClient((_) async => http.Response('', 403)),
      ),
      throwsA(predicate((e) => e.toString().contains('승인되지 않은'))),
    );
    expect(
      fetchTeamApps(
        token: 'tok',
        client: MockClient((_) async => http.Response('', 401)),
      ),
      throwsA(isA<UnauthorizedException>()),
    );
  });
}
