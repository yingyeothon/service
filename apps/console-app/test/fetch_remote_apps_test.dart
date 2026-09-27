import 'dart:async';
import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/fetch_remote_apps.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

Map<String, Object?> _artifact(
  String id,
  String version,
  int createdAt, {
  String? applicationId,
}) => {
  'id': id,
  'url': 'https://cdn.example/$id.apk',
  'platform': 'android',
  'size': 1,
  'tags': {'version': version, 'application_id': applicationId ?? 'p.$id'},
  'createdAt': createdAt,
};

Map<String, Object?> _app(
  String id,
  String teamId, {
  Map<String, Object?>? latest,
  List<String> applicationIds = const [],
}) => {
  'id': id,
  'name': id,
  'path': 'p.$id',
  'teamId': teamId,
  'teamName': teamId,
  'projectId': 'prj_$id',
  'projectName': id,
  'latestArtifact': latest,
  'applicationIds': applicationIds,
};

void main() {
  setUp(() => AuthConfig.setServerUrl('console-dev.yyt.life'));
  tearDown(AuthConfig.clearServerUrl);

  test('one request: the summary list and the caller\'s seats', () async {
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
          _app(
            'one',
            'team_a',
            latest: _artifact(
              'art_1',
              '1.0.0',
              1700000000,
              applicationId: 'p.one',
            ),
            applicationIds: ['p.one', 'p.one.debug'],
          ),
          _app(
            'two',
            'team_b',
            latest: _artifact('art_2', '2.0.0', 1700000100),
          ),
          // A team the seats do not name keeps AppHome's default.
          _app(
            'three',
            'team_z',
            latest: _artifact('art_3', '3.0.0', 1699999999),
          ),
          _app('bare', 'team_a'), // no Android build: not listed
        ],
        'teams': [
          {'id': 'team_a', 'name': 'a', 'role': 'owner'},
          {'id': 'team_b', 'name': 'b', 'role': 'owner'},
        ],
      });
    });
    final apps = await fetchRemoteApps(token: 'tok', client: client);
    expect(seen, hasLength(1));
    // Newest artifact first.
    expect(apps.map((a) => a.id), ['two', 'one', 'three']);
    final byId = {for (final a in apps) a.id: a};
    expect(byId['one']!.version, '1.0.0');
    expect(byId['one']!.installCheckApplicationIds, ['p.one', 'p.one.debug']);
    expect(byId['one']!.latestArtifact.createdAt.isUtc, isTrue);
    expect(byId['one']!.home!.project.name, 'one');
    expect(byId['one']!.home!.team.role, 'owner');
    expect(byId['two']!.home!.team.role, 'owner');
    expect(byId['three']!.home!.team.role, 'member');
  });

  test(
    'an older console without `teams` is listed per team, as 1.5.3 did',
    () async {
      final paths = <String>[];
      final client = MockClient((req) async {
        paths.add(req.url.path);
        if (req.url.path != '/catalog/apps' && req.url.path != '/teams') {
          expect(req.url.queryParameters, {
            'artifacts': 'summary',
            'platform': 'android',
          });
        }
        switch (req.url.path) {
          case '/catalog/apps':
            // The query is ignored: no summary, no seats.
            return _json({
              'apps': [
                {
                  'id': 'one',
                  'name': 'one',
                  'path': 'p.one',
                  'teamId': 'team_a',
                },
              ],
            });
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
                _app('one', 'team_a', latest: _artifact('a1', '1.0.0', 10)),
              ],
            });
          case '/teams/team_b/catalog/apps':
            return _json({
              'apps': [
                // Listed under two teams: the first one wins.
                _app('one', 'team_a', latest: _artifact('a1', '1.0.0', 10)),
                _app('two', 'team_b', latest: _artifact('a2', '2.0.0', 20)),
              ],
            });
          case '/teams/team_x/catalog/apps':
            return http.Response('', 403); // hides this team only
        }
        fail('unexpected ${req.url.path}');
      });
      final apps = await fetchRemoteApps(token: 'tok', client: client);
      expect(paths.first, '/catalog/apps');
      expect(paths, isNot(contains('/teams/team_p/catalog/apps')));
      expect(apps.map((a) => [a.id, a.home!.team.role]), [
        ['two', 'member'],
        ['one', 'owner'],
      ]);
    },
  );

  test('pending accounts, expired tokens and failures are reported', () async {
    Future<void> expectError(int status, Matcher matcher) => expectLater(
      fetchRemoteApps(
        token: 'tok',
        client: MockClient((_) async => http.Response('', status)),
      ),
      throwsA(matcher),
    );
    await expectError(403, predicate((e) => e.toString().contains('승인되지 않은')));
    await expectError(401, isA<UnauthorizedException>());
    await expectError(503, predicate((e) => e.toString().contains('503')));
  });

  test('a request that never answers times out', () async {
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

  test('requests stay on the server captured with the token', () async {
    final hosts = <String>[];
    final client = MockClient((req) async {
      hosts.add(req.url.host);
      // An older console, so the fallback's requests are covered too.
      return req.url.path == '/teams'
          ? _json({
            'teams': [
              {'id': 'team_a', 'name': 'a', 'role': 'owner'},
            ],
          })
          : _json({'apps': []});
    });
    final load = fetchRemoteApps(
      token: 'tok',
      client: client,
      baseUrl: 'https://one.example',
    );
    AuthConfig.setServerUrl('two.example'); // a profile switch mid-flight
    expect(await load, isEmpty);
    expect(hosts, ['one.example', 'one.example', 'one.example']);
  });
}
