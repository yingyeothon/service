import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';

enum AuthFailureKind {
  clientDns,
  clientNetwork,
  tls,
  timeout,
  serverHttp,
  responseParse,
  unknown,
}

String _sanitizeUri(Uri uri) {
  return Uri(
    scheme: uri.scheme,
    host: uri.host,
    port: uri.hasPort ? uri.port : null,
    path: uri.path,
  ).toString();
}

class AuthRequestContext {
  const AuthRequestContext({
    required this.requestId,
    required this.operation,
    required this.method,
    required this.uri,
    required this.timestamp,
    this.attempt,
    this.intervalSeconds,
    this.transportAttempt,
  });

  final String requestId;
  final String operation;
  final String method;
  final Uri uri;
  final DateTime timestamp;
  final int? attempt;
  final int? intervalSeconds;
  final int? transportAttempt;

  AuthRequestContext copyWith({
    String? requestId,
    String? operation,
    String? method,
    Uri? uri,
    DateTime? timestamp,
    int? attempt,
    int? intervalSeconds,
    int? transportAttempt,
  }) {
    return AuthRequestContext(
      requestId: requestId ?? this.requestId,
      operation: operation ?? this.operation,
      method: method ?? this.method,
      uri: uri ?? this.uri,
      timestamp: timestamp ?? this.timestamp,
      attempt: attempt ?? this.attempt,
      intervalSeconds: intervalSeconds ?? this.intervalSeconds,
      transportAttempt: transportAttempt ?? this.transportAttempt,
    );
  }

  Map<String, Object?> toLogJson() {
    return <String, Object?>{
      'requestId': requestId,
      'operation': operation,
      'method': method,
      'uri': _sanitizeUri(uri),
      'attempt': attempt,
      'intervalSeconds': intervalSeconds,
      'transportAttempt': transportAttempt,
      'timestamp': timestamp.toIso8601String(),
    };
  }
}

class AuthDiagnosticError implements Exception {
  AuthDiagnosticError({
    required this.diagnosticId,
    required this.kind,
    required this.message,
    required this.context,
    required this.cause,
    required this.causeStackTrace,
    this.httpStatus,
    this.responseHeaders,
  });

  final String diagnosticId;
  final AuthFailureKind kind;
  final String message;
  final AuthRequestContext context;
  final int? httpStatus;
  final Map<String, String>? responseHeaders;
  final Object cause;
  final StackTrace causeStackTrace;

  @override
  String toString() {
    return '$message [diagnosticId=$diagnosticId, kind=${kind.name}, status=${httpStatus ?? '-'}]';
  }
}

class AuthErrorClassifier {
  static AuthFailureKind classify(Object error, {int? httpStatus}) {
    if (httpStatus != null) {
      return AuthFailureKind.serverHttp;
    }

    if (error is TimeoutException) {
      return AuthFailureKind.timeout;
    }

    if (error is HandshakeException ||
        error.runtimeType.toString().contains('Tls')) {
      return AuthFailureKind.tls;
    }

    final raw = error.toString().toLowerCase();
    if (raw.contains('failed host lookup') ||
        raw.contains('no address associated with hostname') ||
        raw.contains('name or service not known') ||
        raw.contains('temporary failure in name resolution')) {
      return AuthFailureKind.clientDns;
    }
    if (raw.contains('connection reset') ||
        raw.contains('network is unreachable') ||
        raw.contains('software caused connection abort') ||
        raw.contains('connection aborted') ||
        raw.contains('connection refused')) {
      return AuthFailureKind.clientNetwork;
    }

    if (error is SocketException) {
      final osError = error.osError;
      final errno = osError?.errorCode;
      final raw = '${error.message} ${osError?.message ?? ''}'.toLowerCase();
      final isDns =
          errno == 7 ||
          raw.contains('no address associated with hostname') ||
          raw.contains('failed host lookup') ||
          raw.contains('name or service not known') ||
          raw.contains('temporary failure in name resolution');
      return isDns ? AuthFailureKind.clientDns : AuthFailureKind.clientNetwork;
    }

    if (error is FormatException || error is TypeError) {
      return AuthFailureKind.responseParse;
    }

    return AuthFailureKind.unknown;
  }
}

