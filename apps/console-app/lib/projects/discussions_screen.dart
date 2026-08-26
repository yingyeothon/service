import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/issues_screen.dart' show formatIssueTime;
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter/material.dart';

/// Every discussion of one team, newest first, with a create button.
class DiscussionsScreen extends StatefulWidget {
  const DiscussionsScreen({
    super.key,
    required this.authState,
    required this.team,
  });

  final AuthState authState;
  final Team team;

  @override
  State<DiscussionsScreen> createState() => _DiscussionsScreenState();
}

class _DiscussionsScreenState extends State<DiscussionsScreen> {
  List<Discussion>? _items;
  String? _error;

  late final ProjectsApi _api = ProjectsApi(
    token: widget.authState.token ?? '',
  );

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _api.close();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final items = sortDiscussionsNewestFirst(
        await _api.listDiscussions(widget.team.id),
      );
      if (!mounted) return;
      setState(() {
        _items = items;
        _error = null;
      });
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  Future<void> _create() async {
    final created = await createDiscussionFlow(
      context,
      api: _api,
      authState: widget.authState,
      team: widget.team,
    );
    if (created != null && mounted) {
      await _load();
      if (!mounted) return;
      await _open(created);
    }
  }

  Future<void> _open(Discussion d) async {
    await openDiscussion(
      context,
      authState: widget.authState,
      team: widget.team,
      id: d.id,
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('${widget.team.name} · 토론')),
      floatingActionButton:
          widget.team.canWrite
              ? FloatingActionButton.extended(
                onPressed: _create,
                icon: const Icon(Icons.add_rounded),
                label: const Text('토론 시작'),
              )
              : null,
      body:
          _items == null && _error == null
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(14, 8, 14, 96),
                  children: [
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 60),
                        child: Text(
                          '토론을 불러오지 못했습니다.\n$_error',
                          textAlign: TextAlign.center,
                        ),
                      )
                    else if (_items!.isEmpty)
                      const Padding(
                        padding: EdgeInsets.only(top: 60),
                        child: Text('토론이 없습니다.', textAlign: TextAlign.center),
                      )
                    else
                      for (final d in _items!)
                        Card(
                          margin: const EdgeInsets.only(bottom: 8),
                          child: DiscussionTile(
                            discussion: d,
                            onTap: () => _open(d),
                          ),
                        ),
                  ],
                ),
              ),
    );
  }
}

/// Server order is not promised; the app wants the latest activity on top.
List<Discussion> sortDiscussionsNewestFirst(List<Discussion> items) =>
    items.toList()..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));

class DiscussionTile extends StatelessWidget {
  const DiscussionTile({
    super.key,
    required this.discussion,
    required this.onTap,
  });

  final Discussion discussion;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final d = discussion;
    return ListTile(
      leading: const Icon(Icons.forum_outlined, color: CatalogPalette.ocean),
      title: Text(d.title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        '${d.createdBy}${d.mine ? ' (나)' : ''} · ${formatIssueTime(d.updatedAt)}',
      ),
      onTap: onTap,
    );
  }
}

Future<void> openDiscussion(
  BuildContext context, {
  required AuthState authState,
  required Team team,
  required String id,
}) => Navigator.of(context).push<void>(
  MaterialPageRoute<void>(
    builder:
        (_) => DiscussionDetailScreen(authState: authState, team: team, id: id),
  ),
);

Future<Discussion?> createDiscussionFlow(
  BuildContext context, {
  required ProjectsApi api,
  required AuthState authState,
  required Team team,
}) => Navigator.of(context).push<Discussion>(
  MaterialPageRoute<Discussion>(
    builder:
        (_) => DiscussionCreateScreen(
          api: api,
          team: team,
          onUnauthorized: () => authState.invalidate(api.token),
        ),
  ),
);

/// One discussion: body, comments, and a comment box.
class DiscussionDetailScreen extends StatefulWidget {
  const DiscussionDetailScreen({
    super.key,
    required this.authState,
    required this.team,
    required this.id,
  });

  final AuthState authState;
  final Team team;
  final String id;

  /// Server cap for a comment (services/console/src/team.ts `commentMd`).
  static const commentMaxLength = 10000;

  @override
  State<DiscussionDetailScreen> createState() => _DiscussionDetailScreenState();
}

Widget? _counter(
  BuildContext context, {
  required int currentLength,
  required bool isFocused,
  required int? maxLength,
}) => currentLength > 9000 ? Text('$currentLength / $maxLength') : null;

class _DiscussionDetailScreenState extends State<DiscussionDetailScreen> {
  Discussion? _discussion;
  String? _error;
  bool _busy = false;
  final _comment = TextEditingController();

