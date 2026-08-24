import 'package:catalog/app_cards.dart';
import 'package:catalog/app_info.dart';
import 'package:catalog/app_install_state.dart';
import 'package:catalog/artifact_info.dart';
import 'package:catalog/artifact_version_group.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('AppSummaryCard prefers changelog and compact metadata', (
    tester,
  ) async {
    final app = AppInfo(
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
