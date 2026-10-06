import 'dart:async';
import 'dart:convert';

import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/projects/channel_detail_screen.dart';
import 'package:yyt_console/projects/channels_tab.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/secret_once_screen.dart';
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
const _member = Team(id: 'team_1', name: 'crew', role: 'member');

/// 64 hex characters, distinctive enough that no label can contain it.
final _sentinel = '0123456789abcdef' * 4;

Map<String, dynamic> _authView() => {
  'id': 'auth_1',
  'kind': 'auth',
  'name': 'login',
  'teamId': 'team_1',
  'projectId': 'prj_1',
  'config': {
    'audience': 'game',
    'tokenTtlSec': 86400,
    'redirectAllowlist': ['https://game.example/cb'],
    'providers': {
      'github': {'clientId': 'gh-id'},
    },
  },
  'createdAt': 1700000000,
  'expiresAt': 4102444800,
  'disabledAt': null,
  'status': 'active',
  'issuer': 'yyt-auth/auth_1',
  'startUrl': 'https://auth.example/c/auth_1/start',
  'callbackUrls': {'github': 'https://auth.example/c/auth_1/github/callback'},
};

/// A fake console for one project's channels.
class _ChannelServer {
  _ChannelServer({bool withAuth = true}) {
    if (withAuth) channels['auth_1'] = _authView();
  }

  final channels = <String, Map<String, dynamic>>{};
  final calls = <String>[];
  final bodies = <String, Object?>{};

