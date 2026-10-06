import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/site_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

/// Distinctive, so a leak cannot hide behind a common word.
final _sentinel = 'abcdef0123456789' * 4;

Map<String, dynamic> _siteJson({
  bool busy = false,
  String? movingTo,
  bool withNames = true,
}) => {
  'id': 'st_1',
  'name': 'game',
  'slug': 'abcdefghi',
  'description': null,
  'teamId': 'team_1',
  'teamName': 'crew',
  'projectId': 'prj_1',
  'projectName': 'one',
  'createdBy': 'me',
  'publicUrl': 'https://g.example/abcdefghi/',
  'basePath': '/abcdefghi/',
  'currentDeployId': 'sd_2',
  'busy': busy,
  'createdAt': 1700000000,
  'updatedAt': 1700000100,
  if (withNames) ...{
    'domain': null,
    'hostUrl': 'https://abcdefghi.g.example/',
    'hostSuffix': 'g.example',
    'movingTo': movingTo,
  },
};

Map<String, dynamic> _channelJson(String kind, {Map<String, dynamic>? extra}) =>
    {
      'id': '${kind}_1',
      'kind': kind,
      'name': 'ch-$kind',
      'teamId': 'team_1',
      'projectId': 'prj_1',
      'config': kind == 'auth'
          ? {
              'audience': 'game',
              'tokenTtlSec': 86400,
              'redirectAllowlist': <String>[],
              'providers': <String, dynamic>{},
            }
          : {'authChannelId': 'auth_1'},
      'createdAt': 1700000000,
      'expiresAt': 1700604800,
      'disabledAt': null,
      'status': 'active',
      ...?extra,
    };

class _Call {
  _Call(this.method, this.target, this.body);
  final String method;
  final String target;
  final String body;
  Object? get json => body.isEmpty ? null : jsonDecode(body);
}

