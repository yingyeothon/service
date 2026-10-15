import 'package:yyt_console/projects/site_password.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:flutter/material.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:yyt_console/projects/site_models.dart';

class SiteAccessSection extends StatefulWidget {
  const SiteAccessSection({
    super.key,
    required this.site,
    required this.api,
    required this.canWrite,
    required this.reload,
    required this.onUnauthorized,
  });
  final Site site;
  final ProjectsApi api;
  final bool canWrite;
  final Future<void> Function() reload;
  final Future<void> Function() onUnauthorized;
  @override
  State<SiteAccessSection> createState() => _SiteAccessSectionState();
}

class _SiteAccessSectionState extends State<SiteAccessSection> {
  bool _approved = false, _admin = false, _busy = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(SiteAccessSection old) {
    super.didUpdateWidget(old);
    if (old.site != widget.site) _load();
  }

  Future<void> _load() async {
    try {
      final limits = await widget.api.getLimits('site', widget.site.id);
      final admin = await widget.api.isPlatformAdmin();
      if (mounted) {
        setState(() {
          _approved = limits.limits.any(
            (l) => l.key == 'site.basicAuth' && l.effective == 1,
          );
          _admin = admin;
        });
      }
    } on UnauthorizedException {
      await widget.onUnauthorized();
    } catch (_) {
      if (mounted) {
        setState(() {
          _approved = false;
          _admin = false;
          _error = '권한을 불러오지 못했습니다. 새로고침하세요.';
        });
      }
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on UnauthorizedException {
      await widget.onUnauthorized();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
    await widget.reload();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _edit() async {
    final body = await showDialog<Map<String, Object?>>(
      context: context,
      builder: (_) => _SitePasswordDialog(
        username: widget.site.access?['username'] as String? ?? '',
      ),
    );
    if (body != null && mounted) {
      await _run(() => widget.api.setSiteAuth(widget.site.id, body));
    }
  }

  Future<void> _suspend() async {
    final reason = TextEditingController();
    final suspended = widget.site.access?['suspended'] == true;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(suspended ? '접근 재개' : '접근 중단'),
        content: TextField(
          controller: reason,
          maxLength: 500,
          decoration: const InputDecoration(labelText: '사유 (필수)'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('취소'),
          ),
          TextButton(
            onPressed: () {
              if (reason.text.trim().isNotEmpty) Navigator.pop(context, true);
            },
            child: const Text('확인'),
          ),
        ],
      ),
    );
    final text = reason.text;
    reason.dispose();
    if (ok == true && mounted) {
      await _run(
        () => widget.api.setSiteSuspension(widget.site.id, !suspended, text),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final access = widget.site.access!;
    final suspended = access['suspended'] == true;
    return SectionCard(
      title: '사이트 접근',
      children: [
        Text(
          suspended
              ? '플랫폼 어드민이 접근을 중단했습니다.'
              : access['mode'] == 'basic'
              ? 'Basic Auth 설정됨'
              : '공개 사이트',
        ),
        Text(
          _approved
              ? 'Basic Auth 사용이 승인되었습니다.'
              : '아래 한도에서 Basic Auth를 신청하고 어드민 승인을 받으세요.',
        ),
        const HintText('변경은 CDN에 순차 반영됩니다. 이미 다운로드된 파일은 회수할 수 없습니다.'),
        if (_error != null) Text(_error!),
        if (widget.canWrite && _approved)
          OutlinedButton(
            onPressed:
                _busy ||
                    suspended ||
                    widget.site.busy ||
                    access['available'] != true
                ? null
                : _edit,
            child: const Text('Basic Auth 설정'),
          ),
        if (widget.canWrite && access['mode'] == 'basic')
          OutlinedButton(
            onPressed: _busy || suspended
                ? null
                : () async {
                    final ok = await confirmDestructive(
                      context,
                      title: '사이트를 공개할까요?',
                      message: '누구나 인증 없이 파일을 볼 수 있게 됩니다.',
                      confirmLabel: '공개 전환',
                    );
                    if (ok && mounted) {
                      await _run(
                        () => widget.api.setSiteAuth(widget.site.id, {
                          'mode': 'public',
                        }),
                      );
                    }
                  },
            child: const Text('공개 전환'),
          ),
        if ((widget.canWrite || _admin) && access['sync'] == 'pending')
          OutlinedButton(
            onPressed: _busy
                ? null
                : () => _run(() => widget.api.syncSiteAccess(widget.site.id)),
            child: const Text('정책 동기화 재시도'),
          ),
        if (_admin)
          OutlinedButton(
            onPressed: _busy ? null : _suspend,
            child: Text(suspended ? '접근 재개' : '접근 중단'),
          ),
      ],
    );
  }
}

class _SitePasswordDialog extends StatefulWidget {
  const _SitePasswordDialog({required this.username});
  final String username;
  @override
  State<_SitePasswordDialog> createState() => _SitePasswordDialogState();
}

class _SitePasswordDialogState extends State<_SitePasswordDialog> {
  late final TextEditingController _username = TextEditingController(
    text: widget.username,
  );
  final _passInput = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  @override
  void dispose() {
    _username.dispose();
    _passInput.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Basic Auth 설정'),
    scrollable: true,
    content: Form(
      key: _formKey,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('전용 주소에서만 열립니다. 경로 주소는 차단됩니다. 변경은 CDN에 순차 반영됩니다.'),
          TextFormField(
            controller: _username,
            decoration: const InputDecoration(labelText: 'ID'),
            validator: (v) =>
                RegExp(r'^[\x21-\x39\x3b-\x7e]{1,64}$').hasMatch(v ?? '')
                ? null
                : '공백·콜론 없이 1–64자로 입력하세요.',
          ),
          TextFormField(
            controller: _passInput,
            obscureText: true,
            enableSuggestions: false,
            autocorrect: false,
            decoration: const InputDecoration(
              labelText: '새 비밀번호',
              helperText: '4글자 이상. 강도 등급은 참고용입니다.',
            ),
            validator: (v) => sitePasswordIssue(v ?? ''),
          ),
          ValueListenableBuilder<TextEditingValue>(
            valueListenable: _passInput,
            builder: (context, input, _) {
              if (input.text.isEmpty) return const SizedBox.shrink();
              final grade = sitePasswordStrength(input.text);
              return Semantics(
                liveRegion: true,
                label: 'Password strength: $grade',
                child: ExcludeSemantics(
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: StatusChip(
                      label: grade,
                      tone: grade == 'Too easy'
                          ? ChipTone.danger
                          : grade == 'Medium'
                          ? ChipTone.warn
                          : ChipTone.ok,
                    ),
                  ),
                ),
              );
            },
          ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('취소'),
      ),
      TextButton(
        onPressed: () {
          if (_formKey.currentState!.validate()) {
            Navigator.pop(context, <String, Object?>{
              'mode': 'basic',
              'username': _username.text,
              'password': _passInput.text,
            });
          }
        },
        child: const Text('저장'),
      ),
    ],
  );
}
