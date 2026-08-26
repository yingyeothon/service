import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/projects/discussions_screen.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/projects_screen.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

Map<String, dynamic> _discussion(String id, int updatedAt) => {
  'id': id,
  'teamId': 'team_a',
  'title': 'topic $id',
  'bodyMd': '',
  'createdBy': 'me',
  'createdAt': 1700000000,
  'updatedAt': updatedAt,
  'mine': true,
};

void main() {
  setUp(() => AuthConfig.setServerUrl('console-dev.yyt.life'));
  tearDown(AuthConfig.clearServerUrl);

  test('lists, reads, creates and comments on team discussions', () async {
    final calls = <String>[];
    final client = MockClient((req) async {
      calls.add('${req.method} ${req.url.path}');
      switch ('${req.method} ${req.url.path}') {
        case 'GET /teams/team_a/discussions':
          return _json({
            'discussions': [_discussion('d1', 10), _discussion('d2', 20)],
          });
        case 'GET /teams/team_a/discussions/d2':
          return _json({
            ..._discussion('d2', 20),
            'comments': [
              {
                'id': 'c1',
                'bodyMd': 'hi',
                'createdBy': 'you',
                'createdAt': 1700000001,
                'mine': false,
              },
            ],
          });
        case 'POST /teams/team_a/discussions':
          expect(jsonDecode(req.body), {'title': 'new', 'bodyMd': 'body'});
          return _json(_discussion('d3', 30), 201);
        case 'POST /teams/team_a/discussions/d3/comments':
          expect(jsonDecode(req.body), {'bodyMd': 'ok'});
          return _json({
            'id': 'c2',
            'bodyMd': 'ok',
            'createdBy': 'me',
            'createdAt': 1700000002,
            'mine': true,
          }, 201);
      }
      return http.Response('', 404);
    });
    final api = ProjectsApi(token: 'tok', client: client);

    final list = await api.listDiscussions('team_a');
    expect(list.map((d) => d.id), ['d1', 'd2']);
    expect(sortDiscussionsNewestFirst(list).map((d) => d.id), ['d2', 'd1']);

    final d2 = await api.getDiscussion('team_a', 'd2');
    expect(d2.comments.single.createdBy, 'you');

    final d3 = await api.createDiscussion(
      'team_a',
      title: 'new',
      bodyMd: 'body',
    );
    expect(d3.id, 'd3');
    final c = await api.addDiscussionComment('team_a', 'd3', 'ok');
    expect(c.mine, isTrue);
    expect(calls.last, 'POST /teams/team_a/discussions/d3/comments');
  });

  test('recentIssues keeps the five most recently updated', () {
    Issue issue(int n, int updated) => Issue(
      id: 'i$n',
      projectId: 'p',
      number: n,
      title: 't',
      bodyMd: '',
      status: 'open',
      createdBy: 'me',
      createdAt: DateTime.utc(2026),
      updatedAt: DateTime.fromMillisecondsSinceEpoch(
        updated * 1000,
        isUtc: true,
      ),
    );
    final picked = recentIssues([for (var i = 1; i <= 7; i += 1) issue(i, i)]);
    expect(picked.map((i) => i.number), [7, 6, 5, 4, 3]);
  });
}