void main() {
  setUp(() => AuthConfig.setServerUrl('console-dev.yyt.life'));
  tearDown(AuthConfig.clearServerUrl);

  (ProjectsApi, List<_Call>) apiWith(
    Future<http.Response> Function(http.Request) handler,
  ) {
    final calls = <_Call>[];
    final client = MockClient((req) async {
      calls.add(
        _Call(
          req.method,
          '${req.url.path}${req.url.hasQuery ? '?${req.url.query}' : ''}',
          req.body,
        ),
      );
      expect(req.headers['Authorization'], 'Bearer tok');
      return handler(req);
    });
    return (ProjectsApi(token: 'tok', client: client), calls);
  }

  group('sites', () {
    test('list, get and the detail shape; timestamps are seconds', () async {
      final (api, calls) = apiWith((req) async {
        if (req.url.path == '/projects/prj_1/sites') {
          return _json({
            'sites': [_siteJson()],
          });
        }
        return _json({
          ..._siteJson(),
          'currentDeploy': {
            'id': 'sd_2',
            'siteId': 'st_1',
            'status': 'live',
            'zipBytes': 10,
            'bytes': 2048,
            'files': 3,
            'error': null,
            'createdBy': 'me',
            'createdAt': 1700000050,
            'updatedAt': 1700000060,
            'expiresAt': 1700000900,
          },
          'deploys': [
            {
              'id': 'sd_3',
              'siteId': 'st_1',
              'status': 'live',
              'zipBytes': 0,
              'bytes': 0,
              'files': 0,
              'createdAt': 1700000070,
              'moveTo': 'my-game',
            },
            {
              'id': 'sd_2',
              'siteId': 'st_1',
              'status': 'live',
              'zipBytes': 10,
              'bytes': 2048,
              'files': 3,
              'createdAt': 1700000050,
            },
          ],
          'warning': 'Every site on this host shares one origin.',
        });
      });
      final sites = await api.listSites('prj_1');
      expect(sites.single.displayUrl, 'https://g.example/abcdefghi/');
      expect(sites.single.createdAt, DateTime.utc(2023, 11, 14, 22, 13, 20));
      expect(sites.single.state, SiteState.live);

      final detail = await api.getSite('st_1');
      expect(detail.warning, 'Every site on this host shares one origin.');
      expect(detail.currentDeploy!.bytes, 2048);
      expect(detail.deploys.first.isMove, isTrue);
      expect(detail.deploys.first.moveTo, 'my-game');
      expect(detail.deploys.last.isMove, isFalse);
      expect(detail.site.hostSuffix, 'g.example');
      expect(calls.map((c) => '${c.method} ${c.target}'), [
        'GET /projects/prj_1/sites',
        'GET /sites/st_1',
      ]);
    });

    test('an older server without the name fields still parses', () async {
      final (api, _) = apiWith(
        (_) async => _json({..._siteJson(withNames: false), 'deploys': []}),
      );
      final d = await api.getSite('st_1');
      expect(d.site.domain, isNull);
      expect(d.site.hostUrl, isNull);
      expect(d.site.hostSuffix, isNull);
      expect(d.site.movingTo, isNull);
      expect(d.site.displayUrl, 'https://g.example/abcdefghi/');
      expect(d.currentDeploy, isNull);
      expect(d.warning, isNull);
    });

    test('create omits a blank description', () async {
      final (api, calls) = apiWith((_) async => _json(_siteJson(), 201));
      await api.createSite('prj_1', name: ' game ', description: '  ');
      await api.createSite('prj_1', name: 'game', description: ' about ');
      expect(calls.map((c) => '${c.method} ${c.target}').toSet(), {
        'POST /projects/prj_1/sites',
      });
      expect(calls[0].json, {'name': 'game'});
      expect(calls[1].json, {'name': 'game', 'description': 'about'});
    });

    test(
      'PATCH sends the patch as given; 202 means a move was queued',
      () async {
        var status = 200;
        final (api, calls) = apiWith(
          (_) async => _json(
            _siteJson(
              busy: status == 202,
              movingTo: status == 202 ? 'my-game' : null,
            ),
            status,
          ),
        );
        final plain = await api.updateSite('st_1', {
          'name': 'game2',
          'description': null,
        });
        expect(plain.moveQueued, isFalse);
        expect(calls.last.method, 'PATCH');
        expect(calls.last.target, '/sites/st_1');
        expect(calls.last.json, {'name': 'game2', 'description': null});

        status = 202;
        final moved = await api.updateSite('st_1', {'domain': 'my-game'});
        expect(moved.moveQueued, isTrue);
        expect(moved.site.busy, isTrue);
        expect(moved.site.movingTo, 'my-game');
        expect(moved.site.state, SiteState.moving);
        expect(calls.last.json, {'domain': 'my-game'});
      },
    );

    test('DELETE answers 204 with an empty body', () async {
      final (api, calls) = apiWith((_) async => http.Response('', 204));
      await api.deleteSite('st_1');
      expect(calls.single.method, 'DELETE');
      expect(calls.single.target, '/sites/st_1');
    });
  });

  group('channels', () {
    test('list (with the auth filter) and get', () async {
      final (api, calls) = apiWith((req) async {
        if (req.url.path == '/projects/prj_1/channels') {
          return _json({
            'channels': [_channelJson('auth')],
          });
        }
        return _json(
          _channelJson(
            'q',
            extra: {
              'wsUrl': 'wss://gw.example/?channel=q_1',
              'redis': {'eventKeyPrefix': 'game:dev:q_1:event:'},
            },
          ),
        );
      });
      final auths = await api.listChannels('prj_1', kind: 'auth');
      expect(auths.single.kind, 'auth');
      await api.listChannels('prj_1');
      final q = await api.getChannel('q_1');
      expect(q.authChannelId, 'auth_1');
      expect(q.redis['eventKeyPrefix'], 'game:dev:q_1:event:');
      expect(q.expiresAt, DateTime.utc(2023, 11, 21, 22, 13, 20));
      expect(q.hasSecret, isFalse);
      expect(calls.map((c) => '${c.method} ${c.target}'), [
        'GET /projects/prj_1/channels?kind=auth',
        'GET /projects/prj_1/channels',
        'GET /channels/q_1',
      ]);
    });

    test(
      'create returns the credential per kind and nothing else keeps it',
      () async {
        late String kind;
        final (api, calls) = apiWith(
          (_) async => _json(
            _channelJson(
              kind,
              // The server sends `secret` for auth, `apiKey` for topic/match and
              // nothing for lobby/q; both keys here prove the kind decides.
              extra: {'secret': _sentinel, 'apiKey': _sentinel},
            ),
            201,
          ),
        );
        final expected = {
          'auth': (_sentinel, '채널 시크릿'),
          'topic': (_sentinel, 'API 키'),
          'match': (_sentinel, 'API 키'),
          'lobby': (null, 'API 키'),
          'q': (null, 'API 키'),
        };
        for (final entry in expected.entries) {
          kind = entry.key;
          final created = await api.createChannel(
            'prj_1',
            kind: kind,
            name: 'n',
            config: {'authChannelId': 'auth_1'},
          );
          expect(created.credential, entry.value.$1, reason: kind);
          expect(created.credentialLabel, entry.value.$2, reason: kind);
          expect(created.toString(), isNot(contains(_sentinel)));
          expect(created.channel.toString(), isNot(contains(_sentinel)));
          expect(created.channel.config.toString(), isNot(contains(_sentinel)));
          expect(calls.last.method, 'POST');
          expect(calls.last.target, '/projects/prj_1/channels');
          expect(calls.last.json, {
            'kind': kind,
            'name': 'n',
            'config': {'authChannelId': 'auth_1'},
          });
        }
      },
    );

    test('update sends only what is given; extend posts no body', () async {
      final (api, calls) = apiWith(
        (req) async => req.method == 'DELETE'
            ? http.Response('', 204)
            : _json(_channelJson('match')),
      );
      await api.updateChannel('match_1', name: 'renamed');
      expect(calls.last.method, 'PATCH');
      expect(calls.last.target, '/channels/match_1');
      expect(calls.last.json, {'name': 'renamed'});
      await api.updateChannel('match_1', config: {'authChannelId': 'auth_2'});
      expect(calls.last.json, {
        'config': {'authChannelId': 'auth_2'},
      });

      await api.extendChannel('match_1');
      expect(calls.last.method, 'POST');
      expect(calls.last.target, '/channels/match_1/extend');
      expect(calls.last.body, '');

      await api.deleteChannel('match_1');
      expect(calls.last.method, 'DELETE');
      expect(calls.last.target, '/channels/match_1');
    });
  });

  group('errors', () {
    test('409 carries details.reason and a Korean sentence', () async {
      final (api, _) = apiWith(
        (_) async => _json({
          'error': {
            'code': 'conflict',
            'message': 'domain is taken',
            'details': {'reason': 'domain_taken'},
          },
        }, 409),
      );
      await expectLater(
        api.updateSite('st_1', {'domain': 'taken'}),
        throwsA(
          isA<ApiException>()
              .having((e) => e.reason, 'reason', 'domain_taken')
              .having((e) => e.fieldErrors, 'fieldErrors', isEmpty)
              .having(
                (e) => e.message,
                'message',
                '이미 쓰이고 있거나 다른 팀이 쓴 적 있는 이름입니다. (domain is taken)',
              ),
        ),
      );
      expect(ProjectsApi.reasonMessage('domain_cap'), '팀의 이름 한도(20개)에 도달했습니다.');
      expect(ProjectsApi.reasonMessage('domain_cleaning'), contains('정리 중'));
      expect(ProjectsApi.reasonMessage('other'), isNull);
    });

    test('domain_cap carries the counted names into the sentence', () async {
      final (api, _) = apiWith(
        (_) async => _json({
          'error': {
            'code': 'conflict',
            'message': 'too many site names',
            'details': {
              'reason': 'domain_cap',
              'names': [
                {'name': 'one', 'releasedAt': null},
                {'name': 'two', 'releasedAt': 1700000000},
                {'releasedAt': 1},
              ],
            },
          },
        }, 409),
      );
      await expectLater(
        api.updateSite('st_1', {'domain': 'three'}),
        throwsA(
          isA<ApiException>()
              .having((e) => e.reason, 'reason', 'domain_cap')
              .having((e) => e.names, 'names', ['one', 'two']),
        ),
      );
      expect(
        ProjectsApi.reasonMessage('domain_cap', names: ['one', 'two']),
        allOf(
          startsWith('팀의 이름 한도(20개)에 도달했습니다. '),
          contains('세는 이름: one, two.'),
        ),
      );
      // Only a cap lists names.
      expect(
        ProjectsApi.reasonMessage('domain_taken', names: ['one']),
        ProjectsApi.reasonMessage('domain_taken'),
      );
      expect(
        const ApiException(409, 'x', details: {'reason': 'x'}).names,
        isEmpty,
      );
    });

    test('400 details become field errors', () async {
      final (api, _) = apiWith(
        (_) async => _json({
          'error': {
            'code': 'bad_request',
            'message': 'invalid body',
            'details': [
              {'path': 'domain', 'message': 'bad name'},
              {'path': 'domain', 'message': 'second'},
              {'path': '', 'message': 'root'},
            ],
          },
        }, 400),
      );
      await expectLater(
        api.updateSite('st_1', {'domain': '-x'}),
        throwsA(
          isA<ApiException>()
              .having((e) => e.reason, 'reason', isNull)
              .having((e) => e.fieldErrors, 'fieldErrors', {
                'domain': 'bad name',
                '': 'root',
              })
              .having((e) => e.details, 'details', isA<List<dynamic>>())
              .having(
                (e) => e.message,
                'message',
                '입력값이 올바르지 않습니다. (invalid body) — domain: bad name; root',
              ),
        ),
      );
    });

    test('429 keeps its details object and has no reason', () async {
      final (api, _) = apiWith(
        (_) async => _json({
          'error': {
            'code': 'rate_limited',
            'message': 'slow down',
            'details': {'retryAfterMs': 1000},
          },
        }, 429),
      );
      await expectLater(
        api.updateSite('st_1', {'domain': 'abc'}),
        throwsA(
          isA<ApiException>()
              .having((e) => e.reason, 'reason', isNull)
              .having((e) => e.details, 'details', {'retryAfterMs': 1000})
              .having(
                (e) => e.message,
                'message',
                '요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요. (slow down)',
              ),
        ),
      );
    });

    test('describeError looks up reason, then code, then status', () {
      expect(
        ProjectsApi.describeError(409, 'conflict', null, reason: 'domain_cap'),
        '팀의 이름 한도(20개)에 도달했습니다.',
      );
      expect(
        ProjectsApi.describeError(409, 'conflict', null, reason: 'unknown'),
        '요청이 현재 상태와 충돌합니다.',
      );
      // An unknown code no longer hides the status message.
      expect(
        ProjectsApi.describeError(404, 'gone_somewhere', null),
        '찾을 수 없습니다.',
      );
      expect(ProjectsApi.describeError(429, null, ''), startsWith('요청이 너무'));
      expect(ProjectsApi.describeError(418, 'teapot', null), '요청 실패: 418');
    });
  });
}
