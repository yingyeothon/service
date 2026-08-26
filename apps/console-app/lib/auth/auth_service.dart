import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/auth/auth_diagnostics.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

/// One saved console login: a server and an API key minted for it, plus the
/// GitHub login `/me` reported when the key was added.
class Profile {
  const Profile({
    required this.id,
    required this.server,
    required this.apiKey,
    required this.login,
    required this.addedAt,
  });

  final String id;
  final String server;
  final String apiKey;
  final String login;
  final DateTime addedAt;

  /// Host only, for the profile menu; the scheme/port are implied.
  String get host => Uri.parse(server).host;

  Map<String, Object?> toJson() => {
    'id': id,
    'server': server,
    'apiKey': apiKey,
    'login': login,
    'addedAt': addedAt.toUtc().toIso8601String(),
  };

  static Profile? fromJson(Object? v) {
    if (v is! Map<String, dynamic>) return null;
    final id = v['id'], server = v['server'], key = v['apiKey'];
    if (id is! String || server is! String || key is! String) return null;
    return Profile(
      id: id,
      server: server,
      apiKey: key,
      login: (v['login'] as String?) ?? '',
      addedAt:
          DateTime.tryParse((v['addedAt'] as String?) ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    );
  }
}

/// Validates API keys against `/me` and persists profiles in secure storage.
class AuthService {
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  final HttpClient _ioHttpClient;
  late final http.Client _httpClient;
  static const String _profilesKey = 'profiles';
  static const String _activeKey = 'active_profile';
  static const Duration _requestTimeout = Duration(seconds: 10);
  static const int _maxTransportAttempts = 3;

  AuthService() : _ioHttpClient = HttpClient() {
    _ioHttpClient.connectionTimeout = _requestTimeout;
    _httpClient = IOClient(_ioHttpClient);
  }

  /// Probes [apiKey] against `/me` of [baseUrl]; returns the login.
  Future<String> validateApiKey(
    String apiKey, {
    required String baseUrl,
  }) async {
    final context = AuthRequestContext(
      requestId: AuthDiagnosticLogger.newRequestId(),
      operation: 'validate_api_key',
      method: 'GET',
      uri: Uri.parse(AuthConfig.meUrlOf(baseUrl)),
      timestamp: DateTime.now(),
      attempt: 1,
    );
    // /me answers for any authenticated identity (even a pending member), so
    // the probe checks the token itself rather than the caller's team seats.
    final uri = Uri.parse(AuthConfig.meUrlOf(baseUrl));
    final response = await _getWithDiagnostics(
      context: context,
      uri: uri,
      headers: {'Authorization': 'Bearer $apiKey'},
      metadata: const <String, Object?>{'apiKeyPresent': true},
    );

    if (response.statusCode == 401 || response.statusCode == 403) {
      final message = _extractErrorMessage(response.bodyBytes);
      throw AuthDiagnosticLogger.createError(
        context: context,
        error: Exception(message ?? 'API key가 유효하지 않습니다.'),
        stackTrace: StackTrace.current,
        httpStatus: response.statusCode,
        responseHeaders: response.headers,
        forceKind: AuthFailureKind.serverHttp,
        message: message ?? 'API key가 유효하지 않습니다.',
      );
    }
    if (response.statusCode != 200) {
      final message = _extractErrorMessage(response.bodyBytes);
      throw AuthDiagnosticLogger.createError(
        context: context,
        error: Exception(
          'API key 검증 실패: ${response.statusCode}${message == null ? '' : ' ($message)'}',
        ),
        stackTrace: StackTrace.current,
        httpStatus: response.statusCode,
        responseHeaders: response.headers,
        forceKind: AuthFailureKind.serverHttp,
        message: 'API key 검증 실패',
      );
    }
    // /me answers 200 for a pending member too; refuse here so the user is not
    // logged in to a catalog that will answer 403.
    final me = _decodeJsonObject(response.bodyBytes);
    if (me?['role'] == 'pending') {
      throw AuthDiagnosticLogger.createError(
        context: context,
        error: Exception('pending member'),
        stackTrace: StackTrace.current,
        httpStatus: response.statusCode,
        responseHeaders: response.headers,
        forceKind: AuthFailureKind.serverHttp,
        message: '아직 승인되지 않은 계정입니다. 관리자 승인 후 다시 시도해주세요.',
      );
    }
    return (me?['login'] as String?) ?? '';
  }

  Map<String, dynamic>? _decodeJsonObject(List<int> bodyBytes) {
    if (bodyBytes.isEmpty) return null;
    try {
      final data = jsonDecode(utf8.decode(bodyBytes));
      return data is Map<String, dynamic> ? data : null;
    } catch (_) {
      return null;
    }
  }

  Future<http.Response> _getWithDiagnostics({
    required AuthRequestContext context,
    required Uri uri,
    Map<String, String>? headers,
    Map<String, Object?>? metadata,
  }) async {
    return _executeWithRetry(
      context: context.copyWith(uri: uri),
      metadata: metadata,
      request: () => _httpClient.get(uri, headers: headers),
    );
  }

