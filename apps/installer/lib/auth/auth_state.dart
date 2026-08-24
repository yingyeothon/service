import 'package:flutter/foundation.dart';
import 'auth_config.dart';
import 'github_auth.dart';

class AuthState extends ChangeNotifier {
  final GitHubAuthService _authService = GitHubAuthService();

  String? _token;
  String? _username;
  String? _serverBaseUrl;
  bool _isLoggedIn = false;

  String? get token => _token;
  String? get username => _username;
  String? get serverBaseUrl => _serverBaseUrl;
  bool get isLoggedIn => _isLoggedIn;
  bool get hasServerConfigured =>
      _serverBaseUrl != null && _serverBaseUrl!.isNotEmpty;

  AuthState() {
    _loadSavedState();
  }

  Future<void> _loadSavedState() async {
    final savedServer = await _authService.getServerBaseUrl();
    if (savedServer != null && savedServer.isNotEmpty) {
      try {
        _serverBaseUrl = AuthConfig.setServerUrl(savedServer);
      } on FormatException {
        _serverBaseUrl = null;
        await _authService.clearServerBaseUrl();
        AuthConfig.clearServerUrl();
      }
    } else {
      _serverBaseUrl = null;
      AuthConfig.clearServerUrl();
    }

    _token = await _authService.getToken();
    _username = await _authService.getUsername();
    _isLoggedIn = _token != null && _token!.isNotEmpty;
    notifyListeners();
  }

  Future<void> setServerBaseUrl(String input) async {
    final normalized = AuthConfig.setServerUrl(input);
    _serverBaseUrl = normalized;
    await _authService.saveServerBaseUrl(normalized);
    notifyListeners();
  }

  Future<DeviceCodeInfo> requestDeviceCode() {
    if (!hasServerConfigured) {
      throw StateError('서버 주소를 먼저 설정해주세요.');
    }
    return _authService.requestDeviceCode();
  }

  Future<DeviceTokenPollResult> pollDeviceToken(
    DeviceCodeInfo info, {
    int? interval,
    int? attempt,
  }) {
    return _authService.pollDeviceToken(
      deviceCode: info.deviceCode,
      interval: interval ?? info.interval,
      attempt: attempt,
    );
  }

  Future<void> completeLogin(DeviceTokenInfo session) async {
    await _authService.saveSession(session);
    _token = session.token;
    _username = session.username;
    _isLoggedIn = true;
    notifyListeners();
  }

  Future<void> loginWithApiKey(String apiKey) async {
    if (!hasServerConfigured) {
      throw StateError('서버 주소를 먼저 설정해주세요.');
    }
    await _authService.validateApiKey(apiKey);
    await completeLogin(DeviceTokenInfo(token: apiKey));
  }

  Future<void> logout() async {
    await _authService.logout();
    _token = null;
    _username = null;
    _serverBaseUrl = null;
    _isLoggedIn = false;
    AuthConfig.clearServerUrl();
    notifyListeners();
  }

  @override
  void dispose() {
    _authService.dispose();
    super.dispose();
  }
}
