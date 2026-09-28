import 'dart:async';

import 'package:yyt_console/app_info.dart';
import 'package:yyt_console/app_list_view.dart';
import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart';
import 'package:yyt_console/filter_apps.dart';
import 'package:yyt_console/find_installed_version.dart';
import 'package:yyt_console/load_app_info.dart';
import 'package:yyt_console/profile_menu.dart';
import 'package:yyt_console/state_card.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

/// The browse tab (docs/decisions.md *Catalog listings* #7): every published
/// app the member may read, as installable cards. Built on first visit, so a
/// launch stays one request; refreshed by pull, the button, and after an
/// install like the app tab.
class BrowseScreen extends StatefulWidget {
  const BrowseScreen({super.key, required this.authState, this.client});

  final AuthState authState;
  final http.Client? client;

  @override
  State<BrowseScreen> createState() => _BrowseScreenState();
}

class _BrowseScreenState extends State<BrowseScreen> {
  List<AppInfo>? apps;
  String? errorMessage;
  bool _refreshing = false;
  final TextEditingController _searchController = TextEditingController();
  Timer? _debounceTimer;
  String _searchQuery = '';

  @override
  void initState() {
    super.initState();
    load();
    _searchController.addListener(_onSearchChanged);
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    _searchController.removeListener(_onSearchChanged);
    _searchController.dispose();
    super.dispose();
  }

  void _onSearchChanged() {
    _debounceTimer?.cancel();
    _debounceTimer = Timer(const Duration(milliseconds: 180), () {
      if (!mounted) return;
      setState(() {
        _searchQuery = _searchController.text.trim().toLowerCase();
      });
    });
  }

  Future<void> load() async {
    if (mounted) setState(() => _refreshing = true);
    final token = widget.authState.token;
    final client = widget.client;
    try {
      final infos = await loadAppInfo(
        ({String? token}) => fetchPublicListings(token: token, client: client),
        findInstalledVersion,
        token: token,
      );
      if (!mounted) return;
      setState(() {
        apps = infos;
        errorMessage = null;
      });
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(token);
      return;
    } catch (e) {
      if (!mounted) return;
      setState(() {
        apps = null;
        errorMessage =
            '게시된 앱을 불러오지 못했습니다.\n네트워크를 확인하거나 나중에 다시 시도해주세요.\n\n오류: $e';
      });
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 64,
        title: Text('둘러보기', style: Theme.of(context).textTheme.titleMedium),
        actions: [
          IconButton(
            tooltip: '새로고침',
            icon:
                _refreshing
                    ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                    : const Icon(Icons.refresh_rounded),
            onPressed: _refreshing ? null : load,
          ),
          ProfileMenuButton(authState: widget.authState),
          const SizedBox(width: 4),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (apps == null && errorMessage == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (errorMessage != null) {
      return RefreshIndicator(
        onRefresh: load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          children: [
            const SizedBox(height: 100),
            CatalogStateCard(
              icon: Icons.cloud_off_rounded,
              title: '게시된 앱을 불러오지 못했습니다',
              body: errorMessage!,
              actionLabel: '다시 시도',
              onPressed: load,
            ),
          ],
        ),
      );
    }
    final all = apps!;
    if (all.isEmpty) {
      return RefreshIndicator(
        onRefresh: load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          children: [
            const SizedBox(height: 100),
            CatalogStateCard(
              icon: Icons.storefront_outlined,
              title: '게시된 앱이 없습니다',
              body: '팀이 앱을 게시하거나 나에게 공유하면 여기에 표시됩니다.',
              actionLabel: '새로고침',
              onPressed: load,
            ),
          ],
        ),
      );
    }
    final filtered = filterAppsByQuery(all, _searchQuery);
    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(
          parent: BouncingScrollPhysics(),
        ),
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
        children: [
          TextField(
            controller: _searchController,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search_rounded),
              hintText: '제목, 요약, 버전 검색',
              suffixIcon:
                  _searchQuery.isEmpty
                      ? null
                      : IconButton(
                        onPressed: _searchController.clear,
                        icon: const Icon(Icons.close_rounded),
                      ),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            _searchQuery.isEmpty
                ? '전체 ${all.length}개'
                : '검색 ${filtered.length}개',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: CatalogPalette.ink,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 10),
          if (filtered.isEmpty)
            const CatalogStateCard(
              icon: Icons.search_off_rounded,
              title: '검색 결과가 없습니다',
              body: '다른 제목이나 요약, 버전으로 다시 검색해보세요.',
              compact: true,
            )
          else
            AppListView(
              apps: filtered,
              authState: widget.authState,
              onAppsChanged: load,
            ),
        ],
      ),
    );
  }
}
