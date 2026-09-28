import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/format_time.dart';
import 'package:yyt_console/listing/listing_form_screen.dart';
import 'package:yyt_console/listing/listing_models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:flutter/material.dart';

/// The publish panel of an app the caller's team owns (docs/decisions.md
/// *Catalog listings* #7): whether and to whom the app is published, and the
/// members a `members` listing names. Read-only without [canWrite].
class ListingSection extends StatefulWidget {
  const ListingSection({
    super.key,
    required this.api,
    required this.appId,
    required this.appName,
    required this.canWrite,
    required this.onUnauthorized,
  });

  final ProjectsApi api;
  final String appId;
  final String appName;
  final bool canWrite;
  final Future<void> Function() onUnauthorized;

  @override
  State<ListingSection> createState() => _ListingSectionState();
}

DateTime _at(int sec) =>
    DateTime.fromMillisecondsSinceEpoch(sec * 1000, isUtc: true);

class _ListingSectionState extends State<ListingSection> {
  bool _loading = true;
  String? _error;
  CatalogListing? _listing;
  List<ListingViewer>? _viewers;
  String? _viewersError;
  bool _busy = false;
  final _login = TextEditingController();
  String? _loginError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _login.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final listing = await widget.api.getListing(widget.appId);
      if (!mounted) return;
      setState(() {
        _listing = listing;
        _error = null;
        _loading = false;
      });
      if (listing != null) await _loadViewers();
    } on UnauthorizedException catch (e) {
      await widget.onUnauthorized();
      // Invalidation normally navigates away; when it has nothing to drop
      // the panel must not spin forever.
      if (!mounted) return;
      setState(() {
        _error = e.message;
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

  Future<void> _loadViewers() async {
    try {
      final viewers = await widget.api.listListingViewers(widget.appId);
      if (!mounted) return;
      setState(() {
        _viewers = viewers;
        _viewersError = null;
      });
    } on UnauthorizedException catch (e) {
      await widget.onUnauthorized();
      if (!mounted) return;
      setState(() => _viewersError = e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _viewersError = e.toString());
    }
  }

  Future<void> _edit() async {
    final saved = await Navigator.of(context).push<CatalogListing>(
      MaterialPageRoute<CatalogListing>(
        builder:
            (_) => ListingFormScreen(
              api: widget.api,
              appId: widget.appId,
              appName: widget.appName,
              listing: _listing,
              onUnauthorized: widget.onUnauthorized,
            ),
      ),
    );
    if (!mounted) return;
    if (saved == null) {
      // Backed out, or a takedown refused the publish: re-read so the panel
      // matches the server (a published row is unchanged by a cancel).
      if (_listing == null) await _load();
      return;
    }
    final wasPublished = _listing != null;
    setState(() => _listing = saved);
    showSnack(context, wasPublished ? '게시 정보를 저장했습니다.' : '게시했습니다.');
    await _loadViewers();
  }

  Future<void> _unpublish() async {
    final ok = await confirmDestructive(
      context,
      title: '게시를 취소할까요?',
      message:
          '대상에게서 이 앱이 사라집니다. 이미 받은 다운로드 링크는 그대로 유효합니다. '
          '지정 멤버 목록도 함께 지워집니다.',
      confirmLabel: '게시 취소',
    );
    if (!ok || !mounted) return;
    await _run(() async {
      await widget.api.unpublishListing(widget.appId);
      if (!mounted) return;
      setState(() {
        _listing = null;
        _viewers = null;
      });
      showSnack(context, '게시를 취소했습니다.');
    });
  }

  Future<void> _addViewer() async {
    final login = _login.text.trim();
    if (login.isEmpty) return;
    if (login.length > 100) {
      setState(() => _loginError = '로그인은 100자 이하입니다.');
      return;
    }
    setState(() => _loginError = null);
    await _run(() async {
      final ListingViewerAdded r;
      try {
        r = await widget.api.addListingViewer(widget.appId, login);
      } on ApiException catch (e) {
        // The two refusals the field is about (decision #2, the cap); the
        // cap also means the list is stale, so re-read it.
        if (e.status == 404) {
          setState(() => _loginError = '$login 님은 플랫폼 멤버가 아니거나 아직 승인 대기 중입니다.');
          return;
        }
        if (e.status == 409) {
          setState(() => _loginError = '지정 멤버는 최대 $listingViewersMax명입니다.');
          await _loadViewers();
          return;
        }
        rethrow;
      }
      if (!mounted) return;
      _login.clear();
      showSnack(
        context,
        r.added ? '${r.login} 님을 추가했습니다.' : '${r.login} 님은 이미 지정되어 있습니다.',
      );
      if (r.added) await _loadViewers();
    });
  }

  Future<void> _removeViewer(String login) async {
    final ok = await confirmDestructive(
      context,
      title: '$login 님을 제외할까요?',
      message: '새 빌드가 더 이상 보이지 않습니다. 이미 받은 링크는 그대로 유효합니다.',
      confirmLabel: '제외',
    );
    if (!ok || !mounted) return;
    await _run(() async {
      try {
        await widget.api.removeListingViewer(widget.appId, login);
      } on ApiException {
        // Gone already (another client), or refused: the list is stale.
        await _loadViewers();
        rethrow;
      }
      if (!mounted) return;
      showSnack(context, '$login 님을 제외했습니다.');
      await _loadViewers();
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

  @override
  Widget build(BuildContext context) {
    final l = _listing;
    return SectionCard(
      title: '게시',
      children: [
        if (_loading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: LinearProgressIndicator(semanticsLabel: '게시 정보 불러오는 중'),
          )
        else if (_error != null)
          NoticeCard(
            icon: Icons.error_outline_rounded,
            tone: ChipTone.danger,
            text: _error!,
            action: TextButton(onPressed: _load, child: const Text('다시 시도')),
          )
        else if (l == null)
          _notPublished(context)
        else
          ..._published(context, l),
      ],
    );
  }

  Widget _notPublished(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const HintText(
          '게시하지 않았습니다. 게시하면 팀 밖의 모든 사용자 또는 지정한 멤버가 '
          '최신 빌드를 설치할 수 있습니다.',
        ),
        if (widget.canWrite)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: FilledButton.tonalIcon(
              onPressed: _busy ? null : _edit,
              icon: const Icon(Icons.publish_rounded, size: 18),
              label: const Text('게시'),
            ),
          ),
      ],
    );
  }

  List<Widget> _published(BuildContext context, CatalogListing l) {
    final theme = Theme.of(context);
    final viewers = _viewers;
    final public = l.audience == ListingAudience.public;
    return [
      if (l.takenDown)
        const NoticeCard(
          icon: Icons.visibility_off_rounded,
          text:
              '플랫폼 관리자가 이 게시를 내렸습니다. 관리자가 해제하기 전에는 팀 밖에서 아무에게도 '
              '보이지 않습니다. 편집과 게시 취소는 할 수 있습니다.',
        ),
      Row(
        children: [
          Icon(public ? Icons.public_rounded : Icons.group_rounded, size: 18),
          const SizedBox(width: 6),
          Text('대상', style: theme.textTheme.labelLarge),
          const SizedBox(width: 8),
          StatusChip(
            label: l.audience.label,
            tone: public ? ChipTone.ok : ChipTone.accent,
          ),
        ],
      ),
      const SizedBox(height: 8),
      Text(l.title, style: theme.textTheme.titleMedium),
      if (l.summary case final s? when s.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(s, style: theme.textTheme.bodyMedium),
        ),
      if (l.tags.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [for (final t in l.tags) StatusChip(label: t)],
          ),
        ),
      HintText(
        '${formatRelative(_at(l.publishedAt))}'
        '${l.publishedBy == null ? '' : ' ${l.publishedBy}'} 게시'
        '${l.updatedAt != l.publishedAt ? ' · ${formatRelative(_at(l.updatedAt))} 편집' : ''}',
      ),
      if (widget.canWrite)
        Wrap(
          spacing: 8,
          children: [
            OutlinedButton.icon(
              onPressed: _busy ? null : _edit,
              icon: const Icon(Icons.edit_rounded, size: 18),
              label: const Text('편집'),
            ),
            TextButton.icon(
              onPressed: _busy ? null : _unpublish,
              style: TextButton.styleFrom(
                foregroundColor: const Color(0xFFB3261E),
              ),
              icon: const Icon(Icons.unpublished_rounded, size: 18),
              label: const Text('게시 취소'),
            ),
          ],
        ),
      const Divider(height: 20),
      Text('지정 멤버', style: theme.textTheme.titleSmall),
      HintText(
        public
            ? '모든 사용자가 설치할 수 있습니다. 여기에 이름을 올린 멤버는 검색하지 않아도 앱 목록에서 '
                '바로 보고, 대상을 "지정 멤버"로 바꾸면 이 목록만 남습니다.'
            : '여기에 이름을 올린 플랫폼 멤버만 설치할 수 있습니다. 비어 있으면 팀 밖에서는 아무도 '
                '볼 수 없습니다.',
      ),
      if (widget.canWrite)
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: TextField(
                controller: _login,
                enabled: !_busy,
                autocorrect: false,
                enableSuggestions: false,
                textCapitalization: TextCapitalization.none,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _addViewer(),
                onChanged: (_) {
                  if (_loginError != null) setState(() => _loginError = null);
                },
                decoration: InputDecoration(
                  labelText: 'GitHub 로그인',
                  hintText: 'octocat',
                  isDense: true,
                  errorText: _loginError,
                  errorMaxLines: 3,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: ValueListenableBuilder<TextEditingValue>(
                valueListenable: _login,
                builder:
                    (context, v, _) => FilledButton.tonal(
                      onPressed:
                          _busy || v.text.trim().isEmpty ? null : _addViewer,
                      child: const Text('추가'),
                    ),
              ),
            ),
          ],
        ),
      const SizedBox(height: 6),
      if (_viewersError != null)
        NoticeCard(
          icon: Icons.error_outline_rounded,
          tone: ChipTone.danger,
          text: _viewersError!,
          action: TextButton(
            onPressed: _loadViewers,
            child: const Text('다시 시도'),
          ),
        )
      else if (viewers == null)
        const LinearProgressIndicator(semanticsLabel: '지정 멤버 불러오는 중')
      else if (viewers.isEmpty)
        const HintText('아직 지정한 멤버가 없습니다.')
      else
        for (final v in viewers)
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.person_outline_rounded),
            title: Text(v.login ?? '(알 수 없는 멤버)'),
            subtitle: Text(
              '${formatRelative(_at(v.addedAt))}'
              '${v.addedBy == null ? '' : ' · ${v.addedBy} 추가'}',
            ),
            trailing:
                widget.canWrite && v.login != null
                    ? IconButton(
                      tooltip: '${v.login} 제외',
                      onPressed: _busy ? null : () => _removeViewer(v.login!),
                      icon: const Icon(Icons.person_remove_outlined),
                    )
                    : null,
          ),
    ];
  }
}
