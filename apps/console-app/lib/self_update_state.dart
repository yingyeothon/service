import 'package:yyt_console/check_if_need_to_update.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:package_info_plus/package_info_plus.dart';

const _pendingSelfUpdateVersionKey = 'pending_self_update_version';

abstract class SelfUpdateStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SecureSelfUpdateStorage implements SelfUpdateStorage {
  const SecureSelfUpdateStorage();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  @override
  Future<String?> read(String key) {
    return _storage.read(key: key);
  }

  @override
  Future<void> write(String key, String value) {
    return _storage.write(key: key, value: value);
  }

  @override
  Future<void> delete(String key) {
    return _storage.delete(key: key);
  }
}

class SelfUpdateResult {
  const SelfUpdateResult({
    required this.targetVersion,
    required this.installedVersion,
  });

  final String targetVersion;
  final String installedVersion;
}

Future<String> getCurrentPackageName({
  Future<PackageInfo> Function()? packageInfoLoader,
}) async {
  final info = await _loadPackageInfo(packageInfoLoader);
  return info.packageName.trim();
}

Future<String> getCurrentAppVersion({
  Future<PackageInfo> Function()? packageInfoLoader,
}) async {
  final info = await _loadPackageInfo(packageInfoLoader);
  final version = info.version.trim();
  final buildNumber = info.buildNumber.trim();
  if (buildNumber.isEmpty) {
    return version;
  }
  return '$version+$buildNumber';
}

Future<bool> isSelfUpdatePackage(
  String packageName, {
  Future<PackageInfo> Function()? packageInfoLoader,
}) async {
  final currentPackageName = await getCurrentPackageName(
    packageInfoLoader: packageInfoLoader,
  );
  return currentPackageName == packageName.trim();
}

Future<void> markPendingSelfUpdate(
  String targetVersion, {
  SelfUpdateStorage storage = const SecureSelfUpdateStorage(),
}) async {
  await storage.write(_pendingSelfUpdateVersionKey, targetVersion.trim());
}

Future<SelfUpdateResult?> consumePendingSelfUpdate({
  SelfUpdateStorage storage = const SecureSelfUpdateStorage(),
  Future<PackageInfo> Function()? packageInfoLoader,
}) async {
  final targetVersion = await storage.read(_pendingSelfUpdateVersionKey);
  if (targetVersion == null || targetVersion.trim().isEmpty) {
    return null;
  }

  final installedVersion = await getCurrentAppVersion(
    packageInfoLoader: packageInfoLoader,
  );
  await storage.delete(_pendingSelfUpdateVersionKey);

  if (!isSameVersion(targetVersion, installedVersion)) {
    return null;
  }

  return SelfUpdateResult(
    targetVersion: targetVersion,
    installedVersion: installedVersion,
  );
}

Future<PackageInfo> _loadPackageInfo(
  Future<PackageInfo> Function()? packageInfoLoader,
) {
  if (packageInfoLoader != null) {
    return packageInfoLoader();
  }
  return PackageInfo.fromPlatform();
}