  late final ProjectsApi _api = ProjectsApi(
    token: widget.authState.token ?? '',
  );

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _api.close();
    _comment.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await _api.getDiscussion(widget.team.id, widget.id);
      if (!mounted) return;
      setState(() {
        _discussion = d;
        _error = null;
      });
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  Future<void> _addComment() async {
    final text = _comment.text.trim();
    if (text.isEmpty) return;
    setState(() => _busy = true);
    try {
      await _api.addDiscussionComment(widget.team.id, widget.id, text);
      _comment.clear();
      await _load();
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _discussion;
    final slate = Theme.of(
      context,
    ).textTheme.bodySmall?.copyWith(color: CatalogPalette.slate);
    return Scaffold(
      appBar: AppBar(title: Text('${widget.team.name} · 토론')),
      body:
          d == null
              ? Center(
                child:
                    _error == null
                        ? const CircularProgressIndicator()
                        : Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            '토론을 불러오지 못했습니다.\n$_error',
                            textAlign: TextAlign.center,
                          ),
                        ),
              )
              : Column(
                children: [
                  Expanded(
                    child: RefreshIndicator(
                      onRefresh: _load,
                      child: ListView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.fromLTRB(14, 8, 14, 16),
                        children: [
                          Text(
                            d.title,
                            style: Theme.of(context).textTheme.titleLarge
                                ?.copyWith(fontWeight: FontWeight.w800),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '${d.createdBy}${d.mine ? ' (나)' : ''} · ${formatIssueTime(d.createdAt)}',
                            style: slate,
                          ),
                          const SizedBox(height: 12),
                          if (d.bodyMd.isNotEmpty)
                            Card(
                              child: Padding(
                                padding: const EdgeInsets.all(14),
                                child: SelectableText(d.bodyMd),
                              ),
                            ),
                          const SizedBox(height: 16),
                          Text(
                            '댓글 ${d.comments.length}',
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                          const SizedBox(height: 8),
                          for (final c in d.comments)
                            Card(
                              margin: const EdgeInsets.only(bottom: 8),
                              child: Padding(
                                padding: const EdgeInsets.all(12),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      '${c.createdBy}${c.mine ? ' (나)' : ''} · ${formatIssueTime(c.createdAt)}',
                                      style: slate,
                                    ),
                                    const SizedBox(height: 6),
                                    SelectableText(c.bodyMd),
                                  ],
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                  if (widget.team.canWrite)
                    SafeArea(
                      top: false,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Expanded(
                              child: TextField(
                                controller: _comment,
                                minLines: 1,
                                maxLines: 5,
                                maxLength:
                                    DiscussionDetailScreen.commentMaxLength,
                                buildCounter: _counter,
                                decoration: const InputDecoration(
                                  hintText: '댓글 (Markdown)',
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            IconButton.filled(
                              tooltip: '댓글 등록',
                              onPressed: _busy ? null : _addComment,
                              icon: const Icon(Icons.send_rounded),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
    );
  }
}

/// Title + Markdown body form; pops with the created discussion.
class DiscussionCreateScreen extends StatefulWidget {
  const DiscussionCreateScreen({
    super.key,
    required this.api,
    required this.team,
    required this.onUnauthorized,
  });

  final ProjectsApi api;
  final Team team;
  final Future<void> Function() onUnauthorized;

  /// Server cap for `bodyMd` (services/console/src/team.ts).
  static const bodyMaxLength = 20000;

  @override
  State<DiscussionCreateScreen> createState() => _DiscussionCreateScreenState();
}

class _DiscussionCreateScreenState extends State<DiscussionCreateScreen> {
  final _title = TextEditingController();
  final _body = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final title = _title.text.trim();
    if (title.isEmpty) {
      setState(() => _error = '제목을 입력해주세요.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final d = await widget.api.createDiscussion(
        widget.team.id,
        title: title,
        bodyMd: _body.text.trim(),
      );
      if (mounted) Navigator.of(context).pop(d);
    } on UnauthorizedException {
      await widget.onUnauthorized();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('${widget.team.name} · 새 토론')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _title,
            autofocus: true,
            maxLength: 200,
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(labelText: '제목'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _body,
            minLines: 6,
            maxLines: 20,
            maxLength: DiscussionCreateScreen.bodyMaxLength,
            decoration: const InputDecoration(
              labelText: '내용 (Markdown)',
              alignLabelWithHint: true,
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _busy ? null : _submit,
            icon:
                _busy
                    ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                    : const Icon(Icons.send_rounded),
            label: const Text('등록'),
          ),
        ],
      ),
    );
  }
}
