import 'package:yyt_console/catalog_platform.dart';
import 'package:flutter/material.dart';

/// iOS / Android / 전체 above a catalog list; changing it updates [platform],
/// which the list listens to and reloads on.
class CatalogPlatformSelector extends StatelessWidget {
  const CatalogPlatformSelector({super.key, required this.platform});

  final ValueNotifier<CatalogPlatform> platform;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<CatalogPlatform>(
      valueListenable: platform,
      builder: (context, value, _) => SizedBox(
        width: double.infinity,
        child: SegmentedButton<CatalogPlatform>(
          showSelectedIcon: false,
          segments: [
            for (final p in CatalogPlatform.values)
              ButtonSegment(value: p, label: Text(p.label)),
          ],
          selected: {value},
          onSelectionChanged: (s) => platform.value = s.first,
        ),
      ),
    );
  }
}

/// The empty app list's title under [platform].
String noAppsTitle(CatalogPlatform platform) => platform == CatalogPlatform.all
    ? '설치 가능한 앱이 없습니다'
    : '설치 가능한 ${platform.label} 앱이 없습니다';

/// The empty browse tab's title under [platform].
String noListingsTitle(CatalogPlatform platform) =>
    platform == CatalogPlatform.all
    ? '게시된 앱이 없습니다'
    : '게시된 ${platform.label} 앱이 없습니다';
