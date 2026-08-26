import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/load_app_info.dart';
import 'package:yyt_console/remote_app.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('checks installed version using artifact application id', () async {
    final requestedPackages = <String>[];

    final apps = await loadAppInfo(
      ({String? token}) async => [
        RemoteApp(
          id: 'ca_demo',
          name: 'Demo',
          package: 'catalog-demo-record',
          description: 'Demo app',
          latestArtifact: ArtifactInfo(
            id: 'artifact-1',
            url: 'https://example.com/demo.apk',
            platform: 'android',
            size: 1,
            tags: const {
              'version': '1.2.3',
              'application_id': 'com.example.demo',
            },
            createdAt: DateTime.utc(2026),
          ),
        ),
      ],
      (packageName) async {
        requestedPackages.add(packageName);
        return packageName == 'com.example.demo' ? '1.2.3' : null;
      },
    );

    expect(requestedPackages, ['com.example.demo']);
    expect(apps.single.installedVersion, '1.2.3');
    expect(apps.single.needsUpdate, isFalse);
  });

  test(
    'detects an installed debug variant when latest artifact is release',
    () async {
      final requestedPackages = <String>[];

      final apps = await loadAppInfo(
        ({String? token}) async => [
          RemoteApp(
            id: 'ca_demo',
            name: 'Demo',
            package: 'com.example.demo',
            description: 'Demo app',
            latestArtifact: ArtifactInfo(
              id: 'release-1',
              url: 'https://example.com/demo-release.apk',
              platform: 'android',
              size: 1,
              tags: const {
                'version': '1.2.3',
                'build_type': 'release',
                'application_id': 'com.example.demo',
              },
              createdAt: DateTime.utc(2026, 1, 2),
            ),
            applicationIds: const [
              'com.example.demo',
              'com.example.demo.debug',
            ],
          ),
        ],
        (packageName) async {
          requestedPackages.add(packageName);
          // Only the .debug build is installed on the device.
          return packageName == 'com.example.demo.debug' ? '1.2.3' : null;
        },
      );

      // Probes the latest artifact's id first, then the other build variant.
      expect(requestedPackages, ['com.example.demo', 'com.example.demo.debug']);
      expect(apps.single.installedVersion, '1.2.3');
      expect(apps.single.needsUpdate, isFalse);
    },
  );
}
