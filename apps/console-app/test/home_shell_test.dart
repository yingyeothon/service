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
