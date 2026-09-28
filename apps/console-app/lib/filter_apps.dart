import 'package:yyt_console/app_info.dart';

/// The app tabs' local search: a case-insensitive `contains` over the name,
/// description, package, version, release note, build type and every tag.
/// `query` is already trimmed and lower-cased; empty means no filter.
List<AppInfo> filterAppsByQuery(List<AppInfo> source, String query) {
  if (query.isEmpty) {
    return source;
  }
  return source.where((app) {
    final values = <String>[
      app.name,
      app.description,
      app.package,
      app.version,
      app.releaseNote,
      app.buildType,
      ...app.tags.values,
    ];
    return values.any((value) => value.toLowerCase().contains(query));
  }).toList();
}
