import 'dart:convert';

import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/format_time.dart';
import 'package:yyt_console/projects/limit_models.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:flutter/material.dart';

DateTime _at(int sec) =>
    DateTime.fromMillisecondsSinceEpoch(sec * 1000, isUtc: true);

/// A scope's limits (docs/decisions.md *Limit requests (soft/hard)*): usage,
/// the effective value and the ceiling per key, the pending requests, and —
/// for a seated member — a request button per row. Mirrors the SPA's
/// Limits section; the registry stays on the server (every row carries its
/// unit and values). Against an older console that has no `/limits`, a
/// hint, never an error.
class LimitsSection extends StatefulWidget {
  const LimitsSection({
    super.key,
    required this.api,
    required this.scopeKind,
    required this.scopeId,
    required this.team,
    required this.currentLogin,
    required this.onUnauthorized,
    this.reloadToken,
  });

  final ProjectsApi api;
  final String scopeKind;
  final String scopeId;
  final Team team;
  final String? currentLogin;
  final Future<void> Function() onUnauthorized;

  /// Changes when the host reloaded (pull-to-refresh, an extend): the card
  /// re-reads, since its state survives the host's rebuild.
  final Object? reloadToken;

  @override
  State<LimitsSection> createState() => _LimitsSectionState();
}

class _LimitsSectionState extends State<LimitsSection> {
  bool _loading = true;
  bool _unsupported = false;
  String? _error;
  LimitsView? _view;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(LimitsSection old) {
    super.didUpdateWidget(old);
    if (old.reloadToken != widget.reloadToken ||
        old.scopeId != widget.scopeId) {
      _load();
    }
  }

