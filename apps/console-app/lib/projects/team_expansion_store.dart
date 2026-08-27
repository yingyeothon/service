import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const _key = 'projects_expanded_teams';

/// Which team accordions on the projects tab are open, kept on the device so
/// a restart shows the same layout. Unknown teams fall back to the caller's
/// default (the first team open, the rest closed).
abstract class TeamExpansionStore {
  Future<Map<String, bool>> read();
  Future<void> write(Map<String, bool> expanded);
}

/// Backed by the same secure storage the app already uses for profiles;
/// a corrupt or missing value reads as empty.
class SecureTeamExpansionStore implements TeamExpansionStore {
  const SecureTeamExpansionStore();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  @override
  Future<Map<String, bool>> read() async {
    try {
      final raw = await _storage.read(key: _key);
      if (raw == null) return const {};
      return decodeTeamExpansion(raw);
    } catch (_) {
      return const {};
    }
  }

  @override
  Future<void> write(Map<String, bool> expanded) async {
    try {
      await _storage.write(key: _key, value: jsonEncode(expanded));
    } catch (_) {
      // Persistence is a convenience; the in-memory state still applies.
    }
  }
}

/// `{teamId: bool}` JSON; anything else yields an empty map.
Map<String, bool> decodeTeamExpansion(String raw) {
  try {
    final parsed = jsonDecode(raw);
    if (parsed is! Map<String, dynamic>) return const {};
    return {
      for (final e in parsed.entries)
        if (e.value is bool) e.key: e.value as bool,
    };
  } catch (_) {
    return const {};
  }
}

/// In-memory store for tests.
class MemoryTeamExpansionStore implements TeamExpansionStore {
  MemoryTeamExpansionStore([Map<String, bool>? initial])
    : state = {...?initial};

  Map<String, bool> state;

  @override
  Future<Map<String, bool>> read() async => {...state};

  @override
  Future<void> write(Map<String, bool> expanded) async {
    state = {...expanded};
  }
}
