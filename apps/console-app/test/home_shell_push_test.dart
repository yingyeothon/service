import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/home_shell.dart';
import 'package:yyt_console/profile_menu.dart';
import 'package:yyt_console/push/push_service.dart';

import 'projects/widget_test_support.dart';
import 'push/fake_push.dart';

const _topicA = 'yyt.catalog.dev.ca_a';
const _topicB = 'yyt.catalog.dev.ca_b';

/// One signed-in profile (`p_1`); [installed] are the application ids the
/// device reports, each at version 1.0.0.
void _device(Set<String> installed) {
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(
    const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
    (call) async {
      final key = (call.arguments as Map?)?['key'];
      if (call.method == 'readAll') return <String, String>{};
      if (call.method != 'read') return null;
      if (key == 'profiles') {
        return jsonEncode([
          {
            'id': 'p_1',
            'server': 'https://console-dev.yyt.life',
            'apiKey': 'yyt_test',
            'login': 'alice',
            'addedAt': '2026-09-27T00:00:00Z',
          },
        ]);
      }
      return key == 'active_profile' ? 'p_1' : null;
    },
  );
  messenger.setMockMethodCallHandler(
    const MethodChannel('life.yyt.console/appcheck'),
    (call) async {
      final package = (call.arguments as Map?)?['packageName'];
      return switch (call.method) {
        'isAppInstalled' => installed.contains(package),
        'getAppVersion' => installed.contains(package) ? '1.0.0' : null,
        _ => null,
      };
    },
  );
}

Map<String, Object?> _app(String id, String version, {String? topic}) => {
  'id': id,
  'name': 'app-$id',
  'path': 'pkg.$id',
  'description': '',
  'topic': topic,
  'latestArtifact': {
    'id': 'art_$id',
    'url': 'https://cdn.example/$id.apk',
    'platform': 'android',
    'size': 1,
    'tags': {'version': version, 'application_id': 'pkg.$id'},
    'createdAt': 10,
  },
  'applicationIds': ['pkg.$id'],
};

