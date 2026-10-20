import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// One install the app asked iOS for.
class IosLedgerEntry {
  const IosLedgerEntry({
    required this.version,
    required this.build,
    required this.at,
    this.topic,
  });

  final String version;
  final String build;

  /// The app's update-notice topic, kept for the iOS push sync (todo/74).
  final String? topic;
  final DateTime at;

  /// The version compared with the catalog's: the `version` tag, with the
  /// build number appended when the tag carries none.
  String get comparableVersion =>
      version.contains('+') || build.isEmpty ? version : '$version+$build';

  Map<String, dynamic> toJson() => {
    'version': version,
    'build': build,
    if (topic != null) 'topic': topic,
    'at': at.millisecondsSinceEpoch,
  };

  static IosLedgerEntry? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final version = json['version'];
    final at = json['at'];
    if (version is! String || at is! num) return null;
    final build = json['build'];
    final topic = json['topic'];
    return IosLedgerEntry(
      version: version,
      build: build is String ? build : '',
      topic: topic is String ? topic : null,
      at: DateTime.fromMillisecondsSinceEpoch(at.toInt(), isUtc: true),
    );
  }
}

/// Raw key-value access, injectable for tests.
abstract class LedgerStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
}

class SecureLedgerStorage implements LedgerStorage {
  const SecureLedgerStorage();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);
}

class MemoryLedgerStorage implements LedgerStorage {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }
}

/// What this device asked iOS to install, by bundle id
/// (docs/decisions.md *Console app and push on iOS* #4). iOS lets no app
/// list another app's installs, so this stands in for the Android package
/// probe: a recorded install reads as "requested", never as verified.
class IosInstallLedger {
  IosInstallLedger({
    this.storage = const SecureLedgerStorage(),
    this.cap = 200,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  static const storageKey = 'ios_install_ledger';

  /// The ledger the app reads; tests replace it.
  static IosInstallLedger instance = IosInstallLedger();

  final LedgerStorage storage;

  /// Entries kept; the oldest `at` goes first.
  final int cap;
  final DateTime Function() _now;

  /// Read-modify-writes run one at a time: two installs finishing together
  /// must not drop each other's entry.
  Future<void> _tail = Future<void>.value();

  Future<T> _serial<T>(Future<T> Function() op) {
    final result = _tail.then((_) => op());
    _tail = result.then<void>((_) {}, onError: (_) {});
    return result;
  }

  /// Every entry; a storage error reads as empty (the list just shows
  /// nothing recorded).
  Future<Map<String, IosLedgerEntry>> readAll() async {
    try {
      return await _read();
    } catch (_) {
      return {};
    }
  }

  /// Storage errors propagate, so a writer never replaces a ledger it could
  /// not read; only an unparseable value reads as empty.
  Future<Map<String, IosLedgerEntry>> _read() async {
    final raw = await storage.read(storageKey);
    if (raw == null) return {};
    final Object? parsed;
    try {
      parsed = jsonDecode(raw);
    } on FormatException {
      return {};
    }
    if (parsed is! Map<String, dynamic>) return {};
    return {
      for (final e in parsed.entries)
        if (IosLedgerEntry.fromJson(e.value) case final entry?) e.key: entry,
    };
  }

  Future<IosLedgerEntry?> lookup(String bundleId) async =>
      (await readAll())[bundleId];

  Future<void> record(
    String bundleId, {
    required String version,
    String build = '',
    String? topic,
  }) async {
    if (bundleId.isEmpty) return;
    await _serial(() async {
      final all = await _read();
      all[bundleId] = IosLedgerEntry(
        version: version,
        build: build,
        topic: topic,
        at: _now().toUtc(),
      );
      while (all.length > cap) {
        final oldest = all.entries.reduce(
          (a, b) => b.value.at.isBefore(a.value.at) ? b : a,
        );
        all.remove(oldest.key);
      }
      await _write(all);
    });
  }

  Future<void> remove(String bundleId) => _serial(() async {
    final all = await _read();
    if (all.remove(bundleId) == null) return;
    await _write(all);
  });

  Future<void> _write(Map<String, IosLedgerEntry> all) => storage.write(
    storageKey,
    jsonEncode({for (final e in all.entries) e.key: e.value.toJson()}),
  );
}
