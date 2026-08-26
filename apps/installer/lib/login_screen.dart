import 'dart:async';
import 'dart:convert';

import 'package:catalog/auth/auth_state.dart';
import 'package:catalog/auth/auth_config.dart';
import 'package:catalog/auth/auth_diagnostics.dart';
import 'package:catalog/auth/github_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:url_launcher/url_launcher.dart';

enum _LoginPhase {
  idle,
  requestingCode,
  waitingApproval,
  pollingToken,
  validatingApiKey,
}

class _ApiKeyLoginPayload {
  const _ApiKeyLoginPayload({required this.server, required this.apiKey});

  final String server;
  final String apiKey;
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.authState});

  final AuthState authState;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  _LoginPhase _phase = _LoginPhase.idle;
  DeviceCodeInfo? _deviceCodeInfo;
  String? _errorMessage;
  int _pollRequestSerial = 0;
  Timer? _deviceCodeCountdownTimer;
  DateTime? _deviceCodeExpiresAt;
  int? _deviceCodeTotalSeconds;
  int? _deviceCodeRemainingSeconds;

  @override
  void dispose() {
    _stopDeviceCodeCountdown();
    super.dispose();
  }

  void _logUiFailure(
    String scope,
    Object error,
    StackTrace stackTrace, {
    Map<String, Object?>? extras,
  }) {
    AuthDiagnosticLogger.logUiFailure(
      scope: scope,
      error: error,
      stackTrace: stackTrace,
      extras: <String, Object?>{
        'phase': _phase.name,
        'server': widget.authState.serverBaseUrl ?? '',
        if (extras != null) ...extras,
      },
    );
  }

  String _buildUiError(String prefix, Object error) {
    if (error is AuthDiagnosticError) {
      return '$prefix: ${error.message} (진단 코드: ${error.diagnosticId})';
    }
    return '$prefix: $error';
  }

  Future<void> _startDeviceFlow() async {
    if (_phase != _LoginPhase.idle) return;

    setState(() {
      _errorMessage = null;
    });

    final serverInput = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder:
            (_) => _GitHubServerAddressPage(
              initialServerUrl: widget.authState.serverBaseUrl,
            ),
      ),
    );
    if (!mounted || serverInput == null || serverInput.trim().isEmpty) return;

    try {
      await widget.authState.setServerBaseUrl(serverInput);
    } catch (e, st) {
      _logUiFailure('set_server_for_device_flow', e, st);
      if (!mounted) return;
      setState(() {
        _errorMessage = _buildUiError('서버 주소 저장 실패', e);
      });
      return;
    }

    setState(() {
      _phase = _LoginPhase.requestingCode;
      _errorMessage = null;
      _deviceCodeInfo = null;
    });

    try {
      final info = await widget.authState.requestDeviceCode();
      if (!mounted) return;

      _startDeviceCodeCountdown(info.expiresIn);
      setState(() {
        _deviceCodeInfo = info;
        _phase = _LoginPhase.waitingApproval;
      });

      _startPolling(info);
    } catch (e, st) {
      _logUiFailure('request_device_code', e, st);
      if (!mounted) return;
      _stopDeviceCodeCountdown();
      setState(() {
        _errorMessage = _buildUiError('디바이스 코드 요청 실패', e);
        _phase = _LoginPhase.idle;
      });
    }
  }

  Future<void> _startPolling(DeviceCodeInfo info) async {
    final serial = ++_pollRequestSerial;
    var pollIntervalSeconds = info.interval <= 0 ? 5 : info.interval;
    var attempt = 0;
    setState(() {
      _phase = _LoginPhase.pollingToken;
    });

    while (mounted && serial == _pollRequestSerial) {
      attempt += 1;
      try {
        final result = await widget.authState.pollDeviceToken(
          info,
          interval: pollIntervalSeconds,
          attempt: attempt,
        );
        if (!mounted || serial != _pollRequestSerial) return;
        if (_errorMessage != null) {
          setState(() {
            _errorMessage = null;
          });
        }

        switch (result.status) {
          case DeviceTokenPollStatus.success:
            _stopDeviceCodeCountdown();
            await widget.authState.completeLogin(result.session!);
            return;
          case DeviceTokenPollStatus.pending:
            pollIntervalSeconds =
                result.retryAfterSeconds ?? pollIntervalSeconds;
            break;
          case DeviceTokenPollStatus.slowDown:
            pollIntervalSeconds =
                result.retryAfterSeconds ?? (pollIntervalSeconds + 5);
            break;
          case DeviceTokenPollStatus.expired:
          case DeviceTokenPollStatus.denied:
          case DeviceTokenPollStatus.invalidCode:
            _stopDeviceCodeCountdown();
            setState(() {
              _errorMessage =
                  '로그인 토큰 획득 실패: ${result.message ?? '로그인을 계속할 수 없습니다.'}';
              _phase = _LoginPhase.idle;
              _deviceCodeInfo = null;
            });
            return;
        }
      } catch (e, st) {
        _logUiFailure(
          'poll_device_token',
          e,
          st,
          extras: <String, Object?>{
            'attempt': attempt,
            'intervalSeconds': pollIntervalSeconds,
          },
        );
        if (!mounted || serial != _pollRequestSerial) return;
        if (_isRetryablePollingError(e)) {
          setState(() {
            _errorMessage = '일시적인 네트워크 오류가 발생했습니다. 자동으로 재시도 중입니다.';
            _phase = _LoginPhase.pollingToken;
          });
          // Keep polling until code expires or a non-retryable error occurs.
          continue;
        }
        _stopDeviceCodeCountdown();
        setState(() {
          _errorMessage = _buildUiError('로그인 토큰 획득 실패', e);
          _phase = _LoginPhase.idle;
          _deviceCodeInfo = null;
        });
        return;
      }

      final delaySeconds = pollIntervalSeconds <= 0 ? 1 : pollIntervalSeconds;
      await Future.delayed(Duration(seconds: delaySeconds));
    }
  }

  bool _isRetryablePollingError(Object error) {
    if (error is! AuthDiagnosticError) {
      return false;
    }
    return error.kind == AuthFailureKind.clientDns ||
        error.kind == AuthFailureKind.clientNetwork ||
        error.kind == AuthFailureKind.timeout;
  }

  void _cancelPolling() {
    _pollRequestSerial++;
    _stopDeviceCodeCountdown();
    setState(() {
      _phase = _LoginPhase.idle;
      _deviceCodeInfo = null;
      _errorMessage = null;
    });
  }

  void _startDeviceCodeCountdown(int expiresInSeconds) {
    _stopDeviceCodeCountdown();
    if (expiresInSeconds <= 0) {
      return;
    }

    final expiresAt = DateTime.now().add(Duration(seconds: expiresInSeconds));
    _deviceCodeExpiresAt = expiresAt;
    _deviceCodeTotalSeconds = expiresInSeconds;
    _deviceCodeRemainingSeconds = expiresInSeconds;

    _deviceCodeCountdownTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      final deadline = _deviceCodeExpiresAt;
      if (!mounted || deadline == null) return;

      final remaining = deadline.difference(DateTime.now()).inSeconds;
      if (remaining <= 0) {
        _pollRequestSerial++;
        _stopDeviceCodeCountdown();
        setState(() {
          _phase = _LoginPhase.idle;
          _deviceCodeInfo = null;
          _errorMessage = '인증 코드가 만료되었습니다. GitHub 로그인을 다시 시작해주세요.';
        });
        return;
      }

      setState(() {
        _deviceCodeRemainingSeconds = remaining;
      });
    });
  }

  void _stopDeviceCodeCountdown() {
    _deviceCodeCountdownTimer?.cancel();
    _deviceCodeCountdownTimer = null;
    _deviceCodeExpiresAt = null;
    _deviceCodeTotalSeconds = null;
    _deviceCodeRemainingSeconds = null;
  }

  String _formatSeconds(int seconds) {
    final clamped = seconds < 0 ? 0 : seconds;
    final minutes = clamped ~/ 60;
    final secs = clamped % 60;
    return '$minutes:${secs.toString().padLeft(2, '0')}';
  }

  Future<void> _startQrLogin() async {
    if (_phase != _LoginPhase.idle) return;

    setState(() {
      _errorMessage = null;
    });

    final payload = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder:
            (_) => _QrScannerPage(
              initialServerUrl: widget.authState.serverBaseUrl,
            ),
      ),
    );
    if (!mounted || payload == null || payload.trim().isEmpty) return;

    await _loginWithApiKeyPayload(payload);
  }

  Future<void> _loginWithApiKeyPayload(String payload) async {
    setState(() {
      _phase = _LoginPhase.validatingApiKey;
      _errorMessage = null;
    });

    try {
      final loginPayload = _extractApiKeyPayload(payload);
      _validateApiKeyFormat(loginPayload.apiKey);
      await widget.authState.setServerBaseUrl(loginPayload.server);
      await widget.authState.loginWithApiKey(loginPayload.apiKey);
    } catch (e, st) {
      _logUiFailure('api_key_login', e, st);
      if (!mounted) return;
      setState(() {
        _errorMessage = _buildUiError('API key 로그인 실패', e);
        _phase = _LoginPhase.idle;
      });
    }
  }

  _ApiKeyLoginPayload _extractApiKeyPayload(String payload) {
    final trimmed = payload.trim();
    if (trimmed.isEmpty) {
      throw const FormatException('빈 QR 코드입니다.');
    }

    try {
      final decoded = jsonDecode(trimmed);
      if (decoded is Map<String, dynamic>) {
        final type = decoded['type'];
        final apiKey = decoded['apiKey'];
        final server = decoded['server'];
        if ((type == 'yyt_api_key' || type == 'cata_api_key') &&
            apiKey is String &&
            server is String) {
          final normalizedServer = AuthConfig.normalizeServerUrl(server);
          return _ApiKeyLoginPayload(
            server: normalizedServer,
            apiKey: apiKey.trim(),
          );
        }
        throw const FormatException(
          '지원되지 않는 QR 코드 형식입니다. 서버 주소가 포함된 최신 QR 코드를 사용해주세요.',
        );
      }
      throw const FormatException(
        '지원되지 않는 QR 코드 형식입니다. 서버 주소가 포함된 최신 QR 코드를 사용해주세요.',
      );
    } on FormatException {
      rethrow;
    }
  }

  void _validateApiKeyFormat(String apiKey) {
    final keyPattern = RegExp(r'^yyt_[0-9a-f]{48}$');
    if (!keyPattern.hasMatch(apiKey)) {
      throw const FormatException('API key 형식이 올바르지 않습니다.');
    }
  }

  Future<void> _openVerificationUri() async {
    final uriString = _deviceCodeInfo?.verificationUri;
    if (uriString == null) return;

    final uri = Uri.tryParse(uriString);
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  Future<void> _copyUserCode() async {
    final code = _deviceCodeInfo?.userCode;
    if (code == null) return;

    await Clipboard.setData(ClipboardData(text: code));
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('코드를 복사했습니다.')));
  }

  @override
  Widget build(BuildContext context) {
    final info = _deviceCodeInfo;
    final totalSeconds = _deviceCodeTotalSeconds;
    final remainingSeconds = _deviceCodeRemainingSeconds;
    final hasCountdown =
        info != null &&
        totalSeconds != null &&
        remainingSeconds != null &&
        totalSeconds > 0;
    final pollingProgress =
        hasCountdown
            ? ((totalSeconds - remainingSeconds) / totalSeconds).clamp(0.0, 1.0)
            : null;
    final isBusy =
        _phase == _LoginPhase.requestingCode ||
        _phase == _LoginPhase.pollingToken ||
        _phase == _LoginPhase.validatingApiKey;

    return Scaffold(
      appBar: AppBar(title: const Text('잉여톤 로그인')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Icon(
                      Icons.verified_user,
                      size: 64,
                      color: Colors.blue,
                    ),
                    const SizedBox(height: 16),
                    const Text(
                      '로그인 방법 선택',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'GitHub 인증 또는 API key QR 스캔으로 로그인할 수 있습니다.',
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 20),
                    if (info != null) ...[
                      Text(
                        '인증 코드',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      SelectableText(
                        info.userCode,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 28,
                          letterSpacing: 3,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        info.verificationUri,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.blue),
                      ),
                      if (hasCountdown) ...[
                        const SizedBox(height: 8),
                        Text(
                          '코드 만료까지 ${_formatSeconds(remainingSeconds)}',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color:
                                remainingSeconds <= 20
                                    ? Colors.red
                                    : Colors.black87,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: _copyUserCode,
                              icon: const Icon(Icons.copy),
                              label: const Text('코드 복사'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: ElevatedButton.icon(
                              onPressed: _openVerificationUri,
                              icon: const Icon(Icons.open_in_browser),
                              label: const Text('브라우저 열기'),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (isBusy) ...[
                      LinearProgressIndicator(
                        value:
                            _phase == _LoginPhase.pollingToken
                                ? pollingProgress
                                : null,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        _phase == _LoginPhase.requestingCode
                            ? '디바이스 코드 요청 중...'
                            : _phase == _LoginPhase.validatingApiKey
                            ? 'API key 검증 중...'
                            : hasCountdown
                            ? '승인 대기 중... (남은 시간 ${_formatSeconds(remainingSeconds)})'
                            : '승인 대기 중... (승인 완료 시 자동 로그인)',
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (_errorMessage != null) ...[
                      Text(
                        _errorMessage!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.red),
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (_phase == _LoginPhase.idle)
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          ElevatedButton.icon(
                            onPressed: !isBusy ? _startDeviceFlow : null,
                            icon: const Icon(Icons.login),
                            label: const Text('GitHub 로그인 시작'),
                          ),
                          const SizedBox(height: 8),
                          OutlinedButton.icon(
                            onPressed: !isBusy ? _startQrLogin : null,
                            icon: const Icon(Icons.qr_code_scanner),
                            label: const Text('QR 코드 로그인'),
                          ),
                        ],
                      )
                    else if (_phase != _LoginPhase.validatingApiKey)
                      OutlinedButton.icon(
                        onPressed: _cancelPolling,
                        icon: const Icon(Icons.close),
                        label: const Text('취소'),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _GitHubServerAddressPage extends StatefulWidget {
  const _GitHubServerAddressPage({required this.initialServerUrl});

  final String? initialServerUrl;

  @override
  State<_GitHubServerAddressPage> createState() =>
      _GitHubServerAddressPageState();
}

class _GitHubServerAddressPageState extends State<_GitHubServerAddressPage> {
  late final TextEditingController _serverController;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _serverController = TextEditingController(
      text: widget.initialServerUrl ?? '',
    );
  }

  @override
  void dispose() {
    _serverController.dispose();
    super.dispose();
  }

  void _submit() {
    setState(() {
      _errorMessage = null;
    });

    final input = _serverController.text.trim();
    if (input.isEmpty) {
      setState(() {
        _errorMessage = '서버 주소를 입력해주세요.';
      });
      return;
    }

    try {
      final normalized = AuthConfig.normalizeServerUrl(input);
      Navigator.of(context).pop(normalized);
    } catch (e) {
      setState(() {
        _errorMessage = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('서버 주소 입력')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Text(
                        'GitHub 로그인에 사용할 서버 주소를 입력하세요.',
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _serverController,
                        keyboardType: TextInputType.url,
                        decoration: const InputDecoration(
                          labelText: '서버 주소',
                          hintText: 'console.yyt.life',
                          border: OutlineInputBorder(),
                        ),
                        autofocus: true,
                      ),
                      const SizedBox(height: 12),
                      if (_errorMessage != null) ...[
                        Text(
                          _errorMessage!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Colors.red),
                        ),
                        const SizedBox(height: 12),
                      ],
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(
                              onPressed: () => Navigator.of(context).pop(),
                              child: const Text('취소'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: FilledButton(
                              onPressed: _submit,
                              child: const Text('다음'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _QrScannerPage extends StatefulWidget {
  const _QrScannerPage({required this.initialServerUrl});

  final String? initialServerUrl;

  @override
  State<_QrScannerPage> createState() => _QrScannerPageState();
}

class _QrScannerPageState extends State<_QrScannerPage> {
  final MobileScannerController _controller = MobileScannerController();
  bool _handled = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _handleDetection(BarcodeCapture capture) {
    if (_handled) return;

    String? payload;
    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue;
      if (value != null && value.trim().isNotEmpty) {
        payload = value;
        break;
      }
    }

    if (payload == null) return;

    _handled = true;
    Navigator.of(context).pop(payload);
  }

  Future<void> _openManualLoginPage() async {
    final value = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder:
            (_) => _ManualApiKeyLoginPage(
              initialServerUrl: widget.initialServerUrl,
            ),
      ),
    );

    if (!mounted || value == null || value.isEmpty || _handled) return;
    _handled = true;
    Navigator.of(context).pop(value);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('QR 코드 로그인')),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(controller: _controller, onDetect: _handleDetection),
          Align(
            alignment: Alignment.bottomCenter,
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Card(
                color: Colors.black87,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text(
                        '서버 주소가 포함된 API key QR 코드를 스캔하세요.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.white),
                      ),
                      const SizedBox(height: 8),
                      TextButton(
                        onPressed: _openManualLoginPage,
                        child: const Text('서버/API key 직접 입력'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ManualApiKeyLoginPage extends StatefulWidget {
  const _ManualApiKeyLoginPage({required this.initialServerUrl});

  final String? initialServerUrl;

  @override
  State<_ManualApiKeyLoginPage> createState() => _ManualApiKeyLoginPageState();
}

class _ManualApiKeyLoginPageState extends State<_ManualApiKeyLoginPage> {
  late final TextEditingController _serverController;
  final TextEditingController _apiKeyController = TextEditingController();
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _serverController = TextEditingController(
      text: widget.initialServerUrl ?? '',
    );
  }

  @override
  void dispose() {
    _serverController.dispose();
    _apiKeyController.dispose();
    super.dispose();
  }

  void _submit() {
    setState(() {
      _errorMessage = null;
    });

    final serverInput = _serverController.text.trim();
    final apiKeyInput = _apiKeyController.text.trim();
    if (serverInput.isEmpty || apiKeyInput.isEmpty) {
      setState(() {
        _errorMessage = '서버 주소와 API key를 모두 입력해주세요.';
      });
      return;
    }

    try {
      final normalizedServer = AuthConfig.normalizeServerUrl(serverInput);
      final keyPattern = RegExp(r'^yyt_[0-9a-f]{48}$');
      if (!keyPattern.hasMatch(apiKeyInput)) {
        throw const FormatException('API key 형식이 올바르지 않습니다.');
      }

      Navigator.of(context).pop(
        jsonEncode({
          'type': 'yyt_api_key',
          'server': normalizedServer,
          'apiKey': apiKeyInput,
        }),
      );
    } catch (e) {
      setState(() {
        _errorMessage = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('서버/API key 직접 입력')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextField(
                        controller: _serverController,
                        keyboardType: TextInputType.url,
                        decoration: const InputDecoration(
                          labelText: '서버 주소',
                          hintText: 'console.yyt.life',
                          border: OutlineInputBorder(),
                        ),
                        autofocus: true,
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _apiKeyController,
                        decoration: const InputDecoration(
                          labelText: 'API key',
                          hintText: 'yyt_...',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      if (_errorMessage != null) ...[
                        Text(
                          _errorMessage!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Colors.red),
                        ),
                        const SizedBox(height: 12),
                      ],
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(
                              onPressed: () => Navigator.of(context).pop(),
                              child: const Text('취소'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: FilledButton(
                              onPressed: _submit,
                              child: const Text('로그인'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
