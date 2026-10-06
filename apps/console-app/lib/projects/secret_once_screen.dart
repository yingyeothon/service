import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/projects/channel_models.dart';
import 'package:yyt_console/secure_window.dart';
import 'package:flutter/material.dart';

/// Shows a channel's one-time credential (auth `secret`, topic/match
/// `apiKey`) right after creation, then replaces itself with the channel
/// screen so the value leaves the navigation stack.
///
/// The window is marked secure before the first frame that renders the value
/// and unmarked on dispose; the value is plain [Text] (no selection toolbar,
/// no share), copied only through [SecureWindow.copySensitive], which wipes
/// it from the clipboard after [sensitiveClipboardTtl] if it is still there.
/// It is never stored or logged.
class SecretOnceScreen extends StatefulWidget {
  const SecretOnceScreen({
    super.key,
    required this.created,
    required this.detailBuilder,
    this.secureWindow = const PlatformSecureWindow(),
    this.clipboardTtl = sensitiveClipboardTtl,
  });

  final CreatedChannel created;

  /// The channel screen that replaces this one.
  final WidgetBuilder detailBuilder;
  final SecureWindow secureWindow;
  final Duration clipboardTtl;

  @override
  State<SecretOnceScreen> createState() => _SecretOnceScreenState();
}

class _SecretOnceScreenState extends State<SecretOnceScreen> {
  bool _secured = false;
  bool _copied = false;
  bool _leaving = false;

  @override
  void initState() {
    super.initState();
    _secure();
  }

  Future<void> _secure() async {
    await widget.secureWindow.setSecure(true);
    if (mounted) setState(() => _secured = true);
  }

  @override
  void dispose() {
    // FLAG_SECURE covers the whole single-activity app: a missed clear would
    // blank every later screenshot of every screen.
    widget.secureWindow.setSecure(false);
    super.dispose();
  }

  Future<void> _copy(String value) async {
    await widget.secureWindow.copySensitive(
      value,
      clearAfter: widget.clipboardTtl,
    );
    if (!mounted) return;
    setState(() => _copied = true);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          '복사했습니다. 클립보드는 ${widget.clipboardTtl.inSeconds}초 뒤에 비웁니다.',
        ),
      ),
    );
  }

  Future<void> _leave() async {
    if (_leaving) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('이 화면을 떠날까요?'),
        content: Text(
          '${widget.created.credentialLabel}은(는) 지금 한 번만 볼 수 있습니다. '
          '안전한 곳에 보관했는지 확인하세요.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('계속 보기'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('보관했습니다'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    _leaving = true;
    // Replaced, not pushed: the route holding the value leaves the stack.
    Navigator.of(
      context,
    ).pushReplacement(MaterialPageRoute<void>(builder: widget.detailBuilder));
  }

  @override
  Widget build(BuildContext context) {
    final created = widget.created;
    final value = created.credential ?? '';
    final label = created.credentialLabel;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _leave();
      },
      child: Scaffold(
        appBar: AppBar(
          automaticallyImplyLeading: false,
          leading: IconButton(
            tooltip: '닫기',
            icon: const Icon(Icons.close_rounded),
            onPressed: _leave,
          ),
          title: Text('${created.channel.name} · $label'),
        ),
        body: !_secured
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: CatalogPalette.sunrise,
                      borderRadius: BorderRadius.circular(18),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '$label — 한 번만 보여 줍니다',
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          '지금 복사해 안전한 곳에 보관하세요. 나중에 다시 볼 수 없고, '
                          '잃어버리면 웹 콘솔에서 재발급해야 합니다.',
                        ),
                        const SizedBox(height: 12),
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: CatalogPalette.shell,
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Text(
                            value,
                            key: const ValueKey('secret-value'),
                            style: const TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 15,
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),
                        FilledButton.tonalIcon(
                          onPressed: () => _copy(value),
                          icon: const Icon(Icons.copy_rounded),
                          label: Text(_copied ? '다시 복사' : '$label 복사'),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: _leave,
                    child: const Text('보관했습니다 · 채널 보기'),
                  ),
                ],
              ),
      ),
    );
  }
}
