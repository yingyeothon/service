import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:yyt_console/projects/site_detail_screen.dart';
import 'package:yyt_console/projects/site_form_screen.dart';
import 'package:yyt_console/projects/site_models.dart';
import 'package:flutter/material.dart';

ChipTone siteStateTone(SiteState s) => switch (s) {
  SiteState.live => ChipTone.ok,
  SiteState.deploying || SiteState.moving => ChipTone.warn,
  SiteState.empty => ChipTone.neutral,
};

/// The sites tab of [ProjectScreen]: one line per site (name, address,
/// state) and a create button for seated members.
class SitesTab extends StatefulWidget {
  const SitesTab({
    super.key,
    required this.authState,
    required this.team,
    required this.project,
    required this.api,
  });

  final AuthState authState;
  final Team team;
  final Project project;
  final ProjectsApi api;

  @override
  State<SitesTab> createState() => _SitesTabState();
}

class _SitesTabState extends State<SitesTab>
    with AutomaticKeepAliveClientMixin {
  List<Site>? _sites;
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
      final sites = await _api.listSites(widget.project.id);
      if (!mounted) return;
      setState(() {
        _sites = sites;
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
    final created = await Navigator.of(context).push<Site>(
      MaterialPageRoute<Site>(
        builder: (_) => SiteFormScreen.create(
          api: _api,
          project: widget.project,
          onUnauthorized: () => widget.authState.invalidate(_api.token),
        ),
      ),
    );
    if (created == null || !mounted) return;
    await _load();
    if (!mounted) return;
    await _open(created.id);
  }

  Future<void> _open(String siteId) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => SiteDetailScreen(
          authState: widget.authState,
          team: widget.team,
          api: _api,
          siteId: siteId,
        ),
      ),
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Scaffold(
      floatingActionButton: widget.team.canWrite
          ? FloatingActionButton.extended(
              heroTag: 'fab-sites',
              onPressed: _create,
              icon: const Icon(Icons.add_rounded),
              label: const Text('사이트 만들기'),
            )
          : null,
      body: _body(),
    );
  }

  Widget _body() {
    final sites = _sites;
    if (sites == null && _error == null) {
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
                '사이트를 불러오지 못했습니다.\n$_error',
                textAlign: TextAlign.center,
              ),
            )
          else if (sites!.isEmpty)
            const Padding(
              padding: EdgeInsets.only(top: 60),
              child: Text(
                '사이트가 없습니다.\n게임의 웹 빌드나 소개 페이지를 올릴 수 있습니다.',
                textAlign: TextAlign.center,
              ),
            )
          else
            for (final site in sites)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  leading: const Icon(
                    Icons.public_rounded,
                    color: CatalogPalette.ocean,
                  ),
                  title: Text(
                    site.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    site.displayUrl,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  trailing: StatusChip(
                    label: siteStateLabel(site.state),
                    tone: siteStateTone(site.state),
                  ),
                  onTap: () => _open(site.id),
                ),
              ),
        ],
      ),
    );
  }
}
