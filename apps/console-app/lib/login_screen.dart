import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/auth/auth_diagnostics.dart';
import 'package:yyt_console/auth/auth_state.dart';

/// The QR payload the console's "App login" page renders:
/// `{"type":"yyt_api_key","apiKey":"yyt_…","server":"https://…"}`.
class ApiKeyLoginPayload {
  const ApiKeyLoginPayload({required this.server, required this.apiKey});

  final String server;
  final String apiKey;

  static final _keyPattern = RegExp(r'^yyt_[0-9a-f]{48}$');

  static ApiKeyLoginPayload parse(String payload) {
    final trimmed = payload.trim();
    if (trimmed.isEmpty) {
      throw const FormatException('빈 QR 코드입니다.');
    }
    Object? decoded;
    try {
      decoded = jsonDecode(trimmed);
    } on FormatException {
      throw const FormatException(
        '지원되지 않는 QR 코드입니다. 콘솔의 App login 화면에서 만든 QR 코드를 스캔해주세요.',
      );
    }
    if (decoded is Map<String, dynamic> &&
        decoded['type'] == 'yyt_api_key' &&
        decoded['apiKey'] is String &&
        decoded['server'] is String) {
      final apiKey = (decoded['apiKey'] as String).trim();
      if (!_keyPattern.hasMatch(apiKey)) {
        throw const FormatException('API key 형식이 올바르지 않습니다.');
      }
      return ApiKeyLoginPayload(
        server: AuthConfig.normalizeServerUrl(decoded['server'] as String),
        apiKey: apiKey,
      );
    }
    throw const FormatException(
      '지원되지 않는 QR 코드입니다. 콘솔의 App login 화면에서 만든 QR 코드를 스캔해주세요.',
    );
  }
}

/// Scans a login QR and adds it as a profile. Used both as the first screen
/// (no profiles yet) and as "새 profile 추가" from the profile menu, in which
/// case it is pushed and pops when done.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.authState, this.pushed = false});

  final AuthState authState;
  final bool pushed;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  bool _busy = false;
  String? _errorMessage;

  Future<void> _scan() async {
    if (_busy) return;
    setState(() => _errorMessage = null);
    final payload = await Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => const QrScannerPage()));
    if (!mounted || payload == null || payload.trim().isEmpty) return;

    setState(() => _busy = true);
    try {
      final parsed = ApiKeyLoginPayload.parse(payload);
      await widget.authState.addProfile(
        server: parsed.server,
        apiKey: parsed.apiKey,
      );
      // AuthState already notified the root, which pops back to the shell
      // when the active profile changes; pop only if this route survived.
      if (widget.pushed &&
          mounted &&
          (ModalRoute.of(context)?.isCurrent ?? false)) {
        Navigator.of(context).pop(true);
      }
    } catch (e, st) {
      AuthDiagnosticLogger.logUnhandled(
        scope: 'ui:qr_login',
        error: e,
        stackTrace: st,
      );
      if (!mounted) return;
      setState(() {
        _errorMessage =
            e is AuthDiagnosticError ? e.message : '로그인 실패: ${e.toString()}';
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(widget.pushed ? '새 profile 추가' : '잉여톤 로그인')),
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
                    Center(
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(16),
                        child: Image.asset(
                          'assets/icon.png',
                          width: 72,
                          height: 72,
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'QR 코드로 로그인',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 12),
                    const _Step(
                      n: 1,
                      text: '컴퓨터에서 yyt console 에 GitHub 계정으로 로그인합니다.',
                    ),
                    const _Step(
                      n: 2,
                      text:
                          '왼쪽 메뉴의 App login 에서 QR 코드를 만듭니다. '
                          'QR 은 한 번만 표시되며 새 API 토큰이 발급됩니다.',
                    ),
                    const _Step(n: 3, text: '아래 버튼으로 그 QR 코드를 스캔합니다.'),
                    const SizedBox(height: 16),
                    if (_errorMessage != null) ...[
                      Text(
                        _errorMessage!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.red),
                      ),
                      const SizedBox(height: 12),
                    ],
                    FilledButton.icon(
                      onPressed: _busy ? null : _scan,
                      icon:
                          _busy
                              ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                              : const Icon(Icons.qr_code_scanner_rounded),
                      label: const Text('QR 코드 스캔'),
                    ),
                    if (widget.pushed) ...[
                      const SizedBox(height: 8),
                      TextButton(
                        onPressed:
                            _busy ? null : () => Navigator.of(context).pop(),
                        child: const Text('취소'),
                      ),
                    ],
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

class _Step extends StatelessWidget {
  const _Step({required this.n, required this.text});

  final int n;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 12,
            backgroundColor: CatalogPalette.ocean,
            child: Text(
              '$n',
              style: const TextStyle(color: Colors.white, fontSize: 12),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(child: Text(text)),
        ],
      ),
    );
  }
}

/// Camera view; pops with the first QR payload it sees.
class QrScannerPage extends StatefulWidget {
  const QrScannerPage({super.key});

  @override
  State<QrScannerPage> createState() => _QrScannerPageState();
}

class _QrScannerPageState extends State<QrScannerPage> {
  final MobileScannerController _controller = MobileScannerController();
  bool _handled = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _handleDetection(BarcodeCapture capture) {
    if (_handled) return;
    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue;
      if (value != null && value.trim().isNotEmpty) {
        _handled = true;
        if (mounted) Navigator.of(context).pop(value);
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('QR 코드 스캔')),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(controller: _controller, onDetect: _handleDetection),
          const Align(
            alignment: Alignment.bottomCenter,
            child: Padding(
              padding: EdgeInsets.all(20),
              child: Card(
                color: Colors.black87,
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: Text(
                    '콘솔의 App login 화면에 표시된 QR 코드를 비춰주세요.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white),
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
