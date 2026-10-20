import 'package:flutter/foundation.dart';

/// The Firebase app this build receives push through, from compile-time
/// defines (`--dart-define-from-file=<gitignored json>`, see the README).
/// The repo carries no `google-services.json`, no `GoogleService-Info.plist`
/// and no Google Services Gradle plugin: a build without the defines — CI, a
/// contributor, a test — simply has push switched off. Android and iOS are
/// two apps of the same Firebase project, each with its own app id and API
/// key; [forPlatform] picks one.
class PushConfig {
  const PushConfig({
    required this.projectId,
    required this.senderId,
    required this.appId,
    required this.apiKey,
    this.iosAppId = '',
    this.iosApiKey = '',
  });

  /// The iOS app's bundle id in the Firebase project (the Android
  /// applicationId is the same string).
  static const iosBundleId = 'life.yyt.console';

  /// What this binary was built with; every field is empty without the file.
  static const fromBuild = PushConfig(
    projectId: String.fromEnvironment('FIREBASE_PROJECT_ID'),
    senderId: String.fromEnvironment('FIREBASE_SENDER_ID'),
    appId: String.fromEnvironment('FIREBASE_APP_ID'),
    apiKey: String.fromEnvironment('FIREBASE_API_KEY'),
    iosAppId: String.fromEnvironment('FIREBASE_IOS_APP_ID'),
    iosApiKey: String.fromEnvironment('FIREBASE_IOS_API_KEY'),
  );

  final String projectId;
  final String senderId;

  /// The Android app's.
  final String appId;
  final String apiKey;

  /// The iOS app's (`GOOGLE_APP_ID` and `API_KEY` of its plist).
  final String iosAppId;
  final String iosApiKey;

  /// The config of the app registered for [platform]: the shared project
  /// fields with that platform's app id and API key. `null` on a platform
  /// without a Firebase app (push is off there).
  PushConfig? forPlatform(TargetPlatform platform) => switch (platform) {
    TargetPlatform.android => PushConfig(
      projectId: projectId,
      senderId: senderId,
      appId: appId,
      apiKey: apiKey,
    ),
    TargetPlatform.iOS => PushConfig(
      projectId: projectId,
      senderId: senderId,
      appId: iosAppId,
      apiKey: iosApiKey,
    ),
    _ => null,
  };

  /// Whether this device's platform has a complete config (what decides
  /// whether push is on in this build).
  bool get isCompleteOnThisDevice =>
      !kIsWeb && (forPlatform(defaultTargetPlatform)?.isComplete ?? false);

  /// All four or nothing: a partial config cannot initialise Firebase. On a
  /// [forPlatform] result this is the platform's own answer.
  bool get isComplete =>
      projectId.isNotEmpty &&
      senderId.isNotEmpty &&
      appId.isNotEmpty &&
      apiKey.isNotEmpty;
}