  http.Client get client => MockClient((req) async {
    final call = '${req.method} ${req.url.path}';
    calls.add(req.url.hasQuery ? '$call?${req.url.query}' : call);
    if (req.body.isNotEmpty) bodies[call] = jsonDecode(req.body);
    final path = req.url.path;
    if (path == '/limits') {
      return jsonResponse({
        'scope': {
          'kind': 'channel',
          'id': req.url.queryParameters['scope']?.split(':').last,
        },
        'teamId': 'team_1',
        'limits': <Object>[],
        'pending': <Object>[],
      });
    }
    if (path == '/projects/prj_1/channels') {
      if (req.method == 'GET') {
        final kind = req.url.queryParameters['kind'];
        return jsonResponse({
          'channels': [
            for (final c in channels.values)
              if (kind == null || c['kind'] == kind) c,
          ],
        });
      }
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      final kind = body['kind'] as String;
      final view = {
        'id': '${kind}_new',
        'kind': kind,
        'name': body['name'],
        'teamId': 'team_1',
        'projectId': 'prj_1',
        'config': body['config'],
        'createdAt': 1700000000,
        'expiresAt': 4102444800,
        'disabledAt': null,
        'status': 'active',
      };
      channels[view['id'] as String] = view;
      return jsonResponse({
        ...view,
        if (kind == 'auth') 'secret': _sentinel,
        if (kind == 'topic' || kind == 'match') 'apiKey': _sentinel,
      }, 201);
    }
    final id = path.split('/')[2];
    if (path.endsWith('/extend')) {
      return jsonResponse({
        'error': {
          'code': 'conflict',
          'message': 'already at the maximum expiry',
        },
      }, 409);
    }
    switch (req.method) {
      case 'GET':
        final c = channels[id];
        return c == null ? http.Response('', 404) : jsonResponse(c);
      case 'PATCH':
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        channels[id] = {
          ...channels[id]!,
          if (body['name'] != null) 'name': body['name'],
        };
        return jsonResponse(channels[id]!);
      case 'DELETE':
        channels.remove(id);
        return http.Response('', 204);
    }
    return http.Response('', 404);
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final platform = TestPlatform();
  setUp(platform.install);
  tearDown(platform.uninstall);

  Future<void> tall(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 3000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
  }

  Future<void> pumpTab(
    WidgetTester tester,
    _ChannelServer server,
    FakeSecureWindow window,
  ) async {
    await tall(tester);
    await tester.pumpWidget(
      MaterialApp(
        home: ChannelsTab(
          authState: AuthState(),
          team: _member,
          project: _project,
          api: ProjectsApi(token: 'tok', client: server.client),
          secureWindow: window,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> pumpDetail(
    WidgetTester tester,
    _ChannelServer server, {
    Team team = _member,
    String channelId = 'auth_1',
  }) async {
    await tall(tester);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => ChannelDetailScreen(
                    authState: AuthState(),
                    team: team,
                    api: ProjectsApi(token: 'tok', client: server.client),
                    channelId: channelId,
                  ),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  Future<void> chooseKind(WidgetTester tester, String label) async {
    await tester.tap(find.text('auth — 플레이어에게 JWT 발급 (GitHub/Google 로그인)'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(label).last);
    await tester.pumpAndSettle();
  }

  testWidgets('auth create shows the secret once behind a secure window, '
      'then replaces itself with the detail', (tester) async {
    final server = _ChannelServer(withAuth: false);
    final window = FakeSecureWindow()..hold = Completer<void>();
    await pumpTab(tester, server, window);

    await tester.tap(find.text('채널 만들기'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('field-name')), 'login');
    await tester.enterText(
      find.byKey(const ValueKey('field-audience')),
      'my-game',
    );
    await tester.tap(find.widgetWithText(FilledButton, '채널 만들기'));
    // A spinner runs while the window is not yet secure: pump frames rather
    // than settle.
    for (var i = 0; i < 20; i += 1) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(server.bodies['POST /projects/prj_1/channels'], {
      'kind': 'auth',
      'name': 'login',
      'config': {
        'audience': 'my-game',
        'tokenTtlSec': 86400,
        'redirectAllowlist': <String>[],
        'providers': <String, dynamic>{},
      },
    });

    // Not a frame with the value until the window is secure.
    expect(find.byType(SecretOnceScreen), findsOneWidget);
    expect(window.calls, ['setSecure:true']);
    expect(find.text(_sentinel), findsNothing);
    window.hold!.complete();
    await tester.pumpAndSettle();
    final value = find.byKey(const ValueKey('secret-value'));
    expect(tester.widget<Text>(value).data, _sentinel);
    expect(find.byType(SelectableText), findsNothing);

    await tester.tap(find.text('채널 시크릿 복사'));
    await tester.pumpAndSettle();
    expect(window.calls.last, 'copySensitive:60s');
    expect(platform.clipboard, _sentinel);

    // Leaving asks first; staying keeps the value.
    await tester.tap(find.byTooltip('닫기'));
    await tester.pumpAndSettle();
    expect(find.text('이 화면을 떠날까요?'), findsOneWidget);
    await tester.tap(find.text('계속 보기'));
    await tester.pumpAndSettle();
    expect(find.text(_sentinel), findsOneWidget);

    await tester.tap(find.text('보관했습니다 · 채널 보기'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '보관했습니다'));
    await tester.pumpAndSettle();
    expect(find.byType(ChannelDetailScreen), findsOneWidget);
    expect(find.byType(SecretOnceScreen), findsNothing);
    expect(find.text(_sentinel), findsNothing);
    expect(window.calls, [
      'setSecure:true',
      'copySensitive:60s',
      'setSecure:false',
    ]);

    // The clipboard forgets the value after a minute.
    await tester.pump(const Duration(seconds: 61));
    await tester.pumpAndSettle();
    expect(platform.clipboard, '');

    // Back from the detail lands on the list, not on the secret.
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byType(SecretOnceScreen), findsNothing);
    expect(find.text('login'), findsOneWidget);
  });

  testWidgets('a lobby create has no credential and opens the detail', (
    tester,
  ) async {
    final server = _ChannelServer();
    final window = FakeSecureWindow();
    await pumpTab(tester, server, window);
    await tester.tap(find.text('채널 만들기'));
    await tester.pumpAndSettle();
    expect(server.calls, contains('GET /projects/prj_1/channels?kind=auth'));
    await chooseKind(tester, 'lobby — 실시간 릴레이: 이동, 채팅, 파티');
    await tester.enterText(find.byKey(const ValueKey('field-name')), 'world');
    await tester.tap(find.text('— 선택 —'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('login (auth_1)').last);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '채널 만들기'));
    await tester.pumpAndSettle();

    final body = server.bodies['POST /projects/prj_1/channels'] as Map;
    expect(body['kind'], 'lobby');
    expect((body['config'] as Map)['authChannelId'], 'auth_1');
    expect(find.byType(SecretOnceScreen), findsNothing);
    expect(find.byType(ChannelDetailScreen), findsOneWidget);
    expect(find.text('world'), findsWidgets);
    expect(window.calls, isEmpty);
  });

  testWidgets('a non-auth kind without an auth channel cannot be submitted', (
    tester,
  ) async {
    final server = _ChannelServer(withAuth: false);
    await pumpTab(tester, server, FakeSecureWindow());
    await tester.tap(find.text('채널 만들기'));
    await tester.pumpAndSettle();
    await chooseKind(tester, 'topic — WebSocket 브로드캐스트 토픽');
    expect(
      find.text('topic/match/lobby/q 채널은 이 프로젝트의 auth 채널이 필요합니다.'),
      findsOneWidget,
    );
    final submit = tester.widget<ButtonStyleButton>(
      find.widgetWithText(FilledButton, '채널 만들기'),
    );
    expect(submit.onPressed, isNull);
    await tester.tap(find.text('auth 채널 먼저 만들기'));
    await tester.pumpAndSettle();
    // The picker follows, and the auth fields replace the topic ones.
    final picker = tester.state<FormFieldState<String>>(
      find.byType(DropdownButtonFormField<String>).first,
    );
    expect(picker.value, 'auth');
    expect(find.byKey(const ValueKey('field-audience')), findsOneWidget);
    expect(
      tester
          .widget<ButtonStyleButton>(
            find.widgetWithText(FilledButton, '채널 만들기'),
          )
          .onPressed,
      isNotNull,
    );
  });

  testWidgets('an auth edit keeps the stored provider secret by omitting it', (
    tester,
  ) async {
    final server = _ChannelServer();
    await pumpDetail(tester, server);
    expect(find.text('yyt-auth/auth_1'), findsOneWidget);
    expect(
      find.text('https://auth.example/c/auth_1/github/callback'),
      findsOneWidget,
    );
    await tester.tap(find.byTooltip('채널 편집'));
    await tester.pumpAndSettle();

    final secretField = tester.widget<TextField>(
      find.byKey(const ValueKey('field-githubSecretInput')),
    );
    expect(secretField.obscureText, isTrue);
    expect(secretField.enableSuggestions, isFalse);
    expect(secretField.autocorrect, isFalse);
    expect(secretField.enableIMEPersonalizedLearning, isFalse);

    await tester.enterText(
      find.byKey(const ValueKey('field-audience')),
      'game2',
    );
    await tester.tap(find.widgetWithText(FilledButton, '저장'));
    await tester.pumpAndSettle();
    final body = server.bodies['PATCH /channels/auth_1'] as Map;
    expect(body.containsKey('name'), isFalse);
    final config = body['config'] as Map;
    expect(config['audience'], 'game2');
    final github = (config['providers'] as Map)['github'] as Map;
    expect(github, {'clientId': 'gh-id'});
    expect(github.containsKey('clientSecret'), isFalse);
    expect(find.text('저장했습니다.'), findsOneWidget);
  });

  testWidgets('extend at the cap answers with a SnackBar', (tester) async {
    final server = _ChannelServer();
    await pumpDetail(tester, server);
    await tester.tap(find.text('+7일 연장'));
    await tester.pumpAndSettle();
    expect(server.calls.last, 'POST /channels/auth_1/extend');
    expect(find.text('이미 최대 만료일(28일 뒤)까지 연장되어 있습니다.'), findsOneWidget);
  });

  testWidgets('a channel with no expiry says so and offers no extend', (
    tester,
  ) async {
    final server = _ChannelServer();
    server.channels['auth_1'] = {
      ...server.channels['auth_1']!,
      'expiresAt': 253402300799,
    };
    await pumpDetail(tester, server);
    expect(find.textContaining('만료 없음'), findsOneWidget);
    expect(find.text('+7일 연장'), findsNothing);
  });

  testWidgets('an unseated admin may extend and delete but not edit', (
    tester,
  ) async {
    final server = _ChannelServer();
    await pumpDetail(
      tester,
      server,
      team: const Team(id: 'team_1', name: 'crew', role: 'admin'),
    );
    expect(find.byTooltip('채널 편집'), findsNothing);
    expect(find.text('+7일 연장'), findsOneWidget);
    await tester.tap(find.byTooltip('더보기'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('채널 삭제'));
    await tester.pumpAndSettle();
    expect(find.text('login 채널을 삭제할까요?'), findsOneWidget);
    expect(find.textContaining('리더보드 점수'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '채널 삭제'));
    await tester.pumpAndSettle();
    expect(server.calls.last, 'DELETE /channels/auth_1');
    expect(find.byType(ChannelDetailScreen), findsNothing);
  });

  testWidgets('the auth picker keeps a linked id it cannot list', (
    tester,
  ) async {
    final server = _ChannelServer();
    server.channels['topic_1'] = {
      'id': 'topic_1',
      'kind': 'topic',
      'name': 'news',
      'teamId': 'team_1',
      'projectId': 'prj_1',
      'config': {'authChannelId': 'auth_gone'},
      'createdAt': 1700000000,
      'expiresAt': 4102444800,
      'disabledAt': null,
      'status': 'active',
      'apiBase': 'https://topic.example',
      'wsUrl': 'wss://topic-ws.example/',
    };
    await pumpDetail(tester, server, channelId: 'topic_1');
    expect(find.text('https://topic.example'), findsOneWidget);
    await tester.tap(find.byTooltip('채널 편집'));
    await tester.pumpAndSettle();
    final picker = tester.state<FormFieldState<String>>(
      find.byType(DropdownButtonFormField<String>),
    );
    expect(picker.value, 'auth_gone');
    await tester.tap(find.text('(목록에 없음) (auth_gone)'));
    await tester.pumpAndSettle();
    expect(find.text('login (auth_1)').last, findsOneWidget);
    await tester.tap(find.text('(목록에 없음) (auth_gone)').last);
    await tester.pumpAndSettle();
    // Nothing changed: the form closes without a request.
    await tester.tap(find.widgetWithText(FilledButton, '저장'));
    await tester.pumpAndSettle();
    expect(server.calls.where((c) => c.startsWith('PATCH')), isEmpty);
    expect(find.text('news'), findsWidgets);
  });

  testWidgets('a q channel copies its tslib prefixes as one block', (
    tester,
  ) async {
    final server = _ChannelServer();
    const prefixes = {
      'eventKeyPrefix': 'game:dev:q_1:event:',
      'queueKeyPrefix': 'game:dev:q_1:queue:',
      'lockKeyPrefix': 'game:dev:q_1:lock:',
      'awaiterKeyPrefix': 'game:dev:q_1:awaiter:',
      'channelPrefix': 'game:out:dev:q_1:',
    };
    server.channels['q_1'] = {
      'id': 'q_1',
      'kind': 'q',
      'name': 'rooms',
      'teamId': 'team_1',
      'projectId': 'prj_1',
      'config': {'authChannelId': 'auth_1'},
      'createdAt': 1700000000,
      'expiresAt': 4102444800,
      'disabledAt': null,
      'status': 'active',
      'redis': {
        ...prefixes,
        'aclKeyPattern': '~game:dev:q_1:*',
        'aclChannelPattern': '&game:out:dev:q_1:*',
        'aclUsername': 'game_dev_q_1',
      },
    };
    await pumpDetail(tester, server, channelId: 'q_1');
    // No gateway on this stage: said so instead of an empty URL.
    expect(find.textContaining('아직 게이트웨이가 없어'), findsOneWidget);
    await tester.tap(find.byTooltip('접두사 전체 복사'));
    await tester.pumpAndSettle();
    expect(
      platform.clipboard,
      prefixes.entries.map((e) => '${e.key}: ${e.value}').join('\n'),
    );
    expect(find.text('game_dev_q_1'), findsOneWidget);
  });
}
