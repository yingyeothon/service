// Limit requests (docs/decisions.md *Limit requests (soft/hard)*): what a
// scope may hold, the grant an admin gave, and the requests a team filed.
// The registry lives in the console; every row carries its unit, soft and
// hard value, so the app renders and checks without a copy of the table.

/// `number | "unlimited"` on the wire; `null` here is unlimited.
int? limitValueOf(Object? v) => v is num ? v.toInt() : null;

Object limitValueWire(int? v) => v ?? 'unlimited';

/// Korean labels for the registry keys; an unknown key shows as itself.
String limitLabel(String key) => switch (key) {
  'asset.fileBytes' => '파일 크기',
  'asset.bundleBytes' => '번들 크기',
  'asset.projectBytes' => '프로젝트 자산 크기',
  'asset.bundlesPerProject' => '번들 수',
  'asset.versionsPerBundle' => '버전 수',
  'asset.filesPerVersion' => '버전당 파일 수',
  'asset.filesPerBundle' => '파일 수',
  'asset.mutableFileBytes' => '가변 파일 크기',
  'channel.lifetime' => '수명',
  'team.projects' => '프로젝트 수',
  'kv.maxEntries' => '엔트리 캡',
  'kv.maxEntriesPerOwner' => '플레이어당 엔트리 캡',
  'kv.collections' => '컬렉션 수',
  _ => key,
};

const _kib = 1024;
const _mib = 1024 * _kib;
const _gib = 1024 * _mib;

/// Bytes in the binary units the limits are typed in (an exact multiple as
/// it is, else one decimal), counts with thousands separators, seconds as
/// days; `null` (unlimited) as the unit's word.
String formatLimit(String unit, int? v) {
  if (v == null) return unit == 'seconds' ? '만료 없음' : '무제한';
  switch (unit) {
    case 'bytes':
      if (v < _kib) return '$v B';
      final (n, u) = v >= _gib
          ? (_gib, 'GiB')
          : v >= _mib
          ? (_mib, 'MiB')
          : (_kib, 'KiB');
      final x = v / n;
      return '${x == x.roundToDouble() ? x.toInt() : x.toStringAsFixed(1)} $u';
    case 'seconds':
      return '${(v / 86400).round()}일';
    default:
      return _thousands(v);
  }
}

String _thousands(int v) {
  final s = v.toString();
  final out = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) out.write(',');
    out.write(s[i]);
  }
  return out.toString();
}

/// `256MiB`, `3 GiB`, `20000` → bytes or a count; `null` when unreadable.
int? parseLimitInput(String unit, String raw) {
  final t = raw.trim().replaceAll(',', '');
  if (t.isEmpty) return null;
  if (unit != 'bytes') return int.tryParse(t);
  final m = RegExp(
    r'^(\d+(?:\.\d+)?)\s*([KMG]i?B|B)?$',
    caseSensitive: false,
  ).firstMatch(t);
  if (m == null) return null;
  final n = double.parse(m.group(1)!);
  final u = (m.group(2) ?? 'B').toUpperCase().replaceAll('I', '');
  final mult = switch (u) {
    'KB' => _kib,
    'MB' => _mib,
    'GB' => _gib,
    _ => 1,
  };
  final v = n * mult;
  return v == v.roundToDouble() ? v.toInt() : null;
}

class LimitOverride {
  const LimitOverride({
    required this.value,
    required this.expiresAt,
    required this.note,
    required this.grantedByLogin,
    required this.grantedAt,
  });

  final int? value;
  final int? expiresAt;
  final String note;
  final String? grantedByLogin;
  final int grantedAt;

  factory LimitOverride.fromJson(Map<String, dynamic> j) => LimitOverride(
    value: limitValueOf(j['value']),
    expiresAt: (j['expiresAt'] as num?)?.toInt(),
    note: (j['note'] as String?) ?? '',
    grantedByLogin: j['grantedByLogin'] as String?,
    grantedAt: (j['grantedAt'] as num?)?.toInt() ?? 0,
  );
}

/// One row of `GET /limits`.
class LimitRow {
  const LimitRow({
    required this.key,
    required this.unit,
    required this.soft,
    required this.hard,
    required this.effective,
    required this.usage,
    required this.step,
    required this.next,
    required this.override,
  });

  final String key;
  final String unit;
  final int soft;
  final int? hard;
  final int? effective;
  final int? usage;
  final int? step;
  final int? next;
  final LimitOverride? override;

  String get label => limitLabel(key);
  bool get atCeiling =>
      hard != null && effective != null && effective! >= hard!;
  bool get overLimit =>
      usage != null && effective != null && usage! > effective!;

  /// Whether a request may be filed now: not already unlimited, below the
  /// ceiling, and for a stepped key only while `next` names a value
  /// (decisions #2). A lifetime that already has no expiry is refused by the
  /// server (409), so the row hides the button as the SPA does.
  bool get canRequest =>
      effective != null && !atCeiling && (step == null || next != null);

