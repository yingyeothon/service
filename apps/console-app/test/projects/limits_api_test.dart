import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

const _request = {
  'id': 'lr_1',
  'teamId': 'team_1',
  'teamName': 'crew',
  'unit': 'bytes',
  'hard': 268435456,
  'scope': {'kind': 'bundle', 'id': 'ab_1', 'name': 'maps'},
  'key': 'asset.fileBytes',
  'requestedValue': 67108864,
  'reason': 'music',
  'status': 'pending',
  'decidedValue': null,
  'decisionNote': null,
  'createdBy': 'm_1',
  'createdByLogin': 'alice',
  'createdAt': 1700000000,
  'decidedBy': null,
  'decidedByLogin': null,
  'decidedAt': null,
};

void main() {
  setUp(() => AuthConfig.setServerUrl('console-dev.yyt.life'));
  tearDown(AuthConfig.clearServerUrl);

  test('getLimits asks for one scope and reads the rows', () async {
    late http.Request seen;
    final api = ProjectsApi(
      token: 'tok',
      client: MockClient((req) async {
        seen = req;
        return _json({
          'scope': {'kind': 'bundle', 'id': 'ab_1'},
          'teamId': 'team_1',
          'limits': [
            {
              'key': 'asset.fileBytes',
              'unit': 'bytes',
              'soft': 2097152,
              'hard': 268435456,
              'effective': 2097152,
              'usage': 10,
              'step': null,
              'next': null,
              'override': null,
            },
          ],
          'pending': [_request],
        });
      }),
    );
    final v = await api.getLimits('bundle', 'ab_1');
    expect(seen.url.path, '/limits');
    expect(seen.url.queryParameters['scope'], 'bundle:ab_1');
    expect(seen.headers['Authorization'], 'Bearer tok');
    expect(v.limits.single.key, 'asset.fileBytes');
    expect(v.pending.single.id, 'lr_1');
  });

  test(
    'createLimitRequest POSTs the scope, key, value ("unlimited" for null) and reason',
    () async {
      final bodies = <Object?>[];
      final api = ProjectsApi(
        token: 'tok',
        client: MockClient((req) async {
          expect(req.method, 'POST');
          expect(req.url.path, '/limit-requests');
          bodies.add(jsonDecode(req.body));
          return _json(_request, 201);
        }),
      );
      final r = await api.createLimitRequest(
        kind: 'bundle',
        id: 'ab_1',
        key: 'asset.fileBytes',
        value: 64 << 20,
        reason: 'music',
      );
      expect(r.id, 'lr_1');
      await api.createLimitRequest(
        kind: 'channel',
        id: 'auth_1',
        key: 'channel.lifetime',
        value: null,
        reason: 'r',
      );
      expect(bodies, [
        {
          'scope': 'bundle:ab_1',
          'key': 'asset.fileBytes',
          'value': 64 << 20,
          'reason': 'music',
        },
        {
          'scope': 'channel:auth_1',
          'key': 'channel.lifetime',
          'value': 'unlimited',
          'reason': 'r',
        },
      ]);
    },
  );

  test(
    'a stepped refusal carries limitDetails and a cooldown carries retryAt',
    () async {
      final api = ProjectsApi(
        token: 'tok',
        client: MockClient((req) async {
          if (req.url.path == '/limit-requests') {
            return _json({
              'error': {
                'code': 'bad_request',
                'message': 'team.projects may only be asked for as 25',
                'details': {
                  'limit': 'team.projects',
                  'value': 30,
                  'usage': 20,
                  'next': 25,
                },
              },
            }, 400);
          }
          return _json({
            'error': {
              'code': 'rate_limited',
              'message': 'recently refused',
              'details': {'retryAt': 1700000000},
            },
          }, 429);
        }),
      );
      await expectLater(
        api.createLimitRequest(
          kind: 'team',
          id: 'team_1',
          key: 'team.projects',
          value: 30,
          reason: 'r',
        ),
        throwsA(
          isA<ApiException>().having(
            (e) => e.limitDetails?['next'],
            'next',
            25,
          ),
        ),
      );
      await expectLater(
        api.cancelLimitRequest('lr_1'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.retryAt?.millisecondsSinceEpoch,
            'retryAt',
            1700000000 * 1000,
          ),
        ),
      );
    },
  );

  test('listLimitRequests filters by team and status; cancel POSTs', () async {
    final calls = <String>[];
    final api = ProjectsApi(
      token: 'tok',
      client: MockClient((req) async {
        calls.add(
          '${req.method} ${req.url.path}${req.url.hasQuery ? '?${req.url.query}' : ''}',
        );
        if (req.method == 'POST') {
          return _json({..._request, 'status': 'cancelled'});
        }
        return _json({
          'requests': [_request],
          'next': null,
        });
      }),
    );
    final list = await api.listLimitRequests('team_1', status: 'pending');
    expect(list.single.key, 'asset.fileBytes');
    final c = await api.cancelLimitRequest('lr_1');
    expect(c.status, 'cancelled');
    expect(calls, [
      'GET /limit-requests?team=team_1&status=pending',
      'POST /limit-requests/lr_1/cancel',
    ]);
  });
}
