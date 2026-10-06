/// One received message, reduced to what the app reads.
class PushEvent {
  const PushEvent({required this.data, this.from, this.title, this.body});

  /// `/topics/<name>` for a topic message.
  final String? from;
  final Map<String, Object?> data;
  final String? title;
  final String? body;
}

/// What [PushService] needs from a push transport. The one implementation is
/// Firebase (`firebase_push_messaging.dart`); tests pass a fake, so nothing
/// above this interface imports Firebase.
abstract class PushMessaging {
  Future<void> subscribe(String topic);
  Future<void> unsubscribe(String topic);

  /// Shows the system prompt where the platform has one (Android 13+);
  /// whether notifications may be shown afterwards.
  Future<bool> requestPermission();

  /// Messages received while the app is in the foreground (the system shows
  /// nothing for these).
  Stream<PushEvent> get onForeground;

  /// A notification tapped while the app was in the background.
  Stream<PushEvent> get onOpened;

  /// Fires when the installation gets a new FCM token (a reset or restored
  /// installation); the token itself is never handed out.
  Stream<void> get onTokenRefresh;

  /// The notification whose tap started the app, if one did.
  Future<PushEvent?> initialMessage();
}
