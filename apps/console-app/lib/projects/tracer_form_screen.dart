import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:yyt_console/projects/tracer_models.dart';
import 'package:flutter/material.dart';

/// Create (name + description) pops the new [Tracer]; edit pops the updated
/// [Tracer], or nothing when nothing changed.
class TracerFormScreen extends StatefulWidget {
  const TracerFormScreen.create({
    super.key,
    required this.api,
    required Project this.project,
    required this.onUnauthorized,
  }) : tracer = null;

  const TracerFormScreen.edit({
    super.key,
    required this.api,
    required Tracer this.tracer,
    required this.onUnauthorized,
  }) : project = null;

  final ProjectsApi api;
  final Project? project;
  final Tracer? tracer;
  final Future<void> Function() onUnauthorized;

  /// Server cap (services/console/src/tracer.ts `description`).
  static const descriptionMaxLength = 2000;

  @override
  State<TracerFormScreen> createState() => _TracerFormScreenState();
}

class _TracerFormScreenState extends State<TracerFormScreen> {
  late final _name = TextEditingController(text: widget.tracer?.name ?? '');
  late final _description = TextEditingController(
    text: widget.tracer?.description ?? '',
  );
  bool _busy = false;
  String? _nameError;
  String? _descriptionError;

  bool get _editing => widget.tracer != null;

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final nameError = validateTracerName(_name.text.trim());
    setState(() {
      _nameError = nameError;
      _descriptionError = null;
    });
    if (nameError != null) return;
    setState(() => _busy = true);
    try {
      if (_editing) {
        final t = widget.tracer!;
        final patch = buildTracerPatch(
          t,
          name: _name.text,
          description: _description.text,
        );
        if (patch.isEmpty) {
          if (mounted) Navigator.of(context).pop();
          return;
        }
        final updated = await widget.api.updateTracer(t.id, patch);
        if (mounted) Navigator.of(context).pop(updated);
      } else {
        final created = await widget.api.createTracer(
          widget.project!.id,
          name: _name.text,
          description: _description.text,
        );
        if (mounted) Navigator.of(context).pop(created);
      }
    } on UnauthorizedException {
      await widget.onUnauthorized();
    } on ApiException catch (e) {
      if (!mounted) return;
      final fields = e.fieldErrors;
      if (fields.containsKey('name') || fields.containsKey('description')) {
        setState(() {
          _nameError = fields['name'];
          _descriptionError = fields['description'];
        });
      } else {
        // A taken name (409) or the project's resource limit: the server's
        // words, which name the limit.
        showSnack(context, e.message);
      }
    } catch (e) {
      if (mounted) showSnack(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.tracer;
    return Scaffold(
      appBar: AppBar(title: Text(_editing ? '${t!.name} · 편집' : '새 트레이서')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _name,
            autofocus: !_editing,
            maxLength: 64,
            autocorrect: false,
            enableSuggestions: false,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(
              labelText: '이름',
              hintText: 'my-game-debug',
              helperText: '팀 안에서 겹치지 않는 이름 (영문, 숫자, ., _, -)',
              errorText: _nameError,
              errorMaxLines: 3,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _description,
            minLines: 2,
            maxLines: 6,
            maxLength: TracerFormScreen.descriptionMaxLength,
            decoration: InputDecoration(
              labelText: '설명 (선택)',
              alignLabelWithHint: true,
              errorText: _descriptionError,
            ),
          ),
          if (!_editing)
            const HintText(
              '만들면 디버그 빌드에 넣을 DSN이 나옵니다. 프로젝트마다 만들 수 있는 수는 한도가 있고, '
              '더 필요하면 웹 콘솔의 Assets › Limits에서 요청합니다.',
            ),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _busy ? null : _submit,
            icon: _busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Icon(_editing ? Icons.save_rounded : Icons.add_rounded),
            label: Text(_editing ? '저장' : '트레이서 만들기'),
          ),
        ],
      ),
    );
  }
}
