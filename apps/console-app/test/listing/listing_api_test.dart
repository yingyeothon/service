import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/listing/listing_models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

Map<String, dynamic> _listing({String audience = 'public'}) => {
  'appId': 'ca_1',
  'appName': 'game',
  'teamId': 'team_1',
  'teamName': 'crew',
  'title': 'Game',
  'summary': 'fun',
  'tags': ['puzzle'],
  'audience': audience,
  'publishedBy': 'me',
  'publishedAt': 1700000000,
  'updatedAt': 1700000000,
  'takenDown': false,
};

void main() {
  setUp(() => AuthConfig.setServerUrl('console-dev.yyt.life'));
  tearDown(AuthConfig.clearServerUrl);

  test('getListing: 404 is "not published", the rest is thrown', () async {
    var status = 404;
    final api = ProjectsApi(
      token: 'tok',
      client: MockClient((req) async {
        expect(req.url.path, '/catalog/apps/ca_1/listing');
        expect(req.headers['Authorization'], 'Bearer tok');
        return _json({
          'error': {'code': 'not_found', 'message': 'listing not found'},
        }, status);
      }),
    );
    expect(await api.getListing('ca_1'), isNull);
    status = 403;
    await expectLater(
      api.getListing('ca_1'),
      throwsA(isA<ApiException>().having((e) => e.status, 'status', 403)),
    );
  });

  test('publishListing PUTs the body and reads the row', () async {
    late http.Request seen;
    final api = ProjectsApi(
      token: 'tok',
      client: MockClient((req) async {
        seen = req;
        return _json(_listing(audience: 'members'), 201);
      }),
    );
    final l = await api.publishListing('ca_1', {
      'title': 'Game',
      'summary': null,
      'tags': ['puzzle'],
      'audience': 'members',
    });
    expect(seen.method, 'PUT');
    expect(seen.url.path, '/catalog/apps/ca_1/listing');
    expect(seen.headers['Content-Type'], startsWith('application/json'));
    expect(jsonDecode(seen.body), {
      'title': 'Game',
      'summary': null,
      'tags': ['puzzle'],
      'audience': 'members',
    });
    expect(l.audience, ListingAudience.members);
  });

  test('a takedown 409 carries the Korean reason', () async {
    final api = ProjectsApi(
      token: 'tok',
      client: MockClient(
        (req) async => _json({
          'error': {
            'code': 'conflict',
            'message': "this app's listing was taken down by a platform admin",
            'details': {'reason': 'taken_down'},
          },
        }, 409),
      ),
    );
    await expectLater(
      api.publishListing('ca_1', {'title': 'x', 'audience': 'public'}),
      throwsA(
        isA<ApiException>()
            .having((e) => e.reason, 'reason', 'taken_down')
            .having((e) => e.message, 'message', contains('관리자')),
      ),
    );
  });

  test('viewers: list, add (201/200), remove, unpublish', () async {
    final calls = <String>[];
    final api = ProjectsApi(
      token: 'tok',
      client: MockClient((req) async {
        calls.add('${req.method} ${req.url.path}');
        switch ((req.method, req.url.path)) {
          case ('GET', '/catalog/apps/ca_1/listing/viewers'):
            return _json({
              'viewers': [
                {'login': 'octocat', 'addedBy': 'me', 'addedAt': 1700000000},
              ],
            });
          case ('POST', '/catalog/apps/ca_1/listing/viewers'):
            final login = (jsonDecode(req.body) as Map)['login'];
            return login == 'octocat'
                ? _json({'login': 'octocat', 'added': false})
                : _json({'login': login, 'added': true}, 201);
          case ('DELETE', '/catalog/apps/ca_1/listing/viewers/a%2Fb'):
          case ('DELETE', '/catalog/apps/ca_1/listing'):
            return http.Response('', 204);
        }
        return _json({
          'error': {'code': 'not_found', 'message': 'no'},
        }, 404);
      }),
    );
    final viewers = await api.listListingViewers('ca_1');
    expect(viewers.single.login, 'octocat');
    expect((await api.addListingViewer('ca_1', 'octocat')).added, isFalse);
    final added = await api.addListingViewer('ca_1', 'new');
    expect(added.added, isTrue);
    expect(added.login, 'new');
    await api.removeListingViewer('ca_1', 'a/b');
    await api.unpublishListing('ca_1');
    expect(calls.last, 'DELETE /catalog/apps/ca_1/listing');
    expect(calls, contains('DELETE /catalog/apps/ca_1/listing/viewers/a%2Fb'));
  });
}
