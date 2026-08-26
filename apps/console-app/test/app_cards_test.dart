import 'package:yyt_console/app_cards.dart';
import 'package:yyt_console/app_info.dart';
import 'package:yyt_console/app_install_state.dart';
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/artifact_version_group.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  _gridTests();
  testWidgets('AppSummaryCard prefers changelog and compact metadata', (
    tester,
  ) async {
    final app = AppInfo(
      id: 'ca_demo',
      name: 'Demo',
      package: 'com.example.demo',
      description: 'Old description',
      latestArtifact: ArtifactInfo(
        id: 'artifact-1',
        url: 'https://example.com/app.apk',
        platform: 'android',
        size: 1200,
        createdAt: DateTime.parse('2026-03-19T12:00:00Z'),
        tags: {
          'version': '1.0.2',
          'build_type': 'debug',
          'application_id': 'com.example.demo',
          'changelog': 'Fix login flow',
        },
      ),
      installedVersion: '1.0.2+4',
      needsUpdate: false,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppSummaryCard(
            app: app,
            state: AppInstallState.latest,
            installedVersion: app.installedVersion,
          ),
        ),
      ),
    );

    expect(find.text('Fix login flow'), findsOneWidget);
    expect(find.text('v1.0.2 (debug)'), findsOneWidget);
    expect(find.text('com.example.demo'), findsOneWidget);
    expect(find.textContaining('application.id'), findsNothing);
    expect(find.textContaining('build_type'), findsNothing);
  });

  testWidgets('ArtifactReleaseCard shows old-version chip and install button', (
    tester,
  ) async {
    final artifact = ArtifactInfo(
      id: 'artifact-2',
      url: 'https://example.com/app-old.apk',
      platform: 'android',
      size: 1024,
      createdAt: DateTime.parse('2026-03-18T12:00:00Z'),
      tags: {
        'version': '1.0.1',
        'build_type': 'release',
        'application_id': 'com.example.demo',
        'changelog': 'Previous stable build',
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ArtifactReleaseCard(
            artifact: artifact,
            latestVersion: '1.0.2',
            installedVersion: '1.0.2',
            busy: false,
            onInstall: () {},
          ),
        ),
      ),
    );

    expect(find.text('옛날 버전'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '설치'), findsOneWidget);
    expect(find.text('되돌리기'), findsNothing);
    expect(find.text('이 버전으로 되돌리기'), findsNothing);
  });

  testWidgets('ArtifactReleaseCard allows reinstalling installed version', (
    tester,
  ) async {
    final artifact = ArtifactInfo(
      id: 'artifact-current',
      url: 'https://example.com/app.apk',
      platform: 'android',
      size: 1024,
      createdAt: DateTime.parse('2026-03-19T12:00:00Z'),
      tags: {
        'version': '1.0.2',
        'build_type': 'release',
        'application_id': 'com.example.demo',
      },
    );

    var installPressed = false;
    var deletePressed = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ArtifactReleaseCard(
            artifact: artifact,
            latestVersion: '1.0.2',
            installedVersion: '1.0.2+4',
            busy: false,
            onInstall: () {
              installPressed = true;
            },
            onDelete: () {
              deletePressed = true;
            },
          ),
        ),
      ),
    );

    await tester.tap(find.widgetWithText(FilledButton, '재설치'));
    await tester.tap(find.byTooltip('아티팩트 삭제'));

    expect(installPressed, isTrue);
    expect(deletePressed, isTrue);
  });

  testWidgets('ArtifactReleaseCard hides install action for app bundles', (
    tester,
  ) async {
    final artifact = ArtifactInfo(
      id: 'artifact-aab',
      url: 'https://example.com/app-release.aab',
      platform: 'android',
      size: 2048,
      createdAt: DateTime.parse('2026-03-18T12:00:00Z'),
      tags: {
        'version': '1.0.2',
        'build_type': 'appbundle',
        'application_id': 'com.example.demo',
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ArtifactReleaseCard(
            artifact: artifact,
            latestVersion: '1.0.2',
            installedVersion: null,
            busy: false,
            installable: false,
            onInstall: () {},
          ),
        ),
      ),
    );

    expect(find.widgetWithText(FilledButton, '설치'), findsNothing);
    expect(find.text('설치 불가'), findsOneWidget);
    expect(find.text('aab'), findsOneWidget);
  });

  testWidgets(
    'ArtifactVersionGroupCard marks the installed build variant within a mixed group',
    (tester) async {
      final release = ArtifactInfo(
        id: 'release-1',
        url: 'https://example.com/app-release.apk',
        platform: 'android',
        size: 1024,
        createdAt: DateTime.parse('2026-03-19T12:00:00Z'),
        tags: const {
          'version': '1.0.2',
          'build_type': 'release',
          'application_id': 'com.example.demo',
        },
      );
      final debug = ArtifactInfo(
        id: 'debug-1',
        url: 'https://example.com/app-debug.apk',
        platform: 'android',
        size: 1024,
        createdAt: DateTime.parse('2026-03-19T13:00:00Z'),
        tags: const {
          'version': '1.0.2',
          'build_type': 'debug',
          'application_id': 'com.example.demo.debug',
        },
      );
      final group = groupArtifactsByVersion([release, debug]).single;

      // Only the .debug variant is installed on the device.
      String? installedVersionForArtifact(ArtifactInfo artifact) =>
          artifact.applicationId == 'com.example.demo.debug' ? '1.0.2' : null;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ArtifactVersionGroupCard(
              group: group,
              latestVersion: '1.0.2',
              installedVersionForArtifact: installedVersionForArtifact,
              busy: false,
              onInstallArtifact: (_) {},
            ),
          ),
        ),
      );

      // Group is recognized as installed because the debug variant matches.
      expect(find.text('현재 설치됨'), findsWidgets);
      // The installed debug artifact offers reinstall; the release one offers install.
      expect(find.widgetWithText(FilledButton, '재설치'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '설치'), findsOneWidget);
    },
  );
}

void _gridTests() {
  AppInfo app({String description = 'Console companion'}) => AppInfo(
    id: 'ca_console',
    name: 'console',
    package: 'life.yyt.console',
    description: description,
    latestArtifact: ArtifactInfo(
      id: 'artifact-9',
      url: 'https://example.com/console.apk',
      platform: 'android',
      size: 10,
      createdAt: DateTime.parse('2026-08-27T00:00:00Z'),
      tags: {'version': '1.5.1', 'build_type': 'release'},
    ),
    installedVersion: null,
    needsUpdate: true,
  );

  testWidgets('AppGridCard shows name then description', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 180,
            child: AppGridCard(app: app(), state: AppInstallState.notInstalled),
          ),
        ),
      ),
    );
    expect(find.text('console'), findsOneWidget);
    expect(find.text('Console companion'), findsOneWidget);
    expect(find.text('v1.5.1'), findsOneWidget);
    expect(find.text('미설치'), findsOneWidget);
  });

  test('hero title is description (name), name alone without description', () {
    expect(appHeroTitle(app()), 'Console companion (console)');
    expect(appHeroTitle(app(description: '  ')), 'console');
  });

  test('grid columns: 2 on phones, 4 on near-square screens', () {
    expect(appGridColumns(const Size(411, 891)), 2);
    expect(appGridColumns(const Size(891, 411)), 2);
    expect(appGridColumns(const Size(800, 800)), 4);
    expect(appGridColumns(const Size(900, 720)), 4);
    // Split-screen phone: near-square but too narrow for four cards.
    expect(appGridColumns(const Size(412, 440)), 2);
    expect(appGridColumns(Size.zero), 2);
  });
}
