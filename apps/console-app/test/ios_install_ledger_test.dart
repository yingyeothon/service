import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/check_if_need_to_update.dart';
import 'package:yyt_console/find_installed_version.dart';
import 'package:yyt_console/ios_install_ledger.dart';

void main() {
  late MemoryLedgerStorage storage;
  late DateTime clock;
  late IosInstallLedger ledger;

  setUp(() {
    storage = MemoryLedgerStorage();
    clock = DateTime.utc(2026, 10, 20);
    ledger = IosInstallLedger(storage: storage, now: () => clock, cap: 3);
  });

  test('records, looks up and compares with the catalog version', () async {
    await ledger.record(
      'life.yyt.game',
      version: '1.2.0',
      build: '7',
      topic: 'yyt.catalog.dev.ca_1',
    );
    final entry = (await ledger.lookup('life.yyt.game'))!;
    expect(entry.version, '1.2.0');
    expect(entry.build, '7');
    expect(entry.topic, 'yyt.catalog.dev.ca_1');
    expect(entry.comparableVersion, '1.2.0+7');
    expect(checkIfNeedToUpdate('1.2.0+8', entry.comparableVersion), isTrue);
    expect(checkIfNeedToUpdate('1.2.0+7', entry.comparableVersion), isFalse);
    // A version tag that already carries the build is kept as it is.
    await ledger.record('b', version: '2.0.0+3', build: '3');
    expect((await ledger.lookup('b'))!.comparableVersion, '2.0.0+3');
    // The stored shape: {bundleId: {version, build, topic, at}}.
    final raw =
        jsonDecode(storage.values[IosInstallLedger.storageKey]!)
            as Map<String, dynamic>;
    expect(raw['life.yyt.game'], {
      'version': '1.2.0',
      'build': '7',
      'topic': 'yyt.catalog.dev.ca_1',
      'at': clock.millisecondsSinceEpoch,
    });
  });

  test('keeps at most cap entries, evicting the oldest request', () async {
    for (final id in ['a', 'b', 'c']) {
      await ledger.record(id, version: '1.0.0');
      clock = clock.add(const Duration(minutes: 1));
    }
    // Re-recording `a` makes it the newest; `b` is now the oldest.
    await ledger.record('a', version: '1.0.1');
    clock = clock.add(const Duration(minutes: 1));
    await ledger.record('d', version: '1.0.0');
    expect((await ledger.readAll()).keys.toSet(), {'a', 'c', 'd'});
  });

  test('remove forgets one app; a corrupt value reads as empty', () async {
    await ledger.record('a', version: '1.0.0');
    await ledger.record('b', version: '1.0.0');
    await ledger.remove('a');
    expect(await ledger.lookup('a'), isNull);
    expect(await ledger.lookup('b'), isNotNull);
    storage.values[IosInstallLedger.storageKey] = 'not json';
    expect(await ledger.readAll(), isEmpty);
  });

  test('findInstalledVersion reads the ledger on iOS', () async {
    final previous = IosInstallLedger.instance;
    addTearDown(() {
      IosInstallLedger.instance = previous;
      debugDefaultTargetPlatformOverride = null;
    });
    IosInstallLedger.instance = ledger;
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(await findInstalledVersion('life.yyt.game'), isNull);
    await ledger.record('life.yyt.game', version: '1.0.0', build: '2');
    expect(await findInstalledVersion('life.yyt.game'), '1.0.0+2');
  });

  test('a storage read error aborts record and remove instead of '
      'overwriting the ledger', () async {
    final failing = _FlakyStorage();
    final l = IosInstallLedger(storage: failing);
    failing.values[IosInstallLedger.storageKey] = jsonEncode({
      'kept': {'version': '1.0.0', 'build': '', 'at': 1},
    });
    failing.failReads = true;
    await expectLater(l.record('new', version: '1.0.0'), throwsException);
    await expectLater(l.remove('kept'), throwsException);
    expect(failing.writes, 0);
    // The list just reads nothing; a later record still works.
    expect(await l.readAll(), isEmpty);
    failing.failReads = false;
    await l.record('new', version: '1.0.0');
    expect((await l.readAll()).keys.toSet(), {'kept', 'new'});
  });

  test('concurrent records do not drop each other', () async {
    final slow = _FlakyStorage()..readDelay = const Duration(milliseconds: 5);
    final l = IosInstallLedger(storage: slow);
    await Future.wait([
      for (final id in ['a', 'b', 'c']) l.record(id, version: '1.0.0'),
    ]);
    expect((await l.readAll()).keys.toSet(), {'a', 'b', 'c'});
  });
}

class _FlakyStorage implements LedgerStorage {
  final values = <String, String>{};
  bool failReads = false;
  Duration readDelay = Duration.zero;
  int writes = 0;

  @override
  Future<String?> read(String key) async {
    await Future<void>.delayed(readDelay);
    if (failReads) throw Exception('keychain locked');
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    writes++;
    values[key] = value;
  }
}
