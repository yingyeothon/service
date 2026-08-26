import 'package:flutter/services.dart';

class DeviceApps {
  static const _channel = MethodChannel('life.yyt.console/appcheck');

  /// 앱이 설치되어 있는지 확인
  static Future<bool> isAppInstalled(String packageName) async {
    try {
      final result = await _channel.invokeMethod<bool>('isAppInstalled', {
        'packageName': packageName,
      });
      return result ?? false;
    } on PlatformException {
      return false;
    }
  }

  /// 설치된 앱의 버전 이름을 가져옴 (e.g., "1.0.2+3")
  static Future<String?> getVersionName(String packageName) async {
    try {
      final result = await _channel.invokeMethod<String>('getAppVersion', {
        'packageName': packageName,
      });
      return result;
    } on PlatformException {
      return null;
    }
  }

  /// 앱 실행
  static Future<bool> launchApp(String packageName) async {
    try {
      await _channel.invokeMethod('launchApp', {'packageName': packageName});
      return true;
    } on PlatformException {
      return false;
    }
  }

  /// 앱 삭제 요청 (시스템 삭제 UI 실행)
  static Future<bool> uninstallApp(String packageName) async {
    try {
      final result = await _channel.invokeMethod<bool>('uninstallApp', {
        'packageName': packageName,
      });
      return result ?? false;
    } on PlatformException {
      return false;
    }
  }
}
