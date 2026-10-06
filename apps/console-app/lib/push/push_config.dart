/// The Firebase app this build receives push through, from compile-time
/// defines (`--dart-define-from-file=<gitignored json>`, see the README).
/// The repo carries no `google-services.json` and no Google Services Gradle
/// plugin: a build without the defines — CI, a contributor, a test — simply
/// has push switched off.
class PushConfig {
  const PushConfig({
    required this.projectId,
    required this.senderId,
    required this.appId,
    required this.apiKey,
  });

  /// What this binary was built with; every field is empty without the file.
  static const fromBuild = PushConfig(
    projectId: String.fromEnvironment('FIREBASE_PROJECT_ID'),
    senderId: String.fromEnvironment('FIREBASE_SENDER_ID'),
    appId: String.fromEnvironment('FIREBASE_APP_ID'),
    apiKey: String.fromEnvironment('FIREBASE_API_KEY'),
  );

  final String projectId;
  final String senderId;
  final String appId;
  final String apiKey;

  /// All four or nothing: a partial config cannot initialise Firebase.
  bool get isComplete =>
      projectId.isNotEmpty &&
      senderId.isNotEmpty &&
      appId.isNotEmpty &&
      apiKey.isNotEmpty;
}
