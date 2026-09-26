import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/format_time.dart';
import 'package:yyt_console/projects/channel_detail_screen.dart';
import 'package:yyt_console/projects/channel_form_screen.dart';
import 'package:yyt_console/projects/channel_models.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:yyt_console/projects/secret_once_screen.dart';
import 'package:yyt_console/secure_window.dart';
import 'package:flutter/material.dart';

ChipTone channelStatusTone(String status) => switch (status) {
  'active' => ChipTone.ok,
  'expired' => ChipTone.warn,
  _ => ChipTone.danger,
};

/// The channels tab of [ProjectScreen]: one line per channel (name, kind,
/// state, expiry) and a create button for seated members. A create that
/// returned a credential goes through [SecretOnceScreen] first.
class ChannelsTab extends StatefulWidget {
  const ChannelsTab({
    super.key,
    required this.authState,
    required this.team,
    required this.project,
    required this.api,
    this.secureWindow = const PlatformSecureWindow(),
  });

  final AuthState authState;
  final Team team;
  final Project project;
  final ProjectsApi api;
  final SecureWindow secureWindow;

  @override
  State<ChannelsTab> createState() => _ChannelsTabState();
}

class _ChannelsTabState extends State<ChannelsTab>
    with AutomaticKeepAliveClientMixin {
  List<Channel>? _channels;
  String? _error;

  ProjectsApi get _api => widget.api;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final channels = await _api.listChannels(widget.project.id);
      if (!mounted) return;
      setState(() {
        _channels = channels;
        _error = null;
      });
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  Future<void> _unauthorized() => widget.authState.invalidate(_api.token);

  Widget _detail(String id) => ChannelDetailScreen(
    authState: widget.authState,
    team: widget.team,
    api: _api,
    channelId: id,
    onChanged: _load,
  );

  Future<void> _create() async {
    final created = await Navigator.of(context).push<CreatedChannel>(
      MaterialPageRoute<CreatedChannel>(
        builder:
            (_) => ChannelFormScreen.create(
              api: _api,
              projectId: widget.project.id,
              onUnauthorized: _unauthorized,
            ),
      ),
    );
    if (created == null || !mounted) return;
    final id = created.channel.id;
    final route =
        created.credential == null
            ? MaterialPageRoute<void>(builder: (_) => _detail(id))
            : MaterialPageRoute<void>(
              builder:
                  (_) => SecretOnceScreen(
                    created: created,
                    secureWindow: widget.secureWindow,
                    detailBuilder: (_) => _detail(id),
                  ),
            );
    // Completes when the detail closes, or — through the secret screen —
    // when that screen replaces itself; the list reloads either way and the
    // detail's onChanged covers later edits.
    final shown = Navigator.of(context).push<void>(route);
    await _load();
    await shown;
  }

  Future<void> _open(Channel channel) async {
    await Navigator.of(
      context,
    ).push<void>(MaterialPageRoute<void>(builder: (_) => _detail(channel.id)));
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Scaffold(
      floatingActionButton:
          widget.team.canWrite
              ? FloatingActionButton.extended(
                heroTag: 'fab-channels',
                onPressed: _create,
                icon: const Icon(Icons.add_rounded),
                label: const Text('채널 만들기'),
              )
              : null,
      body: _body(),
    );
  }

  Widget _body() {
    final channels = _channels;
    if (channels == null && _error == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 96),
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 60),
              child: Text(
                '채널을 불러오지 못했습니다.\n$_error',
                textAlign: TextAlign.center,
              ),
            )
          else if (channels!.isEmpty)
            const Padding(
              padding: EdgeInsets.only(top: 60),
              child: Text(
                '채널이 없습니다.\nauth 채널부터 만들어 플레이어 로그인을 붙이세요.',
                textAlign: TextAlign.center,
              ),
            )
          else
            for (final ch in channels)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  leading: const Icon(
                    Icons.hub_outlined,
                    color: CatalogPalette.ocean,
                  ),
                  title: Text(
                    ch.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Row(
                    children: [
                      StatusChip(label: ch.kind, tone: ChipTone.accent),
                      const SizedBox(width: 6),
                      StatusChip(
                        label: channelStatusLabel(ch.status),
                        tone: channelStatusTone(ch.status),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          '만료 ${formatRelative(ch.expiresAt)}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                  onTap: () => _open(ch),
                ),
              ),
        ],
      ),
    );
  }
}
