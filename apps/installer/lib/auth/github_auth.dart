import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:catalog/auth/auth_config.dart';
import 'package:catalog/auth/auth_diagnostics.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

class DeviceCodeInfo {
  DeviceCodeInfo({
    required this.deviceCode,
    required this.userCode,
    required this.verificationUri,
    required this.expiresIn,
    required this.interval,
  });

  final String deviceCode;
  final String userCode;
  final String verificationUri;
  final int expiresIn;
  final int interval;
}

class DeviceTokenInfo {
  DeviceTokenInfo({required this.token, this.username});

  final String token;
  final String? username;
}

enum DeviceTokenPollStatus {
  success,
  pending,
  slowDown,
  expired,
  denied,
  invalidCode,
}

class DeviceTokenPollResult {
  const DeviceTokenPollResult({
    required this.status,
    required this.httpStatusCode,
    this.session,
    this.retryAfterSeconds,
    this.message,
  });

  final DeviceTokenPollStatus status;
  final int httpStatusCode;
  final DeviceTokenInfo? session;
  final int? retryAfterSeconds;
  final String? message;
}

class GitHubAuthService {
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  final HttpClient _ioHttpClient;
  late final http.Client _httpClient;
  static const String _tokenKey = 'auth_token';
  static const String _usernameKey = 'github_username';
  static const String _serverBaseUrlKey = 'server_base_url';
  static const Duration _requestTimeout = Duration(seconds: 10);
  static const int _maxTransportAttempts = 3;

  GitHubAuthService() : _ioHttpClient = HttpClient() {
    _ioHttpClient.connectionTimeout = _requestTimeout;
    _httpClient = IOClient(_ioHttpClient);
  }

  Future<DeviceCodeInfo> requestDeviceCode() async {
    final context = AuthRequestContext(
      requestId: AuthDiagnosticLogger.newRequestId(),
      operation: 'request_device_code',
      method: 'POST',
      uri: Uri.parse(AuthConfig.authDeviceCodeUrl),
      timestamp: DateTime.now(),
      attempt: 1,
    );
    final response = await _postWithDiagnostics(context: context);

    if (response.statusCode != 201) {
      final message = _extractErrorMessage(response.bodyBytes);
      throw AuthDiagnosticLogger.createError(
        context: context,
        error: Exception(
          'Failed to request device code: ${response.statusCode}${message == null ? '' : ' ($message)'}',
        ),
        stackTrace: StackTrace.current,
        httpStatus: response.statusCode,
        responseHeaders: response.headers,
        forceKind: AuthFailureKind.serverHttp,
      );
    }

    late final Map<String, dynamic> data;
    try {
      data =
          jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    } catch (e, st) {
      throw AuthDiagnosticLogger.createError(
        context: context,
        error: e,
        stackTrace: st,
        httpStatus: response.statusCode,
        responseHeaders: response.headers,
        forceKind: AuthFailureKind.responseParse,
        message: 'Failed to parse device code response',
      );
    }

    // `handle` is the console's opaque stand-in for the GitHub device_code.
    return DeviceCodeInfo(
      deviceCode: data['handle'] as String,
      userCode: data['userCode'] as String,
      verificationUri: data['verificationUri'] as String,
      expiresIn: data['expiresInSec'] as int? ?? 900,
      interval: data['intervalSec'] as int? ?? 5,
    );
  }