class AuthDiagnosticLogger {
  static int _sequence = 0;
  static final Random _random = Random();

  static String newRequestId() {
    _sequence += 1;
    return 'req-${DateTime.now().microsecondsSinceEpoch}-${_sequence.toRadixString(16)}';
  }

  static AuthDiagnosticError createError({
    required AuthRequestContext context,
    required Object error,
    required StackTrace stackTrace,
    int? httpStatus,
    Map<String, String>? responseHeaders,
    AuthFailureKind? forceKind,
    String? message,
  }) {
    final kind =
        forceKind ??
        AuthErrorClassifier.classify(error, httpStatus: httpStatus);
    final diagnosticId = _newDiagnosticId();
    final diagnosticError = AuthDiagnosticError(
      diagnosticId: diagnosticId,
      kind: kind,
      message: message ?? _defaultMessage(kind, error, httpStatus),
      context: context,
      cause: error,
      causeStackTrace: stackTrace,
      httpStatus: httpStatus,
      responseHeaders: responseHeaders,
    );
    logFailure(diagnosticError);
    return diagnosticError;
  }

  static void logRequestStart(
    AuthRequestContext context, {
    Map<String, Object?>? metadata,
  }) {
    _emit(
      level: 'INFO',
      event: 'request_start',
      payload: <String, Object?>{
        ...context.toLogJson(),
        if (metadata != null) 'metadata': _sanitizeMap(metadata),
      },
    );
  }

  static void logResponse(
    AuthRequestContext context, {
    required int statusCode,
    required Duration elapsed,
    Map<String, String>? headers,
  }) {
    _emit(
      level: 'INFO',
      event: 'response',
      payload: <String, Object?>{
        ...context.toLogJson(),
        'statusCode': statusCode,
        'elapsedMs': elapsed.inMilliseconds,
        if (headers != null)
          'headers': <String, Object?>{
            'content-type': headers['content-type'],
            'retry-after': headers['retry-after'],
          },
      },
    );
  }

  static void logFailure(AuthDiagnosticError error) {
    final retryAfter =
        error.responseHeaders?.entries
            .firstWhere(
              (entry) => entry.key.toLowerCase() == 'retry-after',
              orElse: () => const MapEntry('', ''),
            )
            .value
            .trim() ??
        '';
    _emit(
      level: 'ERROR',
      event: 'request_failure',
      payload: <String, Object?>{
        ...error.context.toLogJson(),
        'diagnosticId': error.diagnosticId,
        'kind': error.kind.name,
        'statusCode': error.httpStatus,
        'message': _redact(error.message),
        'cause': _redact(error.cause.toString()),
        if (error.responseHeaders != null)
          'headers': <String, Object?>{
            'content-type': error.responseHeaders!['content-type'],
            'retry-after': retryAfter.isEmpty ? null : retryAfter,
          },
      },
      exception: error.cause,
      stackTrace: error.causeStackTrace,
    );
  }

  static void logTransportFailure({
    required AuthRequestContext context,
    required AuthFailureKind kind,
    required Object error,
    required StackTrace stackTrace,
    required bool willRetry,
    required int maxTransportAttempts,
    Duration? nextDelay,
    Map<String, Object?>? networkSnapshot,
  }) {
    _emit(
      level: willRetry ? 'WARN' : 'ERROR',
      event: 'transport_failure',
      payload: <String, Object?>{
        ...context.toLogJson(),
        'kind': kind.name,
        'willRetry': willRetry,
        'maxTransportAttempts': maxTransportAttempts,
        if (nextDelay != null) 'nextDelayMs': nextDelay.inMilliseconds,
        'cause': _redact(error.toString()),
        if (networkSnapshot != null) 'networkSnapshot': networkSnapshot,
      },
      exception: error,
      stackTrace: stackTrace,
    );
  }

  static void logDnsFallback({
    required Uri uri,
    required String stage,
    required List<String> addresses,
    String? note,
  }) {
    _emit(
      level: 'INFO',
      event: 'dns_fallback',
      payload: <String, Object?>{
        'uri': _sanitizeUri(uri),
        'stage': stage,
        'addresses': addresses,
        if (note != null) 'note': note,
      },
    );
  }

