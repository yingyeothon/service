import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:yyt_console/projects/site_models.dart';
import 'package:flutter/material.dart';

/// Create (name + description) pops the new [Site]; edit (name, description,
/// domain) pops a [SiteUpdate], or nothing when nothing changed. The domain
/// is compared with the site as it was when the form opened, and is locked
/// while that site is busy (a deploy or a move in flight).
class SiteFormScreen extends StatefulWidget {
  const SiteFormScreen.create({
    super.key,
    required this.api,
    required Project this.project,
    required this.onUnauthorized,
  }) : site = null;

  const SiteFormScreen.edit({
    super.key,
    required this.api,
    required Site this.site,
    required this.onUnauthorized,
  }) : project = null;

  final ProjectsApi api;
  final Project? project;
  final Site? site;
  final Future<void> Function() onUnauthorized;

  /// Server cap (services/console/src/sites.ts `description`).
  static const descriptionMaxLength = 2000;

  /// Build hints of docs/decisions.md *Site domains* §10: a claim changes the
  /// slug, so a build made for the old base path must be rebuilt.
  static String domainHelpFor(Site site) =>
      '이름을 바꾸면 사이트 파일이 새 주소로 옮겨지고 옛 주소는 더 이상 동작하지 않습니다. '
      '기본 경로 ${site.basePath}(으)로 빌드했다면 다시 빌드해야 합니다. '
      '${site.hostSuffix != null ? '상대 경로(./)는 두 주소 모두에서, /는 사이트 전용 주소에서만 동작합니다. ' : '상대 경로(./)는 주소가 바뀌어도 그대로 동작합니다. '}'
      '한 번 쓴 이름은 이 팀만 다시 쓸 수 있습니다.';

  static const domainHeldHint = '배포나 이름 이동이 진행 중입니다. 끝난 뒤에 이름을 바꿀 수 있습니다.';

  @override
  State<SiteFormScreen> createState() => _SiteFormScreenState();
}

class _SiteFormScreenState extends State<SiteFormScreen> {
  late final _name = TextEditingController(text: widget.site?.name ?? '');
  late final _description = TextEditingController(
    text: widget.site?.description ?? '',
  );
  late final _domain = TextEditingController(text: widget.site?.domain ?? '');
  bool _busy = false;
  String? _nameError;
  String? _descriptionError;
  String? _domainError;

  bool get _editing => widget.site != null;

  /// A busy site answers any domain change with 409 after spending the
  /// team's name slot: the field is locked and the key never sent.
  bool get _domainHeld => widget.site?.held ?? false;

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    _domain.dispose();
    super.dispose();
  }

  bool _validate() {
    final nameError = validateSiteName(_name.text.trim());
    final domainError = _editing && !_domainHeld
        ? validateSiteDomain(normalizeSiteDomain(_domain.text))
        : null;
    setState(() {
      _nameError = nameError;
      _descriptionError = null;
      _domainError = domainError;
    });
    return nameError == null && domainError == null;
  }

  Future<void> _submit() async {
    if (!_validate()) return;
    setState(() => _busy = true);
    try {
      if (_editing) {
        final site = widget.site!;
        final patch = buildSitePatch(
          site,
          name: _name.text,
          description: _description.text,
          domain: _domainHeld ? null : _domain.text,
        );
        if (patch.isEmpty) {
          if (mounted) Navigator.of(context).pop();
          return;
        }
        final update = await widget.api.updateSite(site.id, patch);
        if (mounted) Navigator.of(context).pop(update);
      } else {
        final created = await widget.api.createSite(
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
      _showApiError(e);
    } catch (e) {
      if (mounted) showSnack(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// A refused domain (taken, the team's cap, still cleaning) and 400
  /// validation errors go under their field; anything else (a busy site, a
  /// duplicate site name, a rate limit) is a SnackBar.
  void _showApiError(ApiException e) {
    final reason = ProjectsApi.reasonMessage(e.reason, names: e.names);
    final fields = e.fieldErrors;
    if (reason != null) {
      setState(() => _domainError = reason);
    } else if (fields.containsKey('domain') ||
        fields.containsKey('name') ||
        fields.containsKey('description')) {
      setState(() {
        _domainError = fields['domain'];
        _nameError = fields['name'];
        _descriptionError = fields['description'];
      });
    } else {
      showSnack(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final site = widget.site;
    return Scaffold(
      appBar: AppBar(title: Text(_editing ? '${site!.name} · 편집' : '새 사이트')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _name,
            autofocus: !_editing,
            maxLength: 64,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(
              labelText: '이름',
              helperText: '팀 안에서 겹치지 않는 이름 (영문, 숫자, _, -)',
              errorText: _nameError,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _description,
            minLines: 2,
            maxLines: 6,
            maxLength: SiteFormScreen.descriptionMaxLength,
            decoration: InputDecoration(
              labelText: '설명 (선택)',
              alignLabelWithHint: true,
              errorText: _descriptionError,
            ),
          ),
          if (site != null) ...[const SizedBox(height: 12), _domainField(site)],
          if (!_editing) ...[
            const HintText(
              '만들면 무작위 주소가 정해지고, 나중에 편집에서 이름을 정할 수 있습니다. '
              '파일 업로드는 웹 콘솔이나 `yyt site deploy`로 합니다.',
            ),
            const SizedBox(height: 8),
            const NoticeCard(
              icon: Icons.warning_amber_rounded,
              text: siteSharedOriginWarning,
            ),
          ],
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
            label: Text(_editing ? '저장' : '사이트 만들기'),
          ),
        ],
      ),
    );
  }

  Widget _domainField(Site site) {
    final suffix = site.hostSuffix;
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: _domain,
      builder: (context, value, _) {
        final typed = normalizeSiteDomain(value.text);
        final label = typed.isEmpty ? '<이름>' : typed;
        // Without the name host a claimed name still renames the path URL.
        final host = Uri.tryParse(site.publicUrl)?.host ?? '';
        final where = suffix != null
            ? 'https://$label.$suffix/'
            : '${host.isEmpty ? '' : host}/$label/';
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _domain,
              enabled: !_domainHeld,
              maxLength: 32,
              autocorrect: false,
              enableSuggestions: false,
              keyboardType: TextInputType.url,
              decoration: InputDecoration(
                labelText: '사이트 이름 (주소)',
                hintText: 'my-game',
                suffixText: suffix == null ? null : '.$suffix',
                helperText: _domainHeld
                    ? SiteFormScreen.domainHeldHint
                    : '주소: $where · 비우면 무작위 주소로 돌아갑니다',
                helperMaxLines: 2,
                errorText: _domainError,
                errorMaxLines: 6,
              ),
            ),
            HintText(SiteFormScreen.domainHelpFor(site)),
          ],
        );
      },
    );
  }
}
