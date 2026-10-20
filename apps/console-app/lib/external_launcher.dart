import 'package:url_launcher/url_launcher.dart';

/// Opens a URL outside the app; `false` when nothing handled it.
typedef ExternalLauncher = Future<bool> Function(Uri uri);

Future<bool> launchExternal(Uri uri) =>
    launchUrl(uri, mode: LaunchMode.externalApplication);

/// Shown when `<scheme>://` opened nothing.
const openAppFailedMessage = '앱을 열 수 없습니다(설치되지 않았거나 scheme 이 다름)';

/// Opens the iOS app that answers to [scheme] (the artifact's `url_scheme`
/// tag); `false` when it is not installed or answers to another scheme.
Future<bool> openAppByScheme(
  String scheme, {
  ExternalLauncher launcher = launchExternal,
}) async {
  try {
    return await launcher(Uri.parse('$scheme://'));
  } catch (_) {
    return false;
  }
}
