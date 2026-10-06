import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/listing/listing_models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:flutter/material.dart';

/// Publish an app (no [listing]) or edit its listing; pops the saved
/// [CatalogListing]. The PUT replaces title, summary, tags and audience
/// whole, so every field is sent every time.
class ListingFormScreen extends StatefulWidget {
  const ListingFormScreen({
    super.key,
    required this.api,
    required this.appId,
    required this.appName,
    required this.onUnauthorized,
    this.listing,
  });

  final ProjectsApi api;
  final String appId;
  final String appName;
  final CatalogListing? listing;
  final Future<void> Function() onUnauthorized;

  @override
  State<ListingFormScreen> createState() => _ListingFormScreenState();
}

class _ListingFormScreenState extends State<ListingFormScreen> {
  late final _title = TextEditingController(
    text: widget.listing?.title ?? widget.appName,
  );
  late final _summary = TextEditingController(
    text: widget.listing?.summary ?? '',
  );
  late final _tags = TextEditingController(
    text: widget.listing?.tags.join(', ') ?? '',
  );
  late ListingAudience _audience =
      widget.listing?.audience ?? ListingAudience.public;
  bool _busy = false;
  String? _titleError;
  String? _summaryError;
  String? _tagsError;

  bool get _editing => widget.listing != null;

  @override
  void dispose() {
    _title.dispose();
    _summary.dispose();
    _tags.dispose();
    super.dispose();
  }

  void _setFieldError(String field, String? message) {
    setState(() {
      _titleError = field == 'title' ? message : null;
      _summaryError = field == 'summary' ? message : null;
      _tagsError = field == 'tags' ? message : null;
    });
  }

  Future<void> _submit() async {
    final Map<String, Object?> body;
    try {
      body = buildListingBody(
        title: _title.text,
        summary: _summary.text,
        tagsText: _tags.text,
        audience: _audience,
      );
    } on ListingFormError catch (e) {
      _setFieldError(e.field, e.message);
      return;
    }
    _setFieldError('', null);
    setState(() => _busy = true);
    try {
      final saved = await widget.api.publishListing(widget.appId, body);
      if (mounted) Navigator.of(context).pop(saved);
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

  /// 400 validation goes under its field (`tags.0` counts as tags); a
  /// takedown 409 and everything else is a SnackBar.
  void _showApiError(ApiException e) {
    final fields = e.fieldErrors;
    String? firstFor(String prefix) {
      for (final entry in fields.entries) {
        if (entry.key == prefix || entry.key.startsWith('$prefix.')) {
          return entry.value;
        }
      }
      return null;
    }

    final title = firstFor('title');
    final summary = firstFor('summary');
    final tags = firstFor('tags');
    if (title != null || summary != null || tags != null) {
      setState(() {
        _titleError = title;
        _summaryError = summary;
        _tagsError = tags;
      });
      return;
    }
    showSnack(context, e.message);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_editing ? '게시 편집' : '앱 게시')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const NoticeCard(
            icon: Icons.public_rounded,
            tone: ChipTone.accent,
            text:
                '게시하면 플랫폼별 최신 빌드가 지금부터, 그리고 앞으로 올리는 모든 빌드가 '
                '대상에게 보입니다. 프로젝트의 다른 정보는 보이지 않습니다.',
          ),
          TextField(
            controller: _title,
            autofocus: !_editing,
            maxLength: listingTitleMaxLength,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(
              labelText: '제목',
              helperText: '설치하는 사람에게 보이는 이름',
              errorText: _titleError,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _summary,
            minLines: 2,
            maxLines: 6,
            maxLength: listingSummaryMaxLength,
            decoration: InputDecoration(
              labelText: '요약 (선택)',
              alignLabelWithHint: true,
              errorText: _summaryError,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _tags,
            autocorrect: false,
            enableSuggestions: false,
            textCapitalization: TextCapitalization.none,
            decoration: InputDecoration(
              labelText: '태그 (선택)',
              hintText: 'puzzle, multiplayer',
              helperText: '쉼표나 공백으로 구분, 소문자·숫자·하이픈 1~32자, 최대 $listingTagsMax개',
              helperMaxLines: 2,
              errorText: _tagsError,
              errorMaxLines: 3,
            ),
          ),
          const SizedBox(height: 16),
          Text('누가 설치할 수 있나요', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 6),
          SegmentedButton<ListingAudience>(
            segments: const [
              ButtonSegment(
                value: ListingAudience.public,
                label: Text('모든 사용자'),
                icon: Icon(Icons.public_rounded),
              ),
              ButtonSegment(
                value: ListingAudience.members,
                label: Text('지정 멤버'),
                icon: Icon(Icons.group_rounded),
              ),
            ],
            selected: {_audience},
            onSelectionChanged: _busy
                ? null
                : (s) => setState(() => _audience = s.first),
          ),
          const HintText(
            '지정 멤버는 게시 뒤 GitHub 로그인으로 추가하는 플랫폼 멤버입니다. '
            '팀 자리 없이 최신 빌드만 받습니다.',
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
                : Icon(_editing ? Icons.save_rounded : Icons.publish_rounded),
            label: Text(_editing ? '저장' : '게시'),
          ),
        ],
      ),
    );
  }
}
