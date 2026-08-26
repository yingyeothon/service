import 'dart:async';

import 'package:yyt_console/app_cards.dart';
import 'package:yyt_console/app_info.dart';
import 'package:yyt_console/app_install_state.dart';
import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/api/artifacts_api.dart';
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/artifact_version_group.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/check_if_need_to_update.dart';
import 'package:yyt_console/download_install_launch.dart';
import 'package:yyt_console/fetch_remote_apps.dart';
import 'package:yyt_console/find_installed_version.dart';
import 'package:yyt_console/install_progress_dialog.dart';
import 'package:yyt_console/project_issues_button.dart';
import 'package:flutter/material.dart';

class AppDetailView extends StatefulWidget {
  const AppDetailView({super.key, required this.app, required this.authState});

  final AppInfo app;
  final AuthState authState;

  @override
  State<AppDetailView> createState() => _AppDetailViewState();
}

class _AppDetailViewState extends State<AppDetailView>
    with WidgetsBindingObserver {
  List<ArtifactVersionGroup> _versionGroups = [];
  bool _loading = true;
  bool _installing = false;
  String? _deletingArtifactId;
  String? _error;
  Map<String, String?> _installedVersions = const <String, String?>{};
  Completer<void>? _installerReturnCompleter;
  final ValueNotifier<InstallProgress?> _progressNotifier =
      ValueNotifier<InstallProgress?>(null);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final seedApplicationId = widget.app.applicationId;
    if (seedApplicationId.isNotEmpty) {
      _installedVersions = <String, String?>{
        seedApplicationId: widget.app.installedVersion,
      };
    }
    _loadArtifacts();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      return;
    }

    final completer = _installerReturnCompleter;
    if (completer == null || completer.isCompleted) {
      return;
    }

    completer.complete();
    _installerReturnCompleter = null;
  }

  Future<void> _loadArtifacts() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final token = widget.authState.token;
      if (token == null || token.isEmpty) {
        throw UnauthorizedException('로그인이 필요합니다.');
      }

      final artifacts = await fetchAppArtifacts(
        appId: widget.app.id,
        token: token,
      );
      final installedVersions = await _resolveInstalledVersions(artifacts);
      if (!mounted) {
        return;
      }

      setState(() {
        _versionGroups = groupArtifactsByVersion(artifacts);
        _installedVersions = installedVersions;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) {
        return;
      }
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _installArtifact(ArtifactInfo artifact) async {
    if (_installing) {
      return;
    }

    setState(() {
      _installing = true;
    });

    final cancellationController = InstallCancellationController();
    final closeDialog = showInstallProgressDialog(
      context: context,
      notifier: _progressNotifier,
      cancellationController: cancellationController,
    );

    try {
      final attempt = await installArtifact(
        artifactUrl: artifact.url,
        packageName: _packageNameForArtifact(artifact),
        targetVersion: artifact.version,
        installedVersionBefore: _installedVersionForArtifact(artifact),
        beginInstallerReturnWatch: _beginInstallerReturnWatch,
        cancellationController: cancellationController,
        onProgress: _updateProgressDialog,
      );

      if (!mounted) {
        return;
      }

      if (attempt.success || attempt.cancelledByUser) {
        _showSnack(attempt.message, isError: false);
        await _loadArtifacts();
        return;
      }

      if (!attempt.needsDowngradeFallback || attempt.downloadedPath == null) {
        _showSnack(attempt.message, isError: true);
        await _loadArtifacts();
        return;
      }

      final confirmed = await _confirmDowngradeFallback();
      if (!confirmed || !mounted) {
        return;
      }

      final reinstall = await reinstallAfterUninstall(
        downloadedPath: attempt.downloadedPath!,
        packageName: _packageNameForArtifact(artifact),
        targetVersion: artifact.version,
        beginInstallerReturnWatch: _beginInstallerReturnWatch,
        cancellationController: cancellationController,
        onProgress: _updateProgressDialog,
      );
      if (!mounted) {
        return;
      }

      _showSnack(
        reinstall.message,
        isError: !reinstall.success && !reinstall.cancelledByUser,
      );
      await _loadArtifacts();
    } catch (e) {
      if (mounted) {
        _showSnack('설치 실패: $e', isError: true);
      }
    } finally {
      _installerReturnCompleter = null;
      closeDialog();
      if (mounted) {
        setState(() {
          _installing = false;
        });
      }
    }
  }

  Future<void> _deleteArtifact(ArtifactInfo artifact) async {
    if (_installing || _deletingArtifactId != null) {
      return;
    }

    final confirmed = await _confirmArtifactDelete(artifact);
    if (!confirmed || !mounted) {
      return;
    }

    setState(() {
      _deletingArtifactId = artifact.id;
    });

    try {
      final token = widget.authState.token;
      if (token == null || token.isEmpty) {
        throw UnauthorizedException('로그인이 필요합니다.');
      }

      await ArtifactsApi().deleteArtifact(
        appId: widget.app.id,
        artifactId: artifact.id,
        token: token,
      );
      if (!mounted) {
        return;
      }

      _showSnack('아티팩트를 삭제했습니다.');
      await _loadArtifacts();
    } catch (e) {
      if (!mounted) {
        return;
      }
      _showSnack('삭제 실패: $e', isError: true);
    } finally {
      if (mounted) {
        setState(() {
          _deletingArtifactId = null;
        });
      }
    }
  }

  void _updateProgressDialog(InstallProgress progress) {
    _progressNotifier.value = progress;
  }

  Future<void> _beginInstallerReturnWatch() {
    final completer = Completer<void>();
    _installerReturnCompleter = completer;
    return completer.future;
  }

  Future<bool> _confirmDowngradeFallback() async {
    final result = await showDialog<bool>(
      context: context,
      builder:
          (context) => AlertDialog(
            title: const Text('다운그레이드 재설치 필요'),
            content: const Text(
              '현재 버전이 더 높아 직접 설치가 실패했습니다.\n기존 앱을 삭제한 뒤 재설치할까요?',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('취소'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('삭제 후 재설치'),
              ),
            ],
          ),
    );

    return result ?? false;
  }

  Future<bool> _confirmArtifactDelete(ArtifactInfo artifact) async {
    final result = await showDialog<bool>(
      context: context,
      builder:
          (context) => AlertDialog(
            title: const Text('아티팩트 삭제'),
            content: Text(
              'v${artifact.version} 아티팩트를 삭제할까요?\n삭제 후에는 목록에서 사라집니다.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('취소'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('삭제'),
              ),
            ],
          ),
    );

    return result ?? false;
  }

  String _packageNameForArtifact(ArtifactInfo artifact) {
    return artifact.applicationId.isNotEmpty
        ? artifact.applicationId
        : widget.app.applicationId;
  }

  // Build variants (release vs `.debug`) install under distinct applicationIds,
  // so resolve the installed version per applicationId rather than assuming a
  // single package for the whole app.
  Future<Map<String, String?>> _resolveInstalledVersions(
    List<ArtifactInfo> artifacts,
  ) async {
    final applicationIds = <String>{};
    for (final artifact in artifacts) {
      final id = _packageNameForArtifact(artifact);
      if (id.isNotEmpty) {
        applicationIds.add(id);
      }
    }
    if (applicationIds.isEmpty && widget.app.applicationId.isNotEmpty) {
      applicationIds.add(widget.app.applicationId);
    }

    final entries = await Future.wait(
      applicationIds.map(
        (id) async => MapEntry(id, await findInstalledVersion(id)),
      ),
    );
    return <String, String?>{
      for (final entry in entries) entry.key: entry.value,
    };
  }

  String? _installedVersionForArtifact(ArtifactInfo artifact) {
    return _installedVersions[_packageNameForArtifact(artifact)];
  }

  // Install state for the summary card: prefer the latest artifact's own build
  // variant, but fall back to whichever variant is actually installed so an app
  // installed as `.debug` (or an older version) is not mislabelled as missing.
  String? _summaryInstalledVersion(ArtifactInfo? latestArtifact) {
    if (latestArtifact != null) {
      final preferred = _installedVersionForArtifact(latestArtifact);
      if (preferred != null) {
        return preferred;
      }
    }
    for (final version in _installedVersions.values) {
      if (version != null) {
        return version;
      }
    }
    return null;
  }

  void _showSnack(String message, {bool isError = false}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? Colors.red : null,
      ),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _progressNotifier.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.app.name)),
      body: RefreshIndicator(onRefresh: _loadArtifacts, child: _buildBody()),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(height: 180),
          Center(child: CircularProgressIndicator()),
        ],
      );
    }

    if (_error != null) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          const SizedBox(height: 100),
          _DetailStateCard(
            icon: Icons.error_outline_rounded,
            title: '릴리스 정보를 불러오지 못했습니다',
            body: _error!,
          ),
        ],
      );
    }

    final latestArtifact =
        _versionGroups.isEmpty ? null : _versionGroups.first.topArtifact;
    final latestVersion = latestArtifact?.version ?? widget.app.version;
    final heroInstalledVersion = _summaryInstalledVersion(latestArtifact);
    final state = resolveAppInstallState(latestVersion, heroInstalledVersion);
    final currentApp = AppInfo(
      id: widget.app.id,
      name: widget.app.name,
      package: widget.app.package,
      description: widget.app.description,
      latestArtifact: latestArtifact ?? widget.app.latestArtifact,
      installedVersion: heroInstalledVersion,
      needsUpdate: checkIfNeedToUpdate(latestVersion, heroInstalledVersion),
      home: widget.app.home,
    );
    final home = widget.app.home;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(
        parent: BouncingScrollPhysics(),
      ),
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
      children: [
        AppSummaryCard(
          app: currentApp,
          state: state,
          installedVersion: heroInstalledVersion,
          // Straight to the app's project issues — the app *is* the project.
          action:
              home == null
                  ? null
                  : ProjectIssuesButton(
                    authState: widget.authState,
                    home: home,
                  ),
          extraChips: [
            CatalogStateChip(
              label: state == AppInstallState.latest ? '최신' : '최신 아님',
              color:
                  state == AppInstallState.latest
                      ? CatalogPalette.ocean
                      : CatalogPalette.slate,
            ),
            CatalogValueChip(
              icon: Icons.download_done_rounded,
              value: latestVersion,
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (latestArtifact == null)
          const _DetailStateCard(
            icon: Icons.archive_outlined,
            title: '사용 가능한 Android 아티팩트가 없습니다',
            body: '새 빌드가 업로드되면 이 화면에 표시됩니다.',
          )
        else
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        '버전',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const Spacer(),
                      Text(
                        '${_versionGroups.length}개',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  ..._versionGroups.asMap().entries.map((entry) {
                    final index = entry.key;
                    final group = entry.value;
                    return Padding(
                      padding: EdgeInsets.only(
                        bottom: index == _versionGroups.length - 1 ? 0 : 10,
                      ),
                      child: ArtifactVersionGroupCard(
                        group: group,
                        latestVersion: latestVersion,
                        installedVersionForArtifact:
                            _installedVersionForArtifact,
                        busy: _installing || _deletingArtifactId != null,
                        onInstallArtifact: _installArtifact,
                        onDeleteArtifact: _deleteArtifact,
                        deletingArtifactId: _deletingArtifactId,
                      ),
                    );
                  }),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _DetailStateCard extends StatelessWidget {
  const _DetailStateCard({
    required this.icon,
    required this.title,
    required this.body,
  });

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: CatalogPalette.sky,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Icon(icon, color: CatalogPalette.ocean),
          ),
          const SizedBox(height: 14),
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Text(body, textAlign: TextAlign.center),
        ],
      ),
    );
  }
}
