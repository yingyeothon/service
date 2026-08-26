import 'package:yyt_console/self_update_state.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

void main() {
  test('getCurrentAppVersion combines version and build number', () async {
    final version = await getCurrentAppVersion(
      packageInfoLoader:
          () async => PackageInfo(
            appName: 'Catalog',
            packageName: 'life.yyt.console',
            version: '1.0.2',
            buildNumber: '5',
          ),
    );

    expect(version, '1.0.2+5');
  });

  test('consumePendingSelfUpdate returns result when target matches', () async {
    final storage = _MemorySelfUpdateStorage();
    await storage.write('pending_self_update_version', '1.0.2+5');

    final result = await consumePendingSelfUpdate(
      storage: storage,
      packageInfoLoader:
          () async => PackageInfo(
            appName: 'Catalog',
            packageName: 'life.yyt.console',
            version: '1.0.2',
            buildNumber: '5',
          ),
    );

    expect(result, isNotNull);
    expect(result?.installedVersion, '1.0.2+5');
    expect(await storage.read('pending_self_update_version'), isNull);
  });

  test('consumePendingSelfUpdate clears stale marker on mismatch', () async {
    final storage = _MemorySelfUpdateStorage();
    await storage.write('pending_self_update_version', '1.0.2+5');

    final result = await consumePendingSelfUpdate(
      storage: storage,
      packageInfoLoader:
          () async => PackageInfo(
            appName: 'Catalog',
            packageName: 'life.yyt.console',
            version: '1.0.2',
            buildNumber: '4',
          ),
    );

    expect(result, isNull);
    expect(await storage.read('pending_self_update_version'), isNull);
  });
}

class _MemorySelfUpdateStorage implements SelfUpdateStorage {
  final Map<String, String> _values = {};

  @override
  Future<void> delete(String key) async {
    _values.remove(key);
  }

  @override
  Future<String?> read(String key) async {
    return _values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    _values[key] = value;
  }
}
