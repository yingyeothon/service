import 'package:yyt_console/app_info.dart';
import 'package:yyt_console/app_install_state.dart';
import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/format_time.dart';
import 'package:yyt_console/artifact_version_group.dart';
import 'package:flutter/material.dart';

class AppSummaryCard extends StatelessWidget {
  const AppSummaryCard({
    super.key,
    required this.app,
    required this.state,
    required this.installedVersion,
    this.onTap,
    this.action,
    this.extraChips = const <Widget>[],
  });

  final AppInfo app;
  final AppInstallState state;
  final String? installedVersion;
  final VoidCallback? onTap;
  final Widget? action;
  final List<Widget> extraChips;

  @override
  Widget build(BuildContext context) {
    final tone = _buildTone(app.buildType);
    final releaseNote = app.releaseNote;
    final content = Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _AppAvatar(name: app.name, color: tone.accent),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          app.name,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        CatalogStateChip(
                          label: _stateLabel(state),
                          color: _stateColor(state),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'v${app.version}${_buildTypeSuffix(app.buildType)}',
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        color: CatalogPalette.ink,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (releaseNote.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(
                        releaseNote,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: CatalogPalette.ink,
                          height: 1.3,
                        ),
                      ),
                    ],
                    const SizedBox(height: 6),
                    Text(
                      app.applicationId,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              CatalogValueChip(
                icon: Icons.phone_android_rounded,
                value: installedVersion ?? '미설치',
              ),
              if (app.latestArtifact.stage.isNotEmpty)
                CatalogValueChip(
                  icon: Icons.flag_rounded,
                  value: app.latestArtifact.stage,
                ),
              ...extraChips,
            ],
          ),
          if (action != null) ...[
            const SizedBox(height: 12),
            Align(alignment: Alignment.centerRight, child: action!),
          ],
        ],
      ),
    );

    final card = Ink(
      decoration: BoxDecoration(
        color: tone.surface,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: tone.border),
      ),
      child: content,
    );

    if (onTap == null) {
      return Material(color: Colors.transparent, child: card);
    }

    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(22),
        onTap: onTap,
        child: card,
      ),
    );
  }
}

class ArtifactReleaseCard extends StatelessWidget {
  const ArtifactReleaseCard({
    super.key,
    required this.artifact,
    required this.latestVersion,
    required this.installedVersion,
    required this.busy,
    required this.onInstall,
    this.onDelete,
    this.deleting = false,
    this.installable = true,
  });

  final ArtifactInfo artifact;
  final String latestVersion;
  final String? installedVersion;
  final bool busy;
  final VoidCallback onInstall;
  final VoidCallback? onDelete;
  final bool deleting;
  final bool installable;