  Future<void> _load() async {
    if (mounted && _error != null) setState(() => _loading = true);
    try {
      final view = await widget.api.getLimits(widget.scopeKind, widget.scopeId);
      if (!mounted) return;
      setState(() {
        _view = view;
        _error = null;
        _unsupported = false;
        _loading = false;
      });
    } on UnauthorizedException catch (e) {
      await widget.onUnauthorized();
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        // An older console has no `/limits`: nothing to show, not a fault.
        _unsupported = e.status == 404;
        _error = _unsupported ? null : e.message;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _request(LimitRow row) async {
    final result = await showDialog<_RequestInput>(
      context: context,
      builder: (_) => LimitRequestDialog(row: row),
    );
    if (result == null || !mounted) return;
    await _run(() async {
      try {
        final r = await widget.api.createLimitRequest(
          kind: widget.scopeKind,
          id: widget.scopeId,
          key: row.key,
          value: result.value,
          reason: result.reason,
        );
        if (!mounted) return;
        showSnack(
          context,
          '${limitLabel(r.key)} 한도 요청을 보냈습니다. 플랫폼 관리자가 검토합니다.',
        );
      } on ApiException catch (e) {
        if (!mounted) return;
        final retry = e.retryAt;
        if (e.status == 429 && retry != null) {
          showSnack(
            context,
            '거절되거나 취소된 요청 뒤에는 7일 동안 같은 한도를 다시 요청할 수 없습니다. '
            '${formatLocalTime(retry)} 이후에 다시 시도하세요.',
          );
          return;
        }
        if (e.status == 429) {
          showSnack(context, '대기 중인 요청이 너무 많습니다. 결정을 기다린 뒤 다시 시도하세요.');
          return;
        }
        final d = e.limitDetails;
        if (e.status == 400 && d != null) {
          final next = d['next'];
          showSnack(
            context,
            next is num
                ? '요청 가능한 값은 ${formatLimit(row.unit, next.toInt())}뿐입니다. 화면을 새로 읽습니다.'
                : '지금은 이 한도를 요청할 수 없습니다 (모든 슬롯을 다 쓴 뒤에, 상한 아래에서만). 화면을 새로 읽습니다.',
          );
          await _load();
          return;
        }
        if (e.status == 409) {
          showSnack(context, '이미 대기 중인 요청이 있거나 더 올릴 수 없는 한도입니다. 화면을 새로 읽습니다.');
          await _load();
          return;
        }
        rethrow;
      }
      await _load();
    });
  }

  Future<void> _cancel(LimitRequest r) async {
    final ok = await confirmDestructive(
      context,
      title: '요청을 철회할까요?',
      message: '철회하면 7일 동안 같은 한도를 다시 요청할 수 없습니다.',
      confirmLabel: '요청 철회',
      cancelLabel: '요청 유지',
    );
    if (!ok || !mounted) return;
    await _run(() async {
      await widget.api.cancelLimitRequest(r.id);
      if (!mounted) return;
      showSnack(context, '요청을 철회했습니다.');
      await _load();
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } on UnauthorizedException {
      await widget.onUnauthorized();
    } catch (e) {
      if (mounted) showSnack(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  bool _mayCancel(LimitRequest r) =>
      widget.team.role == 'owner' ||
      (widget.team.canWrite &&
          widget.currentLogin != null &&
          r.createdByLogin == widget.currentLogin);

  @override
  Widget build(BuildContext context) {
    final v = _view;
    return SectionCard(
      title: '한도',
      children: [
        if (_loading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: LinearProgressIndicator(semanticsLabel: '한도 불러오는 중'),
          )
        else if (_unsupported)
          const HintText('이 콘솔 버전은 한도 조회를 지원하지 않습니다.')
        else if (_error != null)
          NoticeCard(
            icon: Icons.error_outline_rounded,
            tone: ChipTone.danger,
            text: _error!,
            action: TextButton(onPressed: _load, child: const Text('다시 시도')),
          )
        else if (v != null) ...[
          if (v.limits.isEmpty)
            const HintText('적용되는 한도가 없습니다.')
          else
            const HintText(
              '사용량 / 지금의 한도 · 상한. 팀 멤버는 플랫폼 관리자에게 상한까지 더 요청할 수 있습니다.',
            ),
          for (final row in v.limits) _row(context, v, row),
          if (v.pending.isNotEmpty) ...[
            const Divider(height: 20),
            Text('대기 중인 요청', style: Theme.of(context).textTheme.titleSmall),
            for (final r in v.pending) _pending(context, r),
          ],
        ],
      ],
    );
  }

  Widget _row(BuildContext context, LimitsView v, LimitRow row) {
    final theme = Theme.of(context);
    final lifetime = row.key == 'channel.lifetime';
    final noExpiry =
        lifetime && v.expiresAt != null && isNoExpiry(_at(v.expiresAt!));
    final line = lifetime
        ? (noExpiry || row.effective == null
              ? '만료 없음'
              : '만료 ${v.expiresAt == null ? '—' : formatLocalTime(_at(v.expiresAt!))} · '
                    '최대 ${formatLimit(row.unit, row.effective)} · 무기한 요청 가능')
        : '${row.usage == null ? '—' : formatLimit(row.unit, row.usage)} / '
              '${formatLimit(row.unit, row.effective)} · '
              '${row.hard == null ? '상한 없음' : '상한 ${formatLimit(row.unit, row.hard)}'}';
    final pendingHere = v.pending.any((p) => p.key == row.key);
    final offer =
        widget.team.canWrite && row.canRequest && !pendingHere && !noExpiry;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(row.label, style: theme.textTheme.labelLarge),
                    if (row.override != null)
                      const StatusChip(label: '승인됨', tone: ChipTone.ok),
                    if (row.overLimit)
                      const StatusChip(label: '한도 초과', tone: ChipTone.warn),
                  ],
                ),
                Text(line, style: theme.textTheme.bodySmall),
                if (row.override?.expiresAt case final e?)
                  HintText('승인 만료 ${formatLocalTime(_at(e))}'),
                if (row.step != null && row.next == null && !row.atCeiling)
                  const HintText('모든 슬롯을 다 쓰면 다음 단계를 요청할 수 있습니다.'),
              ],
            ),
          ),
          if (offer)
            Semantics(
              label: '${row.label} 한도 요청',
              child: TextButton(
                onPressed: _busy ? null : () => _request(row),
                child: const Text('요청'),
              ),
            ),
        ],
      ),
    );
  }

  Widget _pending(BuildContext context, LimitRequest r) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              '${limitLabel(r.key)} → ${formatLimit(r.unit, r.requestedValue)} · '
              '${r.createdByLogin ?? r.createdBy} · ${formatRelative(_at(r.createdAt))}',
              style: theme.textTheme.bodySmall,
            ),
          ),
          if (_mayCancel(r))
            Semantics(
              label: '${limitLabel(r.key)} 요청 철회',
              child: TextButton(
                onPressed: _busy ? null : () => _cancel(r),
                child: const Text('철회'),
              ),
            ),
        ],
      ),
    );
  }
}

