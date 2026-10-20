import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/download_install_launch.dart';
import 'package:yyt_console/external_launcher.dart';
import 'package:yyt_console/ios_install_ledger.dart';

const _install =
    'itms-services://?action=download-manifest&url=https%3A%2F%2Fcdn.example%2Fm.plist';

ArtifactInfo _ipa({bool links = true}) => ArtifactInfo.fromJson({
  'id': 'a1',
  'url': 'https://cdn.example/app.ipa',
  'platform': 'ios',
  'tags': {
    'version': '1.3.0',
    'bundle_id': 'life.yyt.game',
    'build_number': '9',
  },
  'createdAt': 1,
  if (links)
    'ios': {
      'manifestUrl': 'https://cdn.example/m.plist',
      'installUrl': _install,
    },
});

void main() {
  late IosInstallLedger ledger;
  late List<Uri> launched;

  setUp(() {
    ledger = IosInstallLedger(storage: MemoryLedgerStorage());
    launched = [];
  });

  Future<InstallAttemptResult> install(
    ArtifactInfo artifact, {
    required ExternalLauncher launcher,
    bool self = false,
  }) => installArtifact(
    artifactUrl: artifact.url,
    packageName: 'life.yyt.game',
    targetVersion: artifact.version,
    onProgress: (_) => fail('the iOS branch reports no download progress'),
    beginInstallerReturnWatch: () => fail('no installer to return from'),
    findInstalledVersionFn: (_) => fail('nothing is verified on iOS'),
    isSelfUpdatePackageFn: (_) async => self,
    markPendingSelfUpdateFn: (_) => fail('no pending self-update on iOS'),
    artifact: artifact,
    topic: 'yyt.catalog.dev.ca_1',
    iosDevice: true,
    launcher: launcher,
    ledger: ledger,
  );

  test('opens the OTA link instead of downloading, and records the '
      'request', () async {
    final result = await install(
      _ipa(),
      launcher: (uri) async {
        launched.add(uri);
        return true;
      },
    );
    expect(launched, [Uri.parse(_install)]);
    expect(result.success, isTrue);
    expect(result.downloadedPath, isNull);
    expect(result.needsDowngradeFallback, isFalse);
    expect(result.message, iosInstallRequestedMessage);
    final entry = (await ledger.lookup('life.yyt.game'))!;
    expect(entry.version, '1.3.0');
    expect(entry.build, '9');
    expect(entry.topic, 'yyt.catalog.dev.ca_1');
  });

  test('a link nothing opened, or a launcher that throws, fails without a '
      'record', () async {
    for (final ExternalLauncher launcher in [
      (_) async => false,
      (_) async => throw Exception('no handler'),
    ]) {
      final result = await install(_ipa(), launcher: launcher);
      expect(result.success, isFalse);
      expect(result.message, '설치 화면을 열 수 없습니다.');
      expect(await ledger.lookup('life.yyt.game'), isNull);
    }
  });

  test('an iOS build without a link is not launched', () async {
    final result = await install(
      _ipa(links: false),
      launcher: (uri) async {
        launched.add(uri);
        return true;
      },
    );
    expect(result.success, isFalse);
    expect(launched, isEmpty);
  });

  test('the app updating itself is not recorded', () async {
    final result = await install(
      _ipa(),
      launcher: (_) async => true,
      self: true,
    );
    expect(result.success, isTrue);
    expect(await ledger.readAll(), isEmpty);
  });

  test('openAppByScheme launches <scheme>:// and turns errors into '
      'false', () async {
    expect(
      await openAppByScheme(
        'yytgame',
        launcher: (uri) async {
          launched.add(uri);
          return true;
        },
      ),
      isTrue,
    );
    expect(launched.single.toString(), 'yytgame://');
    expect(
      await openAppByScheme('yytgame', launcher: (_) async => throw 'x'),
      isFalse,
    );
  });
}
