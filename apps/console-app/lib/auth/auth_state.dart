import 'dart:math';

import 'package:flutter/foundation.dart';
import 'auth_config.dart';
import 'auth_service.dart';

/// Saved console profiles and the active one. Signed in means an active
/// profile exists; its server becomes [AuthConfig.apiBaseUrl].
class AuthState extends ChangeNotifier {
  final AuthService _authService = AuthService();

  List<Profile> _profiles = const [];
  Profile? _active;
  bool _loaded = false;

  List<Profile> get profiles => List.unmodifiable(_profiles);
  Profile? get activeProfile => _active;
  bool get loaded => _loaded;
  String? get token => _active?.apiKey;
  String? get username => _active?.login;
  String? get serverBaseUrl => _active?.server;
  bool get isLoggedIn => _active != null;

  AuthState() {
    _loadSavedState();
  }

  Future<void> _loadSavedState() async {
    final profiles = await _authService.loadProfiles();
    final activeId = await _authService.loadActiveProfileId();
    _profiles = profiles;
    await _activate(
      profiles.where((p) => p.id == activeId).firstOrNull ??
          profiles.firstOrNull,
      persist: false,
    );
    _loaded = true;
    notifyListeners();
  }

  Future<void> _activate(Profile? p, {bool persist = true}) async {
    _active = p;
    if (p == null) {
      AuthConfig.clearServerUrl();
    } else {
      AuthConfig.setServerUrl(p.server);
    }
    if (persist) await _authService.saveActiveProfileId(p?.id);
  }

  /// Validates the scanned key against [server] (without touching the active
  /// server), then saves and activates the profile. A profile for the same
  /// server and login is replaced: each QR mints a fresh token, so the old
  /// entry would only be a duplicate row (its token stays revocable in the
  /// console).
  Future<Profile> addProfile({
    required String server,
    required String apiKey,
  }) async {
    final normalized = AuthConfig.normalizeServerUrl(server);
    final login = await _authService.validateApiKey(
      apiKey,
      baseUrl: normalized,
    );
    final profile = Profile(
      id: 'p_${Random.secure().nextInt(1 << 32).toRadixString(16)}',
      server: normalized,
      apiKey: apiKey,
      login: login,
      addedAt: DateTime.now().toUtc(),
    );
    _profiles = [
      for (final p in _profiles)
        if (!(p.server == normalized && p.login == login)) p,
      profile,
    ];
    await _authService.saveProfiles(_profiles);
    await _activate(profile);
    notifyListeners();
    return profile;
  }

  Future<void> switchProfile(String id) async {
    final p = _profiles.where((p) => p.id == id).firstOrNull;
    if (p == null || p.id == _active?.id) return;
    await _activate(p);
    notifyListeners();
  }

  /// Removes a profile; if it was active the next saved one takes over (or
  /// the login screen returns).
  Future<void> removeProfile(String id) async {
    _profiles = _profiles.where((p) => p.id != id).toList();
    await _authService.saveProfiles(_profiles);
    if (_active?.id == id) await _activate(_profiles.firstOrNull);
    notifyListeners();
  }

  /// A 401 for [token]: that key was revoked, so drop the profile holding it.
  /// Keyed by the token the failing request used, not "whatever is active",
  /// because the user may have switched profiles while it was in flight.
  Future<void> invalidate(String? token) async {
    final p = _profiles.where((p) => p.apiKey == token).firstOrNull;
    if (p != null) await removeProfile(p.id);
  }

  /// Drops the active profile.
  Future<void> logout() => invalidate(_active?.apiKey);

  @override
  void dispose() {
    _authService.dispose();
    super.dispose();
  }
}