class _RequestInput {
  const _RequestInput(this.value, this.reason);
  final int? value;
  final String reason;
}

/// The value and reason of one request. A stepped key's value is fixed to
/// `next`, a lifetime is fixed to "no expiry"; sizes take binary units.
class LimitRequestDialog extends StatefulWidget {
  const LimitRequestDialog({super.key, required this.row});

  final LimitRow row;

  @override
  State<LimitRequestDialog> createState() => _LimitRequestDialogState();
}

class _LimitRequestDialogState extends State<LimitRequestDialog> {
  late final TextEditingController _value;
  final _reason = TextEditingController();
  String? _valueError;
  String? _reasonError;

  LimitRow get row => widget.row;
  bool get fixed => row.step != null || row.hard == null;

  @override
  void initState() {
    super.initState();
    _value = TextEditingController();
  }

  @override
  void dispose() {
    _value.dispose();
    _reason.dispose();
    super.dispose();
  }

  void _submit() {
    final int? value;
    if (row.hard == null) {
      value = null;
    } else if (row.step != null) {
      value = row.next;
    } else {
      value = parseLimitInput(row.unit, _value.text);
      if (value == null) {
        setState(
          () => _valueError = row.unit == 'bytes'
              ? '예: 256MiB, 3GiB'
              : '정수를 입력하세요.',
        );
        return;
      }
    }
    final problem = limitValueProblem(row, value);
    if (problem != null) {
      setState(() => _valueError = problem);
      return;
    }
    final reason = _reason.text.trim();
    if (reason.isEmpty) {
      setState(() => _reasonError = '이유를 적어주세요.');
      return;
    }
    // The server bounds the reason in UTF-8 bytes; Hangul is three each.
    if (utf8.encode(reason).length > 2048) {
      setState(() => _reasonError = '이유는 2 KB 이하입니다 (한글은 한 글자에 3바이트).');
      return;
    }
    Navigator.of(context).pop(_RequestInput(value, reason));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('${row.label} 한도 요청'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          HintText(
            '지금 ${formatLimit(row.unit, row.effective)} · 상한 ${formatLimit(row.unit, row.hard)}',
          ),
          if (row.hard == null)
            const HintText('이 한도는 "무제한"으로만 요청할 수 있습니다.')
          else if (row.step != null)
            HintText(
              '요청 값: ${formatLimit(row.unit, row.next)} (한 번에 ${row.step}씩 올립니다).',
            )
          else
            TextField(
              controller: _value,
              autofocus: true,
              keyboardType: row.unit == 'count'
                  ? TextInputType.number
                  : TextInputType.text,
              decoration: InputDecoration(
                labelText: '요청 값',
                hintText: row.unit == 'bytes' ? '예: 256MiB' : '예: 50000',
                errorText: _valueError,
              ),
              onChanged: (_) => setState(() => _valueError = null),
            ),
          const SizedBox(height: 8),
          TextField(
            controller: _reason,
            autofocus: fixed,
            maxLines: 3,
            decoration: InputDecoration(
              labelText: '이유',
              hintText: '관리자가 읽습니다 (2 KB 이하)',
              errorText: _reasonError,
            ),
            onChanged: (_) => setState(() => _reasonError = null),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('닫기'),
        ),
        FilledButton(onPressed: _submit, child: const Text('요청 보내기')),
      ],
    );
  }
}
