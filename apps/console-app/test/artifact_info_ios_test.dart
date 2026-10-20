import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/app_info.dart';
import 'package:yyt_console/app_install_state.dart';
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/load_app_info.dart';
import 'package:yyt_console/artifact_version_group.dart';
import 'package:yyt_console/remote_app.dart';

const _install =
    'itms-services://?action=download-manifest&url=https%3A%2F%2Fcdn.example%2Fm.plist';

ArtifactInfo artifact(
  String platform, {
  String url = 'https://cdn.example/a.bin',
  Map<String, String> tags = const {},
  bool links = false,
  String version = '1.0.0',
}) => ArtifactInfo.fromJson({
  'id': 'a_$platform',
  'url': url,
  'platform': platform,
  'tags': {'version': version, ...tags},
  'createdAt': 1,
  if (links)
    'ios': {
      'manifestUrl': 'https://cdn.example/m.plist',
      'installUrl': _install,
    },
});

void main() {
  test('parses the iOS links and tags, and serializes them back', () {
    final a = artifact(
      'ios',
      url: 'https://cdn.example/app.ipa',
      links: true,
      tags: {
        'bundle_id': 'life.yyt.game',
        'build_number': '42',
        'url_scheme': 'yytgame',
      },
    );
    expect(a.ios!.installUrl, _install);
    expect(a.ios!.manifestUrl, 'https://cdn.example/m.plist');
    expect(a.bundleId, 'life.yyt.game');
    expect(a.buildNumber, '42');
    expect(a.urlScheme, 'yytgame');
    expect(a.installId, 'life.yyt.game');
    expect(ArtifactInfo.fromJson(a.toJson()).ios!.installUrl, _install);
    // `ios: null` (an older console, a non-iOS row) reads as none.
    expect(ArtifactInfo.fromJson({...a.toJson(), 'ios': null}).ios, isNull);
  });

  test('isInstallableOn: an APK on Android, a linked iOS build on iOS', () {
    final apk = artifact('android', url: 'https://cdn.example/a.apk');
    final aab = artifact('android', url: 'https://cdn.example/a.aab');
    final ipa = artifact('ios', links: true);
    final ipaNoLink = artifact('ios');
    final bin = artifact('bin');
    final server = artifact('server');
    final desktop = artifact('windows', url: 'https://cdn.example/a.zip');
    final table = <ArtifactInfo, (bool, bool)>{
      // (android, ios)
      apk: (true, false),
      aab: (false, false),
      ipa: (false, true),
      ipaNoLink: (false, false),
      bin: (false, false),
      server: (false, false),
      desktop: (false, false),
    };
    for (final MapEntry(key: a, value: (onAndroid, onIos)) in table.entries) {
      expect(
        a.isInstallableOn(TargetPlatform.android),
        onAndroid,
        reason: a.id,
      );
      expect(a.isInstallableOn(TargetPlatform.iOS), onIos, reason: a.id);
    }
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(ipa.isInstallableOnThisDevice, isTrue);
    expect(apk.isInstallableOnThisDevice, isFalse);
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(ipa.isInstallableOnThisDevice, isFalse);
    expect(apk.isInstallableOnThisDevice, isTrue);
  });

  test('iOS offers only the newest version; Android every version', () {
    final old = artifact('ios', links: true, version: '1.0.0');
    final latest = artifact('ios', links: true, version: '1.1.0');
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(canInstallArtifact(latest, '1.1.0'), isTrue);
    expect(canInstallArtifact(old, '1.1.0'), isFalse);
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final oldApk = artifact(
      'android',
      url: 'https://cdn.example/a.apk',
      version: '1.0.0',
    );
    expect(canInstallArtifact(oldApk, '1.1.0'), isTrue);
  });

  test('an iOS app probes its bundle ids; an Android app its application '
      'ids', () {
    final ios = RemoteApp(
      id: 'ca_1',
      name: 'game',
      package: 'game',
      description: '',
      latestArtifact: artifact(
        'ios',
        links: true,
        tags: {'bundle_id': 'life.yyt.game'},
      ),
      applicationIds: ['life.yyt.game.android'],
      bundleIds: ['life.yyt.game', 'life.yyt.game.beta'],
    );
    expect(ios.applicationId, 'life.yyt.game');
    expect(ios.installCheckApplicationIds, [
      'life.yyt.game',
      'life.yyt.game.beta',
    ]);
    // No bundle_id tag: the package, then the server's bundle ids.
    final untagged = RemoteApp(
      id: 'ca_1',
      name: 'game',
      package: 'game',
      description: '',
      latestArtifact: artifact('ios', links: true),
      bundleIds: ['life.yyt.game'],
    );
    expect(untagged.installCheckApplicationIds, ['game', 'life.yyt.game']);
    final android = RemoteApp(
      id: 'ca_2',
      name: 'g',
      package: 'g',
      description: '',
      latestArtifact: artifact('android', tags: {'application_id': 'p.g'}),
      applicationIds: ['p.g', 'p.g.debug'],
      bundleIds: ['life.yyt.g'],
    );
    expect(android.installCheckApplicationIds, ['p.g', 'p.g.debug']);
  });

  test('iOS compares version plus build number', () async {
    final b7 = artifact(
      'ios',
      links: true,
      version: '1.2.0',
      tags: {'bundle_id': 'life.yyt.g', 'build_number': '7'},
    );
    expect(b7.comparableVersion, '1.2.0+7');
    // A version tag with its build, and Android, are left alone.
    expect(
      artifact(
        'ios',
        version: '1.2.0+7',
        tags: {'build_number': '7'},
      ).comparableVersion,
      '1.2.0+7',
    );
    expect(
      artifact(
        'android',
        version: '1.2.0',
        tags: {'build_number': '7'},
      ).comparableVersion,
      '1.2.0',
    );

    final app = RemoteApp(
      id: 'ca_1',
      name: 'g',
      package: 'g',
      description: '',
      latestArtifact: b7,
    );
    expect(app.version, '1.2.0+7');
    Future<AppInfo> load(String? recorded) async => (await loadAppInfo(
      ({String? token}) async => [app],
      (_) async => recorded,
    )).single;
    expect((await load('1.2.0+6')).needsUpdate, isTrue);
    expect((await load('1.2.0+7')).needsUpdate, isFalse);
    expect(resolveAppInstallState(app.version, '1.2.0+6'), AppInstallState.old);

    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    final b6 = artifact(
      'ios',
      links: true,
      version: '1.2.0',
      tags: {'build_number': '6'},
    );
    expect(canInstallArtifact(b6, b7.comparableVersion), isFalse);
    expect(canInstallArtifact(b7, b7.comparableVersion), isTrue);
  });

  test('the latest version on a device comes from what installs there', () {
    ArtifactInfo at(String platform, String version, int createdAt) =>
        ArtifactInfo.fromJson({
          'id': '$platform-$version',
          'url': platform == 'android'
              ? 'https://cdn.example/a.apk'
              : 'https://cdn.example/a.bin',
          'platform': platform,
          'tags': {'version': version},
          'createdAt': createdAt,
          if (platform == 'ios')
            'ios': {
              'manifestUrl': 'https://cdn.example/m.plist',
              'installUrl': _install,
            },
        });
    // The `all` filter: the newest build overall is another platform's.
    final mixed = [
      at('ios', '1.2.0', 1),
      at('android', '1.3.0', 2),
      at('windows', '1.4.0', 3),
    ];
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    final onIos = latestInstallableArtifact(mixed)!;
    expect(onIos.id, 'ios-1.2.0');
    expect(canInstallArtifact(mixed.first, onIos.comparableVersion), isTrue);
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final onAndroid = latestInstallableArtifact(mixed)!;
    expect(onAndroid.id, 'android-1.3.0');
    // Installed 1.3.0 is current, not behind the desktop build.
    expect(
      resolveAppInstallState(onAndroid.comparableVersion, '1.3.0'),
      AppInstallState.latest,
    );
    expect(latestInstallableArtifact([at('windows', '1.0.0', 1)]), isNull);
  });
}
