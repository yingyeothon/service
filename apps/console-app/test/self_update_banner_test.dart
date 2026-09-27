import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/self_update_banner.dart';
import 'package:yyt_console/self_update_check.dart';

import 'projects/widget_test_support.dart';

/// Counts how often its state is created. The banner's child is the app list,
/// and a new state means a new list load.
class _Probe extends StatefulWidget {
  const _Probe();

  static int inits = 0;

  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  @override
  void initState() {
    super.initState();
    _Probe.inits++;
  }

  @override
  Widget build(BuildContext context) => const Text('list');
}

final _update = ConsoleAppUpdate(
  installedVersion: '1.5.3+22',
  packageName: 'life.yyt.console',
  artifact: ArtifactInfo.fromJson({
    'id': 'installer:1.5.4+23',
    'url': 'https://cdn.example/console.apk',
    'platform': 'android',
    'size': 0,
    'tags': {'version': '1.5.4+23'},
    'createdAt': 0,
  }),
);

void main() {
  final platform = TestPlatform();
  late AuthState auth;

  setUp(() {
    platform.install();
    _Probe.inits = 0;
    auth = AuthState();
  });
  tearDown(() {
    auth.dispose();
    platform.uninstall();
  });

  Widget banner({
    Future<void>? startAfter,
    required Future<ConsoleAppUpdate?> Function({required String? token}) check,
  }) => MaterialApp(
    home: Scaffold(
      body: SelfUpdateBanner(
        authState: auth,
        startAfter: startAfter,
        check: check,
        child: const _Probe(),
      ),
    ),
  );

  testWidgets('checks only after the first list load, and once', (
    tester,
  ) async {
    final firstLoad = Completer<void>();
    var checks = 0;
    await tester.pumpWidget(
      banner(
        startAfter: firstLoad.future,
        check: ({required String? token}) async {
          checks++;
          return null;
        },
      ),
    );
    await tester.pump(const Duration(seconds: 5));
    expect(checks, 0);
    firstLoad.complete();
    await tester.pump();
    expect(checks, 1);
    await tester.pump(SelfUpdateBanner.startAfterCap);
    expect(checks, 1);
  });

  testWidgets('a first load that never ends delays the check by the cap only', (
    tester,
  ) async {
    var checks = 0;
    await tester.pumpWidget(
      banner(
        startAfter: Completer<void>().future,
        check: ({required String? token}) async {
          checks++;
          return null;
        },
      ),
    );
    await tester.pump(
      SelfUpdateBanner.startAfterCap - const Duration(seconds: 1),
    );
    expect(checks, 0);
    await tester.pump(const Duration(seconds: 2));
    expect(checks, 1);
  });

  testWidgets('showing and dismissing the banner keeps the list alive', (
    tester,
  ) async {
    await tester.pumpWidget(
      banner(check: ({required String? token}) async => _update),
    );
    await tester.pump();
    expect(find.textContaining('새 버전 1.5.4+23'), findsOneWidget);
    expect(find.text('list'), findsOneWidget);
    expect(_Probe.inits, 1);

    await tester.tap(find.byTooltip('닫기'));
    await tester.pump();
    expect(find.textContaining('새 버전'), findsNothing);
    expect(find.text('list'), findsOneWidget);
    expect(_Probe.inits, 1);
  });
}
