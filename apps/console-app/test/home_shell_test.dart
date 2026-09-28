import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/home_shell.dart';

import 'projects/widget_test_support.dart';

/// Secure storage holding one active profile, so `AuthState` loads signed in;
/// no app is installed.
void _signedInDevice() {
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
    (call) async => call.method == 'isAppInstalled' ? false : null,
  );
}

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status);

void main() {
  final platform = TestPlatform();
  late AuthState auth;

  setUp(() {
    platform.install();
    _signedInDevice();
  });
  tearDown(() {
    auth.dispose();
    platform.uninstall();
  });

  Future<void> signIn(WidgetTester tester) async {
    auth = AuthState();
    await tester.runAsync(() async {
      while (!auth.loaded) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
    });
    expect(auth.isLoggedIn, isTrue);
  }

  /// Records request paths; the first list load answers when [firstList]
  /// completes, later ones at once. The update check finds nothing to offer.
  MockClient recording(List<String> paths, Completer<http.Response> firstList) {
    var lists = 0;
    return MockClient((req) {
      paths.add(req.url.path);
      if (req.url.path == '/catalog/apps') {
        return lists++ == 0
            ? firstList.future
            : Future.value(_json({'apps': [], 'teams': []}));
      }
      return Future.value(http.Response('', 404));
    });
  }

  testWidgets('the update check waits for the first list load, and runs once', (
    tester,
  ) async {
    await signIn(tester);
    final paths = <String>[];
    final firstList = Completer<http.Response>();
    await tester.pumpWidget(
      MaterialApp(
        home: HomeShell(authState: auth, client: recording(paths, firstList)),
      ),
    );
    await tester.pump(const Duration(seconds: 5));
    expect(paths, ['/catalog/apps']);

    firstList.complete(_json({'apps': [], 'teams': []}));
    await tester.pump();
    await tester.pump();
    expect(paths, ['/catalog/apps', '/catalog/installer/downloads']);

    // A refresh reloads the list, not the check.
    await tester.tap(find.byTooltip('새로고침'));
    await tester.pump();
    await tester.pump();
    expect(paths, [
      '/catalog/apps',
      '/catalog/installer/downloads',
      '/catalog/apps',
    ]);
  });

  testWidgets('the browse tab is built on first visit and asks once', (
    tester,
  ) async {
    await signIn(tester);
    final paths = <String>[];
    final client = MockClient((req) async {
      paths.add(req.url.path);
      switch (req.url.path) {
        case '/catalog/apps':
          return _json({'apps': [], 'teams': []});
        case '/catalog/listings':
          expect(req.url.queryParameters, {'platform': 'android'});
          return _json({'listings': []});
      }
      return http.Response('', 404);
    });
    await tester.pumpWidget(
      MaterialApp(home: HomeShell(authState: auth, client: client)),
    );
    await tester.pump();
    await tester.pump();
    expect(paths, isNot(contains('/catalog/listings')));
    await tester.tap(find.text('둘러보기'));
    await tester.pump();
    await tester.pump();
    expect(paths.where((p) => p == '/catalog/listings'), hasLength(1));
    expect(find.text('게시된 앱이 없습니다'), findsOneWidget);
    // Coming back does not reload it.
    await tester.tap(find.text('앱'));
    await tester.pump();
    await tester.tap(find.text('둘러보기'));
    await tester.pump();
    expect(paths.where((p) => p == '/catalog/listings'), hasLength(1));
  });

  testWidgets('a failed first load still releases the update check', (
    tester,
  ) async {
    await signIn(tester);
    final paths = <String>[];
    final firstList = Completer<http.Response>();
    await tester.pumpWidget(
      MaterialApp(
        home: HomeShell(authState: auth, client: recording(paths, firstList)),
      ),
    );
    await tester.pump();
    firstList.complete(http.Response('', 503));
    await tester.pump();
    await tester.pump();
    expect(find.text('앱 목록을 불러오지 못했습니다'), findsOneWidget);
    expect(paths, ['/catalog/apps', '/catalog/installer/downloads']);
  });
}
