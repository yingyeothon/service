import 'dart:async';
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

  test('listTeamIssues passes status and limit as query parameters', () async {
    final calls = <String>[];
    final client = MockClient((req) async {
      calls.add('${req.url.path}?${req.url.query}');
      return _json({
        'issues': [
          {
            'id': 'iss_1',
            'projectId': 'prj_2',
            'number': 1,
            'title': 't',
            'status': 'open',
            'createdBy': 'me',
            'createdAt': 1,
            'updatedAt': 2,
          },
        ],
      });
    });
    final api = ProjectsApi(token: 'tok', client: client);
    final all = await api.listTeamIssues('team a');
    expect(all.single.projectId, 'prj_2');
    await api.listTeamIssues('team a', status: 'open', limit: 5);
    expect(calls, [
      '/teams/team%20a/issues?',
      '/teams/team%20a/issues?status=open&limit=5',
    ]);
  });

  test(
    'listTeamIssuesCompat walks the projects when the route is missing',
    () async {
      Map<String, dynamic> issue(String prj, int n, int at) => {
        'id': '${prj}_$n',
        'projectId': prj,
        'number': n,
        'title': 't',
        'status': 'open',
        'createdBy': 'me',
        'createdAt': 1,
        'updatedAt': at,
      };
      final client = MockClient((req) async {
        switch (req.url.path) {
          case '/teams/team_a/issues':
            return _json({
              'error': {'code': 'not_found', 'message': 'route not found'},
            }, 404);
          case '/projects/p1/issues':
            return _json({
              'issues': [issue('p1', 1, 5), issue('p1', 2, 1)],
            });
          case '/projects/p2/issues':
            return _json({
              'issues': [issue('p2', 1, 3)],
            });
        }
        return http.Response('', 500);
      });
      final api = ProjectsApi(token: 'tok', client: client);
      final projects = [
        const Project(id: 'p1', teamId: 'team_a', name: 'a', description: ''),
        const Project(id: 'p2', teamId: 'team_a', name: 'b', description: ''),
      ];
      final got = await api.listTeamIssuesCompat('team_a', projects, limit: 2);
      expect(got.map((i) => i.id), ['p1_1', 'p2_1']);
    },
  );

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

  Map<String, Object?> artifact(String id, String version, int createdAt) => {
    'id': id,
    'url': 'https://cdn.example/$id.apk',
    'platform': 'android',
    'size': 1,
    'tags': {'version': version, 'application_id': 'p.$id'},
    'createdAt': createdAt,
  };

  test(
    'fetchRemoteApps is one request: the summary list and the seats',
    () async {
      final seen = <Uri>[];
      final client = MockClient((req) async {
        seen.add(req.url);
        expect(req.headers['Authorization'], 'Bearer tok');
        expect(req.url.path, '/catalog/apps');
        expect(req.url.queryParameters, {
          'artifacts': 'summary',
          'platform': 'android',
        });
        return _json({
          'apps': [
            {
              'id': 'ca_1',
              'name': 'one',
              'path': 'p.one',
              'teamId': 'team_a',
              'teamName': 'a',
              'projectId': 'prj_1',
              'projectName': 'one',
              'latestArtifact': {
                ...artifact('art_1', '1.0.0', 1700000000),
                'tags': {'version': '1.0.0', 'application_id': 'p.one'},
              },
              'applicationIds': ['p.one', 'p.one.debug'],
            },
            {
              'id': 'ca_2',
              'name': 'two',
              'path': 'p.two',
              'teamId': 'team_b',
              'teamName': 'b',
              'projectId': 'prj_2',
              'projectName': 'two',
              'latestArtifact': artifact('art_2', '2.0.0', 1700000100),
              'applicationIds': ['p.art_2'],
            },
            {
              // A team the seats do not name reads as `member`.
              'id': 'ca_3',
              'name': 'three',
              'path': 'p.three',
              'teamId': 'team_z',
              'projectId': 'prj_3',
              'latestArtifact': artifact('art_3', '3.0.0', 1699999999),
              'applicationIds': ['p.art_3'],
            },
            {
              'id': 'ca_4',
              'name': 'bare',
              'path': 'p.bare',
              'teamId': 'team_a',
              'latestArtifact': null,
              'applicationIds': <String>[],
            },
          ],
          'teams': [
            {'id': 'team_a', 'name': 'a', 'role': 'owner'},
            {'id': 'team_b', 'name': 'b', 'role': 'member'},
          ],
        });
      });
      final apps = await fetchRemoteApps(token: 'tok', client: client);
      // One request, whatever the number of teams; no per-app /artifacts walk.
      expect(seen, hasLength(1));
      // Newest artifact first; an app without an Android build is skipped.
      expect(apps.map((a) => a.id), ['ca_2', 'ca_1', 'ca_3']);
      final one = apps.firstWhere((a) => a.id == 'ca_1');
      expect(one.version, '1.0.0');
      expect(one.installCheckApplicationIds, ['p.one', 'p.one.debug']);
      expect(one.latestArtifact.createdAt.isUtc, isTrue);
      // Breadcrumb + the caller's seat feed the detail screen's issues button.
      expect(one.home!.team.id, 'team_a');
      expect(one.home!.team.role, 'owner');
      expect(one.home!.project.name, 'one');
      expect(apps.first.home!.team.role, 'member');
      expect(apps.last.home!.team.role, 'member');
    },
  );

  test(
    'fetchRemoteApps walks /artifacts for a console without the summary',
    () async {
      final paths = <String>[];
      final client = MockClient((req) async {
        paths.add(req.url.path);
        switch (req.url.path) {
          case '/catalog/apps':
            // Older console: the query is ignored — no `latestArtifact` key
            // and no `teams`.
            return _json({
              'apps': [
                {'id': 'ca_1', 'name': 'one', 'path': 'p.one', 'teamId': 't'},
                {'id': 'ca_2', 'name': 'two', 'path': 'p.two', 'teamId': 't'},
              ],
            });
          case '/catalog/apps/ca_1/artifacts':
            return _json({
              'artifacts': [
                artifact('one', '2.0.0', 1700000100),
                {
                  ...artifact('one_debug', '1.0.0', 1700000000),
                  'tags': {'version': '1.0.0', 'application_id': 'p.one.debug'},
                },
              ],
            });
          case '/catalog/apps/ca_2/artifacts':
            return http.Response('', 500); // one failure hides only itself
        }
        fail('unexpected ${req.url.path}');
      });
      final apps = await fetchRemoteApps(token: 'tok', client: client);
      expect(apps.map((a) => a.id), ['ca_1']);
      expect(apps.single.version, '2.0.0');
      expect(apps.single.installCheckApplicationIds, ['p.one', 'p.one.debug']);
      expect(paths, contains('/catalog/apps/ca_1/artifacts'));
    },
  );

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
      return _json({'teams': [], 'apps': []});
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
      await fetchRemoteApps(
        token: 'tok',
        client: client,
        baseUrl: 'https://one.example',
      ),
      isEmpty,
    );
    expect(hosts, ['one.example', 'one.example']);
  });

  test(
    'fetchRemoteApps reports pending accounts, expired tokens and failures',
    () async {
      expect(
        fetchRemoteApps(
          token: 'tok',
          client: MockClient((_) async => http.Response('', 403)),
        ),
        throwsA(predicate((e) => e.toString().contains('승인되지 않은'))),
      );
      expect(
        fetchRemoteApps(
          token: 'tok',
          client: MockClient((_) async => http.Response('', 401)),
        ),
        throwsA(isA<UnauthorizedException>()),
      );
      expect(
        fetchRemoteApps(
          token: 'tok',
          client: MockClient((_) async => http.Response('', 503)),
        ),
        throwsA(predicate((e) => e.toString().contains('503'))),
      );
    },
  );

  test('fetchRemoteApps gives up on a request that never answers', () async {
    final never = Completer<http.Response>();
    await expectLater(
      fetchRemoteApps(
        token: 'tok',
        client: MockClient((_) => never.future),
        timeout: const Duration(milliseconds: 10),
      ),
      throwsA(isA<TimeoutException>()),
    );
  });
}
