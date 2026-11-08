import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/site_models.dart' show idLikeName;

/// Tracer resources (services/console/src/tracer.ts `views`, docs/tracer.md):
/// one debug-data collection in the stage's tracer container. The list omits
/// `description`; a platform admin without a seat gets neither `writeKey`
/// nor `dsn`, and `dsn`/`readUrl` are null while the stage has no tracer.
String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

/// What the resource screen says about retention (docs/tracer.md _Storage_).
const tracerNoBackupNotice =
    '백업이 없습니다. 디버그 데이터는 최대 30일 보관되고, 스테이지의 tracer 저장 공간이 '
    '상한에 가까워지면 오래된 것부터 더 일찍 지워집니다. tracer 호스트와 함께 잃은 데이터는 '
    '되살릴 수 없습니다.';

const tracerNotConfigured = '이 스테이지에는 아직 tracer가 없어 DSN을 줄 수 없습니다.';

const tracerRotateNotice =
    '새 쓰기 키가 지금 키를 대신합니다. 지금 DSN을 넣은 디버그 빌드는 1분 안에 거절되니 '
    '새 DSN으로 다시 빌드하세요.';

const tracerDeleteNotice =
    '1분 안에 더 이상 데이터를 받지 않고 이름은 바로 다시 쓸 수 있습니다. '
    'tracer는 7일 유예 뒤 데이터를 지웁니다. 백업은 없습니다.';

class Tracer {
  const Tracer({
    required this.id,
    required this.name,
    required this.createdAt,
    required this.updatedAt,
    this.description,
    this.writeKey,
    this.dsn,
    this.readUrl,
    this.noBackup = true,
    this.teamId,
    this.teamName,
    this.projectId,
    this.projectName,
    this.createdBy,
  });

  final String id;
  final String name;

  /// Only on the single-resource views (GET/PATCH/rotate), never the list.
  final String? description;

  /// Shown to every seated member on purpose: it ships inside debug builds.
  final String? writeKey;
  final String? dsn;
  final String? readUrl;
  final bool noBackup;
  final DateTime createdAt;
  final DateTime updatedAt;
  final String? teamId;
  final String? teamName;
  final String? projectId;
  final String? projectName;
  final String? createdBy;

  factory Tracer.fromJson(Map<String, dynamic> j) => Tracer(
    id: j['id'] as String,
    name: (j['name'] as String?) ?? '',
    description: _str(j['description']),
    writeKey: _str(j['writeKey']),
    dsn: _str(j['dsn']),
    readUrl: _str(j['readUrl']),
    noBackup: j['noBackup'] != false,
    createdAt: fromUnixSeconds(j['createdAt']),
    updatedAt: fromUnixSeconds(j['updatedAt']),
    teamId: _str(j['teamId']),
    teamName: _str(j['teamName']),
    projectId: _str(j['projectId']),
    projectName: _str(j['projectName']),
    createdBy: _str(j['createdBy']),
  );

  /// Read commands for the shell: by id, which needs no project context.
  List<String> get readCommands => [
    'yyt tracer issues $id --since 1h',
    'yyt tracer events $id --since 1h',
    'yyt tracer logs $id --since 1h',
    'yyt tracer usage $id',
    'yyt tracer drops $id',
  ];

  String get limitRequestCommand =>
      'yyt limit request --tracer $id tracer.dailyBytes +50MiB --reason …';
}

/// services/console/src/team.ts `resourceName`: 1–64 of letters, digits,
/// `.`, `_`, `-`, starting with a letter or digit, not shaped like an id.
final _resourceName = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');

String? validateTracerName(String trimmed) {
  if (trimmed.isEmpty) return '이름을 입력하세요.';
  if (!_resourceName.hasMatch(trimmed)) {
    return '영문·숫자로 시작하고 영문, 숫자, ., _, -만 64자까지 쓸 수 있습니다.';
  }
  if (idLikeName.hasMatch(trimmed)) {
    return 'id처럼 보이는 이름(trc_… 등)은 쓸 수 없습니다.';
  }
  return null;
}

/// The body of an edit: only the keys that changed (the route is `.strict()`).
/// A blank description clears it (`null`).
Map<String, Object?> buildTracerPatch(
  Tracer t, {
  required String name,
  required String description,
}) {
  final body = <String, Object?>{};
  final n = name.trim();
  if (n != t.name) body['name'] = n;
  final d = description.trim();
  if (d != (t.description ?? '')) body['description'] = d.isEmpty ? null : d;
  return body;
}