  factory LimitRow.fromJson(Map<String, dynamic> j) => LimitRow(
    key: j['key'] as String,
    unit: (j['unit'] as String?) ?? 'count',
    soft: (j['soft'] as num?)?.toInt() ?? 0,
    hard: limitValueOf(j['hard']),
    effective: limitValueOf(j['effective']),
    usage: (j['usage'] as num?)?.toInt(),
    step: (j['step'] as num?)?.toInt(),
    next: (j['next'] as num?)?.toInt(),
    override: j['override'] is Map<String, dynamic>
        ? LimitOverride.fromJson(j['override'] as Map<String, dynamic>)
        : null,
  );
}

/// A request row (`requestView`), as the lists and `POST /limit-requests` answer it.
class LimitRequest {
  const LimitRequest({
    required this.id,
    required this.teamId,
    required this.scopeKind,
    required this.scopeId,
    required this.scopeName,
    required this.key,
    required this.unit,
    required this.requestedValue,
    required this.status,
    required this.decidedValue,
    required this.decisionNote,
    required this.createdBy,
    required this.createdByLogin,
    required this.createdAt,
    required this.decidedByLogin,
    required this.decidedAt,
  });

  final String id;
  final String teamId;
  final String scopeKind;
  final String scopeId;
  final String? scopeName;
  final String key;
  final String unit;
  final int? requestedValue;
  final String status;
  final int? decidedValue;
  final String? decisionNote;
  final String createdBy;
  final String? createdByLogin;
  final int createdAt;
  final String? decidedByLogin;
  final int? decidedAt;

  bool get pending => status == 'pending';

  factory LimitRequest.fromJson(Map<String, dynamic> j) {
    final scope = (j['scope'] as Map?) ?? const {};
    return LimitRequest(
      id: j['id'] as String,
      teamId: (j['teamId'] as String?) ?? '',
      scopeKind: (scope['kind'] as String?) ?? '',
      scopeId: (scope['id'] as String?) ?? '',
      scopeName: scope['name'] as String?,
      key: j['key'] as String,
      unit: (j['unit'] as String?) ?? 'count',
      requestedValue: limitValueOf(j['requestedValue']),
      status: (j['status'] as String?) ?? 'pending',
      decidedValue: limitValueOf(j['decidedValue']),
      decisionNote: j['decisionNote'] as String?,
      createdBy: (j['createdBy'] as String?) ?? '',
      createdByLogin: j['createdByLogin'] as String?,
      createdAt: (j['createdAt'] as num?)?.toInt() ?? 0,
      decidedByLogin: j['decidedByLogin'] as String?,
      decidedAt: (j['decidedAt'] as num?)?.toInt(),
    );
  }
}

/// `GET /limits?scope=` for one scope.
class LimitsView {
  const LimitsView({
    required this.scopeKind,
    required this.scopeId,
    required this.teamId,
    required this.expiresAt,
    required this.limits,
    required this.pending,
  });

  final String scopeKind;
  final String scopeId;
  final String teamId;
  final int? expiresAt;
  final List<LimitRow> limits;
  final List<LimitRequest> pending;

  factory LimitsView.fromJson(Map<String, dynamic> j) {
    final scope = (j['scope'] as Map?) ?? const {};
    return LimitsView(
      scopeKind: (scope['kind'] as String?) ?? '',
      scopeId: (scope['id'] as String?) ?? '',
      teamId: (j['teamId'] as String?) ?? '',
      expiresAt: (j['expiresAt'] as num?)?.toInt(),
      limits: [
        for (final r in (j['limits'] as List?) ?? const [])
          if (r is Map<String, dynamic>) LimitRow.fromJson(r),
      ],
      pending: [
        for (final r in (j['pending'] as List?) ?? const [])
          if (r is Map<String, dynamic>) LimitRequest.fromJson(r),
      ],
    );
  }
}

/// The server's rule for a value, mirrored so the dialog refuses before the
/// round trip: `null` when [value] may be asked for (`null` value = unlimited).
String? limitValueProblem(LimitRow row, int? value) {
  if (row.hard == null) {
    return value == null ? null : '이 한도는 "무제한"으로만 요청할 수 있습니다.';
  }
  if (value == null) return '이 한도는 무제한으로 요청할 수 없습니다.';
  if (value <= 0) return '1 이상이어야 합니다.';
  if (value > row.hard!) {
    return '상한(${formatLimit(row.unit, row.hard)}) 초과입니다.';
  }
  if (row.step != null) {
    if (row.next == null) return '모든 슬롯을 다 쓴 뒤에 요청할 수 있습니다.';
    if (value != row.next) {
      return '요청 가능한 값은 ${formatLimit(row.unit, row.next)}뿐입니다.';
    }
    return null;
  }
  if (row.effective != null && value <= row.effective!) {
    return '지금의 한도(${formatLimit(row.unit, row.effective)})보다 커야 합니다.';
  }
  return null;
}