  Future<DeviceTokenPollResult> pollDeviceToken({
    required String deviceCode,
    required int interval,
    int? attempt,
  }) async {
    final context = AuthRequestContext(
      requestId: AuthDiagnosticLogger.newRequestId(),
      operation: 'poll_device_token',
      method: 'POST',
      uri: Uri.parse(AuthConfig.authDeviceTokenUrl),
      timestamp: DateTime.now(),
      attempt: attempt,
      intervalSeconds: interval,
    );
    final response = await _postWithDiagnostics(
      context: context,
      headers: const {'Content-Type': 'application/json'},
      body: jsonEncode({'handle': deviceCode, 'tokenName': 'installer'}),
      metadata: <String, Object?>{'deviceCodeLength': deviceCode.length},
    );

    final statusCode = response.statusCode;
    final message = _extractErrorMessage(response.bodyBytes);
    final retryAfter = _extractRetryAfterSeconds(response.headers);

    if (statusCode == 201) {
      late final Map<String, dynamic> data;
      try {
        data =
            jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
      } catch (e, st) {
        throw AuthDiagnosticLogger.createError(
          context: context,
          error: e,
          stackTrace: st,
          httpStatus: statusCode,
          responseHeaders: response.headers,
          forceKind: AuthFailureKind.responseParse,
          message: 'Failed to parse device token response',
        );
      }
      final token = data['token'] as String?;
      final member = data['member'] as Map<String, dynamic>?;
      final username = member?['login'] as String?;

      if (token == null || token.isEmpty) {
        throw AuthDiagnosticLogger.createError(
          context: context,
          error: Exception('No token received'),
          stackTrace: StackTrace.current,
          httpStatus: statusCode,
          responseHeaders: response.headers,
          forceKind: AuthFailureKind.responseParse,
          message: 'No token received',
        );
      }
      if (username == null || username.isEmpty) {
        throw AuthDiagnosticLogger.createError(
          context: context,
          error: Exception('No username received'),
          stackTrace: StackTrace.current,
          httpStatus: statusCode,
          responseHeaders: response.headers,
          forceKind: AuthFailureKind.responseParse,
          message: 'No username received',
        );
      }

      return DeviceTokenPollResult(
        status: DeviceTokenPollStatus.success,
        httpStatusCode: statusCode,
        session: DeviceTokenInfo(token: token, username: username),
      );
    }

    if (statusCode == 202) {
      return DeviceTokenPollResult(
        status: DeviceTokenPollStatus.pending,
        httpStatusCode: statusCode,
        retryAfterSeconds: retryAfter ?? interval,
        message: message ?? '아직 GitHub 인증이 완료되지 않았습니다.',
      );
    }
    if (statusCode == 429) {
      return DeviceTokenPollResult(
        status: DeviceTokenPollStatus.slowDown,
        httpStatusCode: statusCode,
        retryAfterSeconds:
            _extractIntervalSeconds(response.bodyBytes) ??
            retryAfter ??
            (interval + 5),
        message: message ?? '요청이 너무 빠릅니다. 잠시 후 다시 시도해주세요.',
      );
    }
    if (statusCode == 410 || statusCode == 401) {
      return DeviceTokenPollResult(
        status: DeviceTokenPollStatus.expired,
        httpStatusCode: statusCode,
        message: message ?? '인증 코드가 만료되었습니다. 처음부터 다시 시도해주세요.',
      );
    }
    if (statusCode == 403) {
      return DeviceTokenPollResult(
        status: DeviceTokenPollStatus.denied,
        httpStatusCode: statusCode,
        message: message ?? 'GitHub에서 인증이 거부되었습니다.',
      );
    }
    if (statusCode == 400) {
      return DeviceTokenPollResult(
        status: DeviceTokenPollStatus.invalidCode,
        httpStatusCode: statusCode,
        message: message ?? '잘못된 디바이스 코드입니다.',
      );
    }

    throw AuthDiagnosticLogger.createError(
      context: context,
      error: Exception(
        'Failed to poll device token: $statusCode${message == null ? '' : ' ($message)'}',
      ),
      stackTrace: StackTrace.current,
      httpStatus: statusCode,
      responseHeaders: response.headers,
      forceKind: AuthFailureKind.serverHttp,
    );
  }

  Future<void> validateApiKey(String apiKey) async {
    final context = AuthRequestContext(
      requestId: AuthDiagnosticLogger.newRequestId(),
      operation: 'validate_api_key',
      method: 'GET',
      uri: Uri.parse(AuthConfig.appsUrl),
      timestamp: DateTime.now(),
      attempt: 1,
    );
    final uri = Uri.parse(AuthConfig.appsUrl);
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
  }

  Future<http.Response> _postWithDiagnostics({
    required AuthRequestContext context,
    Map<String, String>? headers,
    Object? body,
    Map<String, Object?>? metadata,
  }) async {
    return _executeWithRetry(
      context: context,
      metadata: metadata,
      request:
          () => _httpClient.post(context.uri, headers: headers, body: body),
    );
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

  /// `rate_limited` answers carry `error.details.intervalSec`.
  int? _extractIntervalSeconds(List<int> bodyBytes) {
    try {
      final decoded = jsonDecode(utf8.decode(bodyBytes));
      final details =
          ((decoded as Map<String, dynamic>)['error']
              as Map<String, dynamic>?)?['details'];
      final v = (details as Map<String, dynamic>?)?['intervalSec'];
      if (v is int && v > 0) {
        return v;
      }
    } catch (_) {
      // Best-effort parsing only.
    }
    return null;
  }

  int? _extractRetryAfterSeconds(Map<String, String> headers) {
    final retryAfterValue =
        headers.entries
            .firstWhere(
              (entry) => entry.key.toLowerCase() == 'retry-after',
              orElse: () => const MapEntry('', ''),
            )
            .value
            .trim();
    if (retryAfterValue.isEmpty) {
      return null;
    }

    final seconds = int.tryParse(retryAfterValue);
    if (seconds == null || seconds <= 0) {
      return null;
    }
    return seconds;
  }

  Future<void> saveSession(DeviceTokenInfo session) async {
    await _storage.write(key: _tokenKey, value: session.token);
    if (session.username == null || session.username!.isEmpty) {
      await _storage.delete(key: _usernameKey);
      return;
    }
    await _storage.write(key: _usernameKey, value: session.username);
  }

  Future<void> logout() async {
    await _storage.delete(key: _tokenKey);
    await _storage.delete(key: _usernameKey);
    await _storage.delete(key: _serverBaseUrlKey);
  }

  Future<String?> getToken() async {
    return _storage.read(key: _tokenKey);
  }

  Future<String?> getUsername() async {
    return _storage.read(key: _usernameKey);
  }

  Future<void> saveServerBaseUrl(String baseUrl) async {
    await _storage.write(key: _serverBaseUrlKey, value: baseUrl);
  }

  Future<void> clearServerBaseUrl() async {
    await _storage.delete(key: _serverBaseUrlKey);
  }

  Future<String?> getServerBaseUrl() async {
    return _storage.read(key: _serverBaseUrlKey);
  }

  void dispose() {
    _httpClient.close();
  }
}