  @override
  Widget build(BuildContext context) {
    final tone = _buildTone(artifact.buildType);
    final isInstalled = isInstalledTargetVersion(
      artifact.version,
      installedVersion,
    );
    final isOldVersion = isOlderArtifactVersion(
      artifact.version,
      latestVersion,
    );
    final publishedAt = formatLocalTime(artifact.createdAt);

    return Material(
      color: Colors.transparent,
      child: Ink(
        decoration: BoxDecoration(
          color: tone.surface,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: tone.border),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text(
                              'v${artifact.version}${_buildTypeSuffix(artifact.buildType)}',
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            if (!isOldVersion)
                              CatalogStateChip(
                                label: '최신',
                                color: CatalogPalette.ocean,
                              ),
                            if (isOldVersion)
                              const CatalogStateChip(
                                label: '옛날 버전',
                                color: CatalogPalette.slate,
                              ),
                            if (isInstalled)
                              const CatalogStateChip(
                                label: '현재 설치됨',
                                color: CatalogPalette.mint,
                              ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          publishedAt,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                        if (artifact.changelog.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text(
                            artifact.changelog,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(
                              context,
                            ).textTheme.bodyMedium?.copyWith(
                              color: CatalogPalette.ink,
                              height: 1.3,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    alignment: WrapAlignment.end,
                    children: [
                      if (onDelete != null)
                        IconButton.filledTonal(
                          tooltip: '아티팩트 삭제',
                          onPressed: busy || deleting ? null : onDelete,
                          icon:
                              deleting
                                  ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                  : const Icon(Icons.delete_outline_rounded),
                        ),
                      if (installable)
                        FilledButton(
                          onPressed: busy || deleting ? null : onInstall,
                          child: Text(isInstalled ? '재설치' : '설치'),
                        )
                      else
                        const CatalogStateChip(
                          label: '설치 불가',
                          color: CatalogPalette.slate,
                        ),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (artifact.applicationId.isNotEmpty)
                    CatalogValueChip(
                      icon: Icons.apps_rounded,
                      value: artifact.applicationId,
                    ),
                  if (artifact.stage.isNotEmpty)
                    CatalogValueChip(
                      icon: Icons.flag_rounded,
                      value: artifact.stage,
                    ),
                  if (artifact.packageType.isNotEmpty)
                    CatalogValueChip(
                      icon: Icons.inventory_2_rounded,
                      value: artifact.packageType,
                    ),
                  if (artifact.abi.isNotEmpty)
                    CatalogValueChip(
                      icon: Icons.memory_rounded,
                      value: artifact.abi,
                    ),
                  if (artifact.arch.isNotEmpty)
                    CatalogValueChip(
                      icon: Icons.memory_rounded,
                      value: artifact.arch,
                    ),
                  if (artifact.size > 0)
                    CatalogValueChip(
                      icon: Icons.sd_storage_rounded,
                      value: _formatBytes(artifact.size),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _formatBytes(int bytes) {
    if (bytes <= 0) {
      return '정보 없음';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    var value = bytes.toDouble();
    var unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    final digits = value >= 100 ? 0 : 1;
    return '${value.toStringAsFixed(digits)} ${units[unitIndex]}';
  }
}

class ArtifactVersionGroupCard extends StatelessWidget {
  const ArtifactVersionGroupCard({
    super.key,
    required this.group,
    required this.latestVersion,
    required this.installedVersionForArtifact,
    required this.busy,
    required this.onInstallArtifact,
    this.onDeleteArtifact,
    this.deletingArtifactId,
  });

  final ArtifactVersionGroup group;
  final String latestVersion;
  final String? Function(ArtifactInfo artifact) installedVersionForArtifact;
  final bool busy;
  final ValueChanged<ArtifactInfo> onInstallArtifact;
  final ValueChanged<ArtifactInfo>? onDeleteArtifact;
  final String? deletingArtifactId;

  @override
  Widget build(BuildContext context) {
    final topArtifact = group.topArtifact;
    final isOldVersion = isOlderArtifactVersion(group.version, latestVersion);
    // A version group can hold multiple build variants (e.g. release and
    // `.debug`) that install under different applicationIds, so it counts as
    // installed when any of its artifacts matches its own installed version.
    final isInstalled = group.artifacts.any(
      (artifact) => isInstalledTargetVersion(
        artifact.version,
        installedVersionForArtifact(artifact),
      ),
    );
    final publishedAt = formatLocalTime(topArtifact.createdAt);

    return Material(
      color: Colors.transparent,
      child: Ink(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: const Color(0xFFDCE4EF)),
        ),
        child: Theme(
          data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
          child: ExpansionTile(
            tilePadding: const EdgeInsets.fromLTRB(16, 10, 12, 10),
            childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            initiallyExpanded: !isOldVersion,
            title: Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  'v${group.version}${_buildTypeSuffix(topArtifact.buildType)}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                if (!isOldVersion)
                  const CatalogStateChip(
                    label: '최신',
                    color: CatalogPalette.ocean,
                  ),
                if (isOldVersion)
                  const CatalogStateChip(
                    label: '옛날 버전',
                    color: CatalogPalette.slate,
                  ),
                if (isInstalled)
                  const CatalogStateChip(
                    label: '현재 설치됨',
                    color: CatalogPalette.mint,
                  ),
              ],
            ),
            subtitle: Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  CatalogValueChip(
                    icon: Icons.schedule_rounded,
                    value: publishedAt,
                  ),
                  CatalogValueChip(
                    icon: Icons.inventory_2_rounded,
                    value: '${group.artifactCount}개',
                  ),
                  if (group.installableCount > 0)
                    CatalogValueChip(
                      icon: Icons.download_done_rounded,
                      value: '설치 가능 ${group.installableCount}개',
                    ),
                ],
              ),
            ),
            children:
                group.artifacts.asMap().entries.map((entry) {
                  final index = entry.key;
                  final artifact = entry.value;
                  return Padding(
                    padding: EdgeInsets.only(
                      bottom: index == group.artifacts.length - 1 ? 0 : 10,
                    ),
                    child: ArtifactReleaseCard(
                      artifact: artifact,
                      latestVersion: latestVersion,
                      installedVersion: installedVersionForArtifact(artifact),
                      busy: busy,
                      deleting: deletingArtifactId == artifact.id,
                      installable: artifact.isInstallableAndroidApk,
                      onInstall: () => onInstallArtifact(artifact),
                      onDelete:
                          onDeleteArtifact == null
                              ? null
                              : () => onDeleteArtifact!(artifact),
                    ),
                  );
                }).toList(),
          ),
        ),
      ),
    );
  }
}

class CatalogStateChip extends StatelessWidget {
  const CatalogStateChip({super.key, required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class CatalogValueChip extends StatelessWidget {
  const CatalogValueChip({super.key, required this.icon, required this.value});

  final IconData icon;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.78),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: CatalogPalette.slate),
          const SizedBox(width: 6),
          Text(
            value,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: CatalogPalette.ink,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _AppAvatar extends StatelessWidget {
  const _AppAvatar({required this.name, required this.color});

  final String name;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Center(
        child: Text(
          _initials(name),
          style: Theme.of(context).textTheme.titleSmall?.copyWith(
            color: CatalogPalette.ink,
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
    );
  }

  String _initials(String value) {
    final words =
        value
            .trim()
            .split(RegExp(r'\s+'))
            .where((word) => word.isNotEmpty)
            .take(2)
            .map((word) => word.substring(0, 1).toUpperCase())
            .join();
    if (words.isNotEmpty) {
      return words;
    }

    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      return '?';
    }
    final end = trimmed.length >= 2 ? 2 : trimmed.length;
    return trimmed.substring(0, end).toUpperCase();
  }
}

String _stateLabel(AppInstallState state) {
  switch (state) {
    case AppInstallState.notInstalled:
      return '미설치';
    case AppInstallState.old:
      return '업데이트 필요';
    case AppInstallState.latest:
      return '현재 설치됨';
    case AppInstallState.newerInstalled:
      return '로컬이 더 최신';
  }
}

Color _stateColor(AppInstallState state) {
  switch (state) {
    case AppInstallState.notInstalled:
      return CatalogPalette.mint;
    case AppInstallState.old:
      return CatalogPalette.glow;
    case AppInstallState.latest:
      return CatalogPalette.ocean;
    case AppInstallState.newerInstalled:
      return CatalogPalette.slate;
  }
}

String _buildTypeSuffix(String buildType) {
  switch (buildType.trim().toLowerCase()) {
    case 'debug':
      return ' (debug)';
    case 'release':
      return ' (release)';
    case 'appbundle':
    case 'aab':
      return ' (aab)';
    default:
      return '';
  }
}

_BuildTone _buildTone(String buildType) {
  switch (buildType.trim().toLowerCase()) {
    case 'debug':
      return const _BuildTone(
        surface: CatalogPalette.debugSurface,
        border: CatalogPalette.debugBorder,
        accent: CatalogPalette.debugAccent,
      );
    case 'release':
    case 'appbundle':
    case 'aab':
      return const _BuildTone(
        surface: CatalogPalette.releaseSurface,
        border: CatalogPalette.releaseBorder,
        accent: CatalogPalette.releaseAccent,
      );
    default:
      return const _BuildTone(
        surface: Colors.white,
        border: Color(0xFFDCE4EF),
        accent: CatalogPalette.sky,
      );
  }
}

class _BuildTone {
  const _BuildTone({
    required this.surface,
    required this.border,
    required this.accent,
  });

  final Color surface;
  final Color border;
  final Color accent;
}
