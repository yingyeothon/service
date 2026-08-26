import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/issues_screen.dart'
    show IssueStatusIcon, formatIssueTime;
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter/material.dart';

/// One issue: body, comments, a comment box, and close/reopen.
class IssueDetailScreen extends StatefulWidget {
  const IssueDetailScreen({
    super.key,
    required this.authState,
    required this.team,
    required this.project,
    required this.number,
  });

  final AuthState authState;
  final Team team;
  final Project project;
  final int number;

  @override
  State<IssueDetailScreen> createState() => _IssueDetailScreenState();
}

/// Counter shown only near the cap so the box stays clean.
Widget? _counter(
  BuildContext context, {
  required int currentLength,
  required bool isFocused,
  required int? maxLength,
}) => currentLength > 9000 ? Text('$currentLength / $maxLength') : null;

class _IssueDetailScreenState extends State<IssueDetailScreen> {
  Issue? _issue;
  String? _error;
  bool _busy = false;
  final _comment = TextEditingController();

  late final ProjectsApi _api = ProjectsApi(
    token: widget.authState.token ?? '',
  );

  /// Server cap for a comment (services/console/src/team.ts `commentMd`).
  static const commentMaxLength = 10000;

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
      final issue = await _api.getIssue(widget.project.id, widget.number);
      if (!mounted) return;
      setState(() {
        _issue = issue;
        _error = null;
      });
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
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

  Future<void> _addComment() async {
    final text = _comment.text.trim();
    if (text.isEmpty) return;
    await _run(() async {
      await _api.addComment(widget.project.id, widget.number, text);
      _comment.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final issue = _issue;
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.project.name} #${widget.number}'),
        actions: [
          if (issue != null && widget.team.canWrite)
            TextButton.icon(
              onPressed:
                  _busy
                      ? null
                      : () => _run(
                        () => _api.setIssueStatus(
                          widget.project.id,
                          widget.number,
                          open: !issue.isOpen,
                        ),
                      ),
              icon: Icon(
                issue.isOpen
                    ? Icons.check_circle_outline_rounded
                    : Icons.replay_rounded,
              ),
              label: Text(issue.isOpen ? '닫기' : '다시 열기'),
            ),
        ],
      ),
      body:
          issue == null
              ? Center(
                child:
                    _error == null
                        ? const CircularProgressIndicator()
                        : Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            '이슈를 불러오지 못했습니다.\n$_error',
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
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              IssueStatusIcon(open: issue.isOpen),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  issue.title,
                                  style: Theme.of(context).textTheme.titleLarge
                                      ?.copyWith(fontWeight: FontWeight.w800),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '${issue.isOpen ? '열림' : '닫힘'} · ${issue.createdBy} · ${formatIssueTime(issue.createdAt)}',
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: CatalogPalette.slate),
                          ),
                          const SizedBox(height: 12),
                          if (issue.bodyMd.isNotEmpty)
                            Card(
                              child: Padding(
                                padding: const EdgeInsets.all(14),
                                child: SelectableText(issue.bodyMd),
                              ),
                            ),
                          const SizedBox(height: 16),
                          Text(
                            '댓글 ${issue.comments.length}',
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                          const SizedBox(height: 8),
                          for (final c in issue.comments)
                            Card(
                              margin: const EdgeInsets.only(bottom: 8),
                              child: Padding(
                                padding: const EdgeInsets.all(12),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      '${c.createdBy}${c.mine ? ' (나)' : ''} · ${formatIssueTime(c.createdAt)}',
                                      style: Theme.of(
                                        context,
                                      ).textTheme.bodySmall?.copyWith(
                                        color: CatalogPalette.slate,
                                      ),
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
                                maxLength: commentMaxLength,
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