void main() {
  final platform = TestPlatform();
  late AuthState auth;
  late FakeMessaging fcm;
  late PushService push;
  late List<String> paths;

  /// Version of app A the server lists; a test moves it.
  var versionA = '1.0.0';

  /// Whether the server names topics (a console that predates them does not).
  var topics = true;

  MockClient client() => MockClient((req) async {
    paths.add(req.url.path);
    if (req.url.path == '/catalog/apps') {
      return http.Response(
        jsonEncode({
          'teams': [],
          'apps': [
            _app('ca_a', versionA, topic: topics ? _topicA : null),
            // Listed, with a topic, but not on this device.
            _app('ca_b', '1.0.0', topic: topics ? _topicB : null),
            // Installed, from a console that names no topic.
            _app('ca_c', '1.0.0'),
          ],
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    }
    if (req.url.path == '/catalog/listings') {
      final b = _app('ca_b', '1.0.0', topic: _topicB);
      return http.Response(
        jsonEncode({
          'listings': [
            {...b, 'appId': 'ca_b', 'appName': 'b', 'title': 'B'},
          ],
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    }
    return http.Response('', 404);
  });

  setUp(() {
    platform.install();
    _device({'pkg.ca_a', 'pkg.ca_c'});
    fcm = FakeMessaging();
    push = PushService(connect: () async => fcm, store: MemoryPushStore());
    paths = [];
    versionA = '1.0.0';
    topics = true;
  });
  tearDown(() {
    auth.dispose();
    push.dispose();
    platform.uninstall();
  });

  Future<void> launch(WidgetTester tester, {MemoryPushStore? store}) async {
    auth = AuthState();
    await tester.runAsync(() async {
      if (store != null) {
        push.dispose();
        push = PushService(connect: () async => fcm, store: store);
      }
      while (!auth.loaded) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      await push.start();
      await push.setScope(auth.activeProfile!.id);
    });
    await tester.pumpWidget(
      MaterialApp(
        home: HomeShell(
          authState: auth,
          client: client(),
          push: push,
          detailBuilder: (app) =>
              Scaffold(body: Text('detail ${app.id} ${app.version}')),
        ),
      ),
    );
    await settle(tester);
  }

  testWidgets('follows the topic of each installed app once the list is '
      'known, and asks for the permission then', (tester) async {
    await launch(tester);
    expect(fcm.calls, ['sub $_topicA']);
    expect(fcm.permissionRequests, 1);
  });

  testWidgets('a server that names no topic for an installed app: nothing '
      'is followed and the permission is not asked', (tester) async {
    topics = false;
    await launch(tester);
    expect(find.text('app-ca_a'), findsWidgets);
    expect(fcm.calls, isEmpty);
    expect(fcm.permissionRequests, 0);
  });

  testWidgets('an app followed through the browse tab and uninstalled '
      'since is dropped at launch, without opening the tab', (tester) async {
    // An earlier launch: B was installed and seen in the browse tab.
    final store = MemoryPushStore();
    await tester.runAsync(() async {
      final earlier = PushService(connect: () async => fcm, store: store);
      await earlier.start();
      await earlier.setScope('p_1');
      await earlier.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {_topicA: 'ca_a'},
      );
      await earlier.sync(
        scope: 'p_1',
        source: 'browse',
        topics: {_topicB: 'ca_b'},
      );
      earlier.dispose();
    });
    fcm.calls.clear();

    // B is not on the device any more (`_device` in setUp).
    await launch(tester, store: store);
    expect(paths.where((p) => p == '/catalog/listings'), hasLength(1));
    expect(fcm.calls, ['unsub $_topicB']);
    expect(fcm.topics, {_topicA});
  });

  testWidgets('a launch that follows nothing through the browse tab does '
      'not read the listings', (tester) async {
    await launch(tester);
    expect(paths, isNot(contains('/catalog/listings')));
  });

  testWidgets('the profile menu says whether this build can receive '
      'notices', (tester) async {
    expect(pushBuildLabel(true), '알림: 켜짐');
    await launch(tester);
    await tester.tap(find.byType(ProfileMenuButton).first);
    await tester.pumpAndSettle();
    // Tests are built without the Firebase defines.
    expect(find.text('알림: 꺼짐(빌드에 설정 없음)'), findsOneWidget);
  });

  testWidgets('a foreground notice is a SnackBar naming the app, reloads '
      'the list, and its action opens the detail', (tester) async {
    await launch(tester);
    final lists = paths.where((p) => p == '/catalog/apps').length;

    versionA = '2.0.0';
    fcm.foreground.add(catalogEvent(_topicA, 'ca_a', version: '2.0.0'));
    await settle(tester);
    expect(find.text('app-ca_a 새 버전 2.0.0'), findsOneWidget);
    expect(paths.where((p) => p == '/catalog/apps').length, lists + 1);

    await tester.tap(find.text('보기'));
    await settle(tester);
    expect(find.text('detail ca_a 2.0.0'), findsOneWidget);
  });

  testWidgets('a tap that started the app opens the detail after the first '
      'list load, without a second list request', (tester) async {
    fcm.initial = catalogEvent(_topicA, 'ca_a', version: '1.0.0');
    // A previous run followed the topic; that is what makes the tap ours.
    final store = MemoryPushStore();
    await tester.runAsync(() async {
      // Built in here: a future made in the test's fake-async zone would
      // never complete for code awaiting it in real time.
      final earlier = PushService(connect: () async => fcm, store: store);
      await earlier.start();
      await earlier.setScope('p_1');
      await earlier.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {_topicA: 'ca_a'},
      );
      earlier.dispose();
    });
    fcm.calls.clear();

    await launch(tester, store: store);
    expect(find.text('detail ca_a 1.0.0'), findsOneWidget);
    expect(paths.where((p) => p == '/catalog/apps'), hasLength(1));
    expect(push.pendingOpen.value, isNull);
    // Already followed: the launch subscribes nothing again.
    expect(fcm.calls, isEmpty);
  });

  testWidgets('a background tap reads the list again when it does not show '
      'the announced version yet', (tester) async {
    await launch(tester);
    versionA = '2.0.0';
    fcm.opened.add(catalogEvent(_topicA, 'ca_a', version: '2.0.0'));
    await settle(tester);
    expect(find.text('detail ca_a 2.0.0'), findsOneWidget);
  });

  testWidgets('a notice for an app this profile does not follow does '
      'nothing', (tester) async {
    await launch(tester);
    fcm.opened.add(catalogEvent(_topicB, 'ca_b'));
    fcm.foreground.add(catalogEvent('yyt.catalog.prod.ca_a', 'ca_a'));
    await settle(tester);
    expect(find.textContaining('detail'), findsNothing);
    expect(find.byType(SnackBar), findsNothing);
  });
}

/// Lets the real async work (platform channels, the mock client) finish.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump(const Duration(milliseconds: 400));
  }
}
