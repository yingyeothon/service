import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const _key = 'catalog_platform';

/// Which builds the app and browse lists show (docs/decisions.md *Console
/// app and push on iOS* #2). `all` sends no `platform` parameter: the server
/// then answers every platform.
enum CatalogPlatform {
  ios,
  android,
  all;

  /// The `platform` query value; `null` omits the parameter.
  String? get query => switch (this) {
    CatalogPlatform.ios => 'ios',
    CatalogPlatform.android => 'android',
    CatalogPlatform.all => null,
  };

  String get label => switch (this) {
    CatalogPlatform.ios => 'iOS',
    CatalogPlatform.android => 'Android',
    CatalogPlatform.all => '전체',
  };

  /// Whether an artifact of [artifactPlatform] belongs in this filter.
  bool matches(String artifactPlatform) =>
      this == CatalogPlatform.all || artifactPlatform.toLowerCase() == query;

  static CatalogPlatform? parse(String? raw) {
    for (final p in values) {
      if (p.name == raw) return p;
    }
    return null;
  }
}

/// Whether this device is an iPhone/iPad. Tests flip it with
/// `debugDefaultTargetPlatformOverride`.
bool isIosDevice() => defaultTargetPlatform == TargetPlatform.iOS;

/// The platform whose builds this device installs; the default filter.
CatalogPlatform deviceCatalogPlatform() =>
    isIosDevice() ? CatalogPlatform.ios : CatalogPlatform.android;

/// The filter as last chosen on this device.
abstract class CatalogPlatformStore {
  Future<CatalogPlatform?> read();
  Future<void> write(CatalogPlatform platform);
}

/// Backed by the secure storage the app already uses; a missing or unknown
/// value reads as `null` (the device default applies).
class SecureCatalogPlatformStore implements CatalogPlatformStore {
  const SecureCatalogPlatformStore();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  @override
  Future<CatalogPlatform?> read() async {
    try {
      return CatalogPlatform.parse(await _storage.read(key: _key));
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> write(CatalogPlatform platform) async {
    try {
      await _storage.write(key: _key, value: platform.name);
    } catch (_) {
      // Persistence is a convenience; the in-memory choice still applies.
    }
  }
}

/// In-memory store for tests.
class MemoryCatalogPlatformStore implements CatalogPlatformStore {
  MemoryCatalogPlatformStore([this.value]);

  CatalogPlatform? value;

  @override
  Future<CatalogPlatform?> read() async => value;

  @override
  Future<void> write(CatalogPlatform platform) async {
    value = platform;
  }
}
