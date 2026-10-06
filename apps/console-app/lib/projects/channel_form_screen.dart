import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/channel_config_fields.dart';
import 'package:yyt_console/projects/channel_config_form.dart';
import 'package:yyt_console/projects/channel_models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:flutter/material.dart';

/// Create (with a kind picker) pops a [CreatedChannel] — the only object that
/// ever holds the one-time credential; edit (kind fixed) pops the updated
/// [Channel], or nothing when nothing changed.
class ChannelFormScreen extends StatefulWidget {
  const ChannelFormScreen.create({
    super.key,
    required this.api,
    required String this.projectId,
    required this.onUnauthorized,
  }) : existing = null;

  const ChannelFormScreen.edit({
    super.key,
    required this.api,
    required Channel this.existing,
    required this.onUnauthorized,
  }) : projectId = null;

  final ProjectsApi api;
  final String? projectId;
  final Channel? existing;
  final Future<void> Function() onUnauthorized;

  @override
  State<ChannelFormScreen> createState() => _ChannelFormScreenState();
}

class _ChannelFormScreenState extends State<ChannelFormScreen> {
  late String _kind = widget.existing?.kind ?? 'auth';
  late final ChannelFormState? _initial = widget.existing == null
      ? null
      : ChannelFormState.fromChannel(
          kind: widget.existing!.kind,
          name: widget.existing!.name,
          config: widget.existing!.config,
        );
  late final ChannelFormState _form = _initial?.copy() ?? ChannelFormState();
  late final _name = TextEditingController(text: _form.name);

  /// The project's auth channels; null while loading (or when the channel
  /// has no project to ask).
  List<Channel>? _auths;
  bool _busy = false;
  String? _error;

  bool get _editing => widget.existing != null;
  String? get _projectId => widget.projectId ?? widget.existing?.projectId;

  @override
  void initState() {
    super.initState();
    _loadAuths();
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _loadAuths() async {
    final projectId = _projectId;
    if (projectId == null) return;
    try {
      final auths = await widget.api.listChannels(projectId, kind: 'auth');
      if (mounted) setState(() => _auths = auths);
    } on UnauthorizedException {
      await widget.onUnauthorized();
    } catch (e) {
      if (mounted) setState(() => _error = '인증 채널 목록을 불러오지 못했습니다. $e');
    }
  }

  /// topic/match/lobby/q hang off an auth channel of the same project.
  bool get _needsAuth =>
      !_editing && _kind != 'auth' && _auths != null && _auths!.isEmpty;

  Future<void> _submit() async {
    _form.name = _name.text;
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = '이름을 입력하세요.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final existing = widget.existing;
      if (existing == null) {
        final config = buildChannelConfig(_kind, _form);
        final created = await widget.api.createChannel(
          widget.projectId!,
          kind: _kind,
          name: name,
          config: config,
        );
        if (mounted) Navigator.of(context).pop(created);
        return;
      }
      final body = buildChannelEdit(
        existing.kind,
        storedName: existing.name,
        storedConfig: existing.config,
        initial: _initial!,
        form: _form,
      );
      if (body.isEmpty) {
        if (mounted) Navigator.of(context).pop();
        return;
      }
      final updated = await widget.api.updateChannel(
        existing.id,
        name: body['name'] as String?,
        config: body['config'],
      );
      if (mounted) Navigator.of(context).pop(updated);
    } on ChannelFormError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on UnauthorizedException {
      await widget.onUnauthorized();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final existing = widget.existing;
    return Scaffold(
      appBar: AppBar(
        title: Text(existing == null ? '새 채널' : '${existing.name} · 편집'),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: [
          if (existing == null)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: DropdownButtonFormField<String>(
                initialValue: _kind,
                isExpanded: true,
                decoration: const InputDecoration(labelText: '종류'),
                items: [
                  for (final k in channelKinds)
                    DropdownMenuItem(
                      value: k,
                      child: Text(
                        channelKindDescription(k),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: (v) => setState(() {
                  _kind = v ?? 'auth';
                  _error = null;
                }),
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                children: [
                  StatusChip(label: existing.kind, tone: ChipTone.accent),
                  const SizedBox(width: 8),
                  Expanded(
                    child: HintText(channelKindDescription(existing.kind)),
                  ),
                ],
              ),
            ),
          if (existing == null)
            const HintText(
              'auth 채널은 플레이어 토큰을 발급하고, topic·match·lobby·q 채널은 auth 채널에 '
              '연결됩니다. 시크릿은 만든 직후 한 번만 보여 줍니다.',
            ),
          if (_needsAuth)
            NoticeCard(
              text: 'topic/match/lobby/q 채널은 이 프로젝트의 auth 채널이 필요합니다.',
              action: TextButton(
                onPressed: () => setState(() => _kind = 'auth'),
                child: const Text('auth 채널 먼저 만들기'),
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: TextField(
              key: const ValueKey('field-name'),
              controller: _name,
              maxLength: 100,
              decoration: const InputDecoration(labelText: '이름'),
            ),
          ),
          ChannelConfigFields(
            key: ValueKey('config-$_kind'),
            kind: _kind,
            form: _form,
            authChannels: _projectId == null ? const [] : _auths,
            storedProviders: {
              if (existing != null && existing.kind == 'auth')
                for (final p in const ['github', 'google'])
                  if ((existing.config['providers'] as Map?)?[p] != null) p,
            },
            onChanged: () => setState(() {}),
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _busy || _needsAuth ? null : _submit,
            icon: _busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Icon(existing == null ? Icons.add_rounded : Icons.save),
            label: Text(existing == null ? '채널 만들기' : '저장'),
          ),
        ],
      ),
    );
  }
}
