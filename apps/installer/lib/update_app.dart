import 'dart:async';

import 'package:catalog/app_info.dart';
import 'package:catalog/app_install_state.dart';
import 'package:catalog/app_list_view.dart';
import 'package:catalog/app_theme.dart';
import 'package:catalog/auth/auth_state.dart';
import 'package:catalog/fetch_remote_apps.dart';
import 'package:catalog/find_installed_version.dart';
import 'package:catalog/load_app_info.dart';
import 'package:catalog/self_update_state.dart';
import 'package:flutter/material.dart';

class UpdaterApp extends StatefulWidget {
  const UpdaterApp({super.key, required this.authState});

  final AuthState authState;

  @override
  State<UpdaterApp> createState() => _UpdaterAppState();
}

class _UpdaterAppState extends State<UpdaterApp> {
  List<AppInfo>? apps;
  String? errorMessage;
  final TextEditingController _searchController = TextEditingController();
  Timer? _debounceTimer;
  String _searchQuery = '';
  bool _refreshing = false;

  @override
  void initState() {
    super.initState();
    checkUpdates();
    _checkPendingSelfUpdate();
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
      if (!mounted) {
        return;
      }
      setState(() {
        _searchQuery = _searchController.text.trim().toLowerCase();
      });
    });
  }

  Future<void> checkUpdates() async {
    if (mounted) {
      setState(() {
        _refreshing = true;
      });
    }

    try {
      final infos = await loadAppInfo(
        fetchRemoteApps,
        findInstalledVersion,
        token: widget.authState.token,
      );
      if (!mounted) {
        return;
      }
      setState(() {
        apps = infos;
        errorMessage = null;
      });
    } catch (e) {
      if (e.toString().contains('UnauthorizedException')) {
        await widget.authState.logout();
        return;
      }

      if (!mounted) {
        return;
      }
      setState(() {
        apps = null;
        errorMessage =
            '앱 목록을 불러오지 못했습니다.\n네트워크를 확인하거나 나중에 다시 시도해주세요.\n\n오류: $e';
      });
    } finally {
      if (mounted) {
        setState(() {
          _refreshing = false;
        });
      }
    }
  }

  Future<void> _checkPendingSelfUpdate() async {
    try {
      final result = await consumePendingSelfUpdate();
      if (!mounted || result == null) {
        return;
      }

      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) {
          return;
        }
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('installer 업데이트 완료 (${result.installedVersion})'),
          ),
        );
      });
    } catch (_) {
      // Ignore self-update confirmation failures and continue normal startup.
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 64,
        title: const _CatalogWordmark(),
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
            onPressed: _refreshing ? null : checkUpdates,
          ),
          IconButton(
            tooltip: '로그아웃',
            icon: const Icon(Icons.logout_rounded),
            onPressed: () async {
              await widget.authState.logout();
            },
          ),
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
        onRefresh: checkUpdates,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          children: [
            const SizedBox(height: 100),
            _StateCard(
              icon: Icons.cloud_off_rounded,
              title: '앱 목록을 불러오지 못했습니다',
              body: errorMessage!,
              actionLabel: '다시 시도',
              onPressed: checkUpdates,
            ),
          ],
        ),
      );
    }

    if (apps == null) {
      return const Center(
        child: Text('앱 목록을 가져오는 중입니다.', textAlign: TextAlign.center),
      );
    }

    if (apps!.isEmpty) {
      return RefreshIndicator(
        onRefresh: checkUpdates,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          children: [
            const SizedBox(height: 100),
            _StateCard(
              icon: Icons.check_circle_outline_rounded,
              title: '설치 가능한 앱이 없습니다',
              body: '새 앱이 게시되면 이 화면에 표시됩니다.',
              actionLabel: '새로고침',
              onPressed: checkUpdates,
            ),
          ],
        ),
      );
    }

    final states = {
      for (final app in apps!)
        app.package: resolveAppInstallState(app.version, app.installedVersion),
    };
    final filteredApps = _filterApps(apps!);
    final updateCount =
        states.values.where((state) => state == AppInstallState.old).length;
    final installedCount =
        states.values
            .where((state) => state != AppInstallState.notInstalled)
            .length;

    return RefreshIndicator(
      onRefresh: checkUpdates,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(
          parent: BouncingScrollPhysics(),
        ),
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
        children: [
          _SummaryStrip(
            totalApps: apps!.length,
            updateCount: updateCount,
            installedCount: installedCount,
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _searchController,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search_rounded),
              hintText: '앱 이름, 버전, 메모 검색',
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
                ? '전체 ${apps!.length}개'
                : '검색 ${filteredApps.length}개',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: CatalogPalette.ink,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 10),
          if (filteredApps.isEmpty)
            const _StateCard(
              icon: Icons.search_off_rounded,
              title: '검색 결과가 없습니다',
              body: '다른 이름이나 버전, 메모로 다시 검색해보세요.',
              compact: true,
            )
          else
            AppListView(
              apps: filteredApps,
              authState: widget.authState,
              onAppsChanged: checkUpdates,
            ),
        ],
      ),
    );
  }

  List<AppInfo> _filterApps(List<AppInfo> source) {
    if (_searchQuery.isEmpty) {
      return source;
    }

    return source.where((app) {
      final values = <String>[
        app.name,
        app.package,
        app.version,
        app.releaseNote,
        app.buildType,
        ...app.tags.values,
      ];
      return values.any((value) => value.toLowerCase().contains(_searchQuery));
    }).toList();
  }
}

class _CatalogWordmark extends StatelessWidget {
  const _CatalogWordmark();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Image.asset('assets/icon.png', width: 34, height: 34),
        ),
        const SizedBox(width: 10),
        Text('잉여톤 · 앱', style: Theme.of(context).textTheme.titleMedium),
      ],
    );
  }
}

class _SummaryStrip extends StatelessWidget {
  const _SummaryStrip({
    required this.totalApps,
    required this.updateCount,
    required this.installedCount,
  });

  final int totalApps;
  final int updateCount;
  final int installedCount;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFDCE4EF)),
      ),
      child: Row(
        children: [
          Expanded(child: _MetricTile(label: '전체 앱', value: '$totalApps')),
          Expanded(child: _MetricTile(label: '업데이트 필요', value: '$updateCount')),
          Expanded(child: _MetricTile(label: '설치됨', value: '$installedCount')),
        ],
      ),
    );
  }
}

class _MetricTile extends StatelessWidget {
  const _MetricTile({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            value,
            style: Theme.of(
              context,
            ).textTheme.titleLarge?.copyWith(fontSize: 20, height: 1.1),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: CatalogPalette.slate),
          ),
        ],
      ),
    );
  }
}

class _StateCard extends StatelessWidget {
  const _StateCard({
    required this.icon,
    required this.title,
    required this.body,
    this.actionLabel,
    this.onPressed,
    this.compact = false,
  });

  final IconData icon;
  final String title;
  final String body;
  final String? actionLabel;
  final Future<void> Function()? onPressed;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: EdgeInsets.all(compact ? 18 : 20),
        child: Column(
          children: [
            Container(
              width: compact ? 44 : 50,
              height: compact ? 44 : 50,
              decoration: BoxDecoration(
                color: CatalogPalette.sky,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Icon(icon, color: CatalogPalette.ocean, size: 24),
            ),
            const SizedBox(height: 14),
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(body, textAlign: TextAlign.center),
            if (actionLabel != null && onPressed != null) ...[
              const SizedBox(height: 14),
              FilledButton(onPressed: onPressed, child: Text(actionLabel!)),
            ],
          ],
        ),
      ),
    );
  }
}