  static void logUiFailure({
    required String scope,
    required Object error,
    required StackTrace stackTrace,
    Map<String, Object?>? extras,
  }) {
    _emit(
      level: 'ERROR',
      event: 'ui_failure',
      payload: <String, Object?>{
        'scope': scope,
        'error': _redact(error.toString()),
        if (extras != null) 'extras': _sanitizeMap(extras),
      },
      exception: error,
      stackTrace: stackTrace,
    );
  }

  static void logUnhandled({
    required String scope,
    required Object error,
    required StackTrace stackTrace,
  }) {
    _emit(
      level: 'ERROR',
      event: 'unhandled',
      payload: <String, Object?>{
        'scope': scope,
        'error': _redact(error.toString()),
      },
      exception: error,
      stackTrace: stackTrace,
    );
  }

  static void _emit({
    required String level,
    required String event,
    required Map<String, Object?> payload,
    Object? exception,
    StackTrace? stackTrace,
  }) {
    final jsonLine = jsonEncode(_sanitizeMap(payload));
    final line = '[AUTH_DIAG][$level][$event] $jsonLine';
    debugPrint(line);
    developer.log(
      line,
      name: 'installer.auth',
      level: level == 'ERROR' ? 1000 : 800,
      error: exception,
      stackTrace: stackTrace,
    );
  }

  static String _newDiagnosticId() {
    _sequence += 1;
    final randomPart = _random
        .nextInt(0xFFFFFF)
        .toRadixString(16)
        .padLeft(6, '0');
    return 'diag-${DateTime.now().millisecondsSinceEpoch}-${_sequence.toRadixString(16)}-$randomPart';
  }

  static String _defaultMessage(
    AuthFailureKind kind,
    Object error,
    int? statusCode,
  ) {
    switch (kind) {
      case AuthFailureKind.clientDns:
        return '서버 주소 DNS 조회 실패';
      case AuthFailureKind.clientNetwork:
        return '네트워크 연결 실패';
      case AuthFailureKind.tls:
        return 'TLS/인증서 연결 실패';
      case AuthFailureKind.timeout:
        return '요청 시간 초과';
      case AuthFailureKind.serverHttp:
        return '서버 오류 응답${statusCode == null ? '' : ' (HTTP $statusCode)'}';
      case AuthFailureKind.responseParse:
        return '응답 파싱 실패';
      case AuthFailureKind.unknown:
        return '알 수 없는 인증 오류: ${_redact(error.toString())}';
    }
  }

  static Map<String, Object?> _sanitizeMap(Map<String, Object?> raw) {
    return raw.map((key, value) {
      if (value == null) {
        return MapEntry(key, null);
      }
      if (value is Map<String, Object?>) {
        return MapEntry(key, _sanitizeMap(value));
      }
      if (value is List<Object?>) {
        return MapEntry(
          key,
          value.map((item) {
            if (item is Map<String, Object?>) {
              return _sanitizeMap(item);
            }
            if (item is String) {
              return _redact(item);
            }
            return item;
          }).toList(),
        );
      }
      if (value is Uri) {
        return MapEntry(key, _sanitizeUri(value));
      }
      if (value is String) {
        return MapEntry(key, _redact(value));
      }
      return MapEntry(key, value);
    });
  }

  static String _redact(String input) {
    var result = input;
    result = result.replaceAllMapped(
      // Console API tokens plus the legacy cata_ format.
      RegExp(r'(yyt_[0-9a-f]{48}|cata_[0-9a-fA-F]{64})'),
      (match) => '${match.group(0)!.substring(0, 8)}...(redacted)',
    );
    result = result.replaceAllMapped(
      RegExp(r'(Bearer\s+)\S+'),
      (match) => '${match.group(1)}***',
    );
    result = result.replaceAllMapped(
      RegExp(r'("handle"\s*:\s*")[^"]+(")'),
      (match) => '${match.group(1)}***${match.group(2)}',
    );
    result = result.replaceAllMapped(
      RegExp(r'("device_code"\s*:\s*")[^"]+(")'),
      (match) => '${match.group(1)}***${match.group(2)}',
    );
    result = result.replaceAllMapped(
      RegExp(r'("token"\s*:\s*")[^"]+(")'),
      (match) => '${match.group(1)}***${match.group(2)}',
    );
    return result;
  }
}
