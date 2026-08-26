import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/artifact_version_group.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('groups artifacts by version using latest upload as top artifact', () {
    final base = DateTime.parse('2026-05-05T12:00:00Z');
    final groups = groupArtifactsByVersion([
      ArtifactInfo(
        id: 'v1-second',
        url: 'https://example.com/app-release.apk',
        platform: 'android',
        size: 200,
        tags: {'version': '1.0.0', 'build_type': 'release'},
        createdAt: base.add(const Duration(minutes: 10)),
      ),
      ArtifactInfo(
        id: 'v2-first',
        url: 'https://example.com/app-debug.apk',
        platform: 'android',
        size: 100,
        tags: {'version': '2.0.0', 'build_type': 'debug'},
        createdAt: base.add(const Duration(minutes: 5)),
      ),
      ArtifactInfo(
        id: 'v1-first',
        url: 'https://example.com/app-debug.apk',
        platform: 'android',
        size: 100,
        tags: {'version': '1.0.0', 'build_type': 'debug'},
        createdAt: base,
      ),
    ]);

    expect(groups, hasLength(2));
    // Version groups are ordered by each group's latest artifact. 1.0.0's
    // newest upload (+10m) is more recent than 2.0.0's only upload (+5m),
    // so 1.0.0 sorts first.
    expect(groups.first.version, '1.0.0');
    expect(groups.first.topArtifact.id, 'v1-second');
    expect(groups.last.version, '2.0.0');
    expect(groups.last.topArtifact.id, 'v2-first');
    // Within a version, the most recent upload comes first.
    expect(groups.first.artifacts.map((artifact) => artifact.id), [
      'v1-second',
      'v1-first',
    ]);
  });

  test('detects APK as installable and AAB as metadata-only', () {
    final apk = ArtifactInfo(
      id: 'apk',
      url: 'https://example.com/app-release.apk',
      platform: 'android',
      size: 100,
      tags: {'version': '1.0.0', 'build_type': 'release'},
      createdAt: DateTime.parse('2026-05-05T12:00:00Z'),
    );
    final aab = ArtifactInfo(
      id: 'aab',
      url: 'https://example.com/app-release.aab',
      platform: 'android',
      size: 100,
      tags: {'version': '1.0.0', 'build_type': 'appbundle'},
      createdAt: DateTime.parse('2026-05-05T12:01:00Z'),
    );

    expect(apk.packageType, 'apk');
    expect(apk.isInstallableAndroidApk, isTrue);
    expect(aab.packageType, 'aab');
    expect(aab.isInstallableAndroidApk, isFalse);
  });
}