  Future<http.Response> _executeWithRetry({
    required AuthRequestContext context,
    required Future<http.Response> Function() request,
    Map<String, Object?>? metadata,
  }) async {
    var transportAttempt = 0;
    while (true) {
      transportAttempt += 1;
      final requestContext = context.copyWith(
        transportAttempt: transportAttempt,
        timestamp: DateTime.now(),
      );
      AuthDiagnosticLogger.logRequestStart(
        requestContext,
        metadata: <String, Object?>{
          if (metadata != null) ...metadata,
          'transportAttempt': transportAttempt,
        },
      );

      final stopwatch = Stopwatch()..start();
      try {
        final response = await request().timeout(_requestTimeout);
        stopwatch.stop();
        AuthDiagnosticLogger.logResponse(
          requestContext,
          statusCode: response.statusCode,
          elapsed: stopwatch.elapsed,
          headers: response.headers,
        );
        return response;
      } catch (e, st) {
        stopwatch.stop();
        final kind = AuthErrorClassifier.classify(e);
        final retryable = _isRetryableTransportFailure(kind);
        final canRetry = retryable && transportAttempt < _maxTransportAttempts;
        final networkSnapshot = await _collectNetworkSnapshot(
          requestContext.uri,
        );
        final nextDelay =
            canRetry ? _computeBackoffDelay(transportAttempt) : null;

        AuthDiagnosticLogger.logTransportFailure(
          context: requestContext,
          kind: kind,
          error: e,
          stackTrace: st,
          willRetry: canRetry,
          maxTransportAttempts: _maxTransportAttempts,
          nextDelay: nextDelay,
          networkSnapshot: networkSnapshot,
        );

        if (canRetry && nextDelay != null) {
          await Future<void>.delayed(nextDelay);
          continue;
        }

        throw AuthDiagnosticLogger.createError(
          context: requestContext,
          error: e,
          stackTrace: st,
          forceKind: kind,
        );
      }
    }
  }

  bool _isRetryableTransportFailure(AuthFailureKind kind) {
    return kind == AuthFailureKind.clientDns ||
        kind == AuthFailureKind.clientNetwork ||
        kind == AuthFailureKind.timeout;
  }

  Duration _computeBackoffDelay(int transportAttempt) {
    final exponent = transportAttempt - 1;
    final delayMs = 350 * (1 << exponent);
    final bounded = delayMs.clamp(350, 3000);
    return Duration(milliseconds: bounded.toInt());
  }

  Future<Map<String, Object?>> _collectNetworkSnapshot(Uri uri) async {
    final snapshot = <String, Object?>{
      'host': uri.host,
      'scheme': uri.scheme,
      'port': uri.hasPort ? uri.port : null,
      'os': Platform.operatingSystem,
    };

    try {
      final lookupResult = await InternetAddress.lookup(
        uri.host,
      ).timeout(const Duration(seconds: 2));
      snapshot['dnsLookup'] = <String, Object?>{
        'ok': true,
        'addresses': lookupResult.map((e) => e.address).toList(),
      };
    } catch (e) {
      snapshot['dnsLookup'] = <String, Object?>{
        'ok': false,
        'error': e.toString(),
      };
    }

    try {
      final interfaces = await NetworkInterface.list(
        includeLoopback: false,
        includeLinkLocal: true,
      ).timeout(const Duration(seconds: 2));
      snapshot['interfaces'] =
          interfaces
              .map(
                (iface) => <String, Object?>{
                  'name': iface.name,
                  'addresses': iface.addresses.map((a) => a.address).toList(),
                },
              )
              .toList();
    } catch (e) {
      snapshot['interfacesError'] = e.toString();
    }

    return snapshot;
  }

  String? _extractErrorMessage(List<int> bodyBytes) {
    try {
      final decoded = jsonDecode(utf8.decode(bodyBytes));
      if (decoded is Map<String, dynamic>) {
        final error = decoded['error'];
        if (error is Map<String, dynamic>) {
          final value = error['message'];
          if (value is String && value.trim().isNotEmpty) {
            return value.trim();
          }
        }
        for (final key in ['detail', 'message', 'error', 'title']) {
          final value = decoded[key];
          if (value is String && value.trim().isNotEmpty) {
            return value.trim();
          }
        }
      }
    } catch (_) {
      // Best-effort parsing only.
    }
    return null;
  }

  Future<List<Profile>> loadProfiles() async {
    final raw = await _storage.read(key: _profilesKey);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final list = jsonDecode(raw);
      if (list is! List) return const [];
      return list.map(Profile.fromJson).whereType<Profile>().toList();
    } catch (_) {
      return const [];
    }
  }

  Future<void> saveProfiles(List<Profile> profiles) async {
    await _storage.write(
      key: _profilesKey,
      value: jsonEncode(profiles.map((p) => p.toJson()).toList()),
    );
  }

  Future<String?> loadActiveProfileId() => _storage.read(key: _activeKey);

  Future<void> saveActiveProfileId(String? id) async {
    if (id == null) {
      await _storage.delete(key: _activeKey);
    } else {
      await _storage.write(key: _activeKey, value: id);
    }
  }

  void dispose() {
    _httpClient.close();
  }
}
