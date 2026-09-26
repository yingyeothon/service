import 'package:yyt_console/projects/models.dart';

/// Static sites (services/console/src/sites.ts `siteViews`, `deployView`).
/// `domain`, `hostUrl`, `hostSuffix`, `movingTo` and a deploy's `moveTo`
/// arrived with site names (docs/decisions.md *Site domains*); an older
/// server omits them and they read as null.
String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

int _int(Object? v) => v is num ? v.toInt() : 0;

/// Byte-identical to `SITE_SHARED_ORIGIN_WARNING` (services/console and the
/// web console) and the CLI help (docs/decisions.md *Static sites* §1): the
/// create form shows it before the server can. English on purpose, like the
/// `warning` the site detail renders verbatim.
const siteSharedOriginWarning =
    'Every site on this host shares one origin: another site here can read '
    'this page, its storage and its in-memory state (same-origin frames). '
    'Never keep a credential (JWT, API token) in localStorage, sessionStorage '
    'or IndexedDB; use short-lived tokens minted per session and treat this '
    'host as untrusted.';

enum SiteState { deploying, moving, live, empty }

String siteStateLabel(SiteState s) => switch (s) {
  SiteState.deploying => '배포 중',
  SiteState.moving => '이동 중',
  SiteState.live => '라이브',
  SiteState.empty => '비어 있음',
};

class Site {
  const Site({
    required this.id,
    required this.name,
    required this.slug,
    required this.description,
    required this.publicUrl,
    required this.basePath,
    required this.currentDeployId,
    required this.busy,
    required this.createdAt,
    required this.updatedAt,
    this.teamId,
    this.teamName,
    this.projectId,
    this.projectName,
    this.createdBy,
    this.domain,
    this.hostUrl,
    this.hostSuffix,
    this.movingTo,
  });

  final String id;
  final String name;
  final String slug;
  final String? description;

  /// The path URL on the shared host (`https://g.yyt.life/{slug}/`).
  final String publicUrl;
  final String basePath;
  final String? currentDeployId;

  /// A deploy, a move or a delete holds the site.
  final bool busy;
  final DateTime createdAt;
  final DateTime updatedAt;
  final String? teamId;
  final String? teamName;
  final String? projectId;
  final String? projectName;
  final String? createdBy;

  /// The team-chosen name, or null while the site keeps its random slug.
  final String? domain;

  /// The site's own origin (`https://{slug}.g.yyt.life/`); null on a stage
  /// without the name host.
  final String? hostUrl;

  /// `g.yyt.life`; null = this stage has no name host.
  final String? hostSuffix;

  /// Target slug of an in-flight move.
  final String? movingTo;

  /// The primary link (docs/decisions.md *Site domains* §10): a named site's
  /// own host; an unnamed site's path URL, since it may be a `/{slug}/` build
  /// that only works there.
  String get displayUrl => domain != null ? (hostUrl ?? publicUrl) : publicUrl;

  /// The other address of the site, when it has two.
  String? get otherUrl {
    if (hostUrl == null) return null;
    return displayUrl == hostUrl ? publicUrl : hostUrl;
  }

  /// A deploy or a move holds the site: a domain change would be a 409, and
  /// the team's one-per-second name slot is spent before that check.
  bool get held => busy || movingTo != null;

  SiteState get state =>
      movingTo != null
          ? SiteState.moving
          : busy
          ? SiteState.deploying
          : currentDeployId != null
          ? SiteState.live
          : SiteState.empty;

  static Site fromJson(Map<String, dynamic> j) => Site(
    id: j['id'] as String,
    name: (j['name'] as String?) ?? '',
    slug: (j['slug'] as String?) ?? '',
    description: _str(j['description']),
    publicUrl: (j['publicUrl'] as String?) ?? '',
    basePath: (j['basePath'] as String?) ?? '',
    currentDeployId: _str(j['currentDeployId']),
    busy: j['busy'] == true,
    createdAt: fromUnixSeconds(j['createdAt']),
    updatedAt: fromUnixSeconds(j['updatedAt']),
    teamId: _str(j['teamId']),
    teamName: _str(j['teamName']),
    projectId: _str(j['projectId']),
    projectName: _str(j['projectName']),
    createdBy: _str(j['createdBy']),
    domain: _str(j['domain']),
    hostUrl: _str(j['hostUrl']),
    hostSuffix: _str(j['hostSuffix']),
    movingTo: _str(j['movingTo']),
  );
}

class SiteDeploy {
  const SiteDeploy({
    required this.id,
    required this.status,
    required this.zipBytes,
    required this.bytes,
    required this.files,
    required this.createdAt,
    this.error,
    this.createdBy,
    this.moveTo,
  });

  final String id;

  /// `pending` | `queued` | `extracting` | `live` | `failed`.
  final String status;
  final int zipBytes;
  final int bytes;
  final int files;
  final DateTime createdAt;

  /// Fixed machine code on `failed` (`zip_no_index_html`, `worker_lost`, …).
  final String? error;
  final String? createdBy;

  /// Set on a move deploy (a rename), not an upload.
  final String? moveTo;

  bool get isMove => moveTo != null;

  static SiteDeploy fromJson(Map<String, dynamic> j) => SiteDeploy(
    id: j['id'] as String,
    status: (j['status'] as String?) ?? '',
    zipBytes: _int(j['zipBytes']),
    bytes: _int(j['bytes']),
    files: _int(j['files']),
    createdAt: fromUnixSeconds(j['createdAt']),
    error: _str(j['error']),
    createdBy: _str(j['createdBy']),
    moveTo: _str(j['moveTo']),
  );
}

String siteDeployStatusLabel(String status) => switch (status) {
  'pending' => '업로드 대기',
  'queued' => '대기 중',
  'extracting' => '처리 중',
  'live' => '라이브',
  'failed' => '실패',
  _ => status,
};

/// `GET /sites/{id}`: the view plus the newest deploys and the shared-origin
/// warning (rendered verbatim).
class SiteDetail {
  const SiteDetail({
    required this.site,
    required this.currentDeploy,
    required this.deploys,
    required this.warning,
  });

  final Site site;
  final SiteDeploy? currentDeploy;
  final List<SiteDeploy> deploys;
  final String? warning;

  static SiteDetail fromJson(Map<String, dynamic> j) => SiteDetail(
    site: Site.fromJson(j),
    currentDeploy:
        j['currentDeploy'] is Map<String, dynamic>
            ? SiteDeploy.fromJson(j['currentDeploy'] as Map<String, dynamic>)
            : null,
    deploys:
        ((j['deploys'] as List<dynamic>?) ?? const [])
            .cast<Map<String, dynamic>>()
            .map(SiteDeploy.fromJson)
            .toList(),
    warning: _str(j['warning']),
  );
}

/// `PATCH /sites/{id}`: 200 = applied, 202 = a move was queued (the view
/// then says `busy` and `movingTo`).
class SiteUpdate {
  const SiteUpdate({required this.site, required this.moveQueued});

  final Site site;
  final bool moveQueued;
}

/// Site name grammar (docs/decisions.md *Site domains* §3). A client-side
/// hint only: the reserved list and the uniqueness rules are the server's.
final siteDomainPattern = RegExp(r'^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$');

/// Trimmed and lower-cased, the way the server stores it.
String normalizeSiteDomain(String input) => input.trim().toLowerCase();

/// Korean hint for a (normalized) name, or null when it looks valid. Blank is
/// valid: it releases the name.
String? validateSiteDomain(String normalized) {
  if (normalized.isEmpty) return null;
  if (normalized.length < 3 || normalized.length > 32) {
    return '3~32자로 입력하세요.';
  }
  if (!siteDomainPattern.hasMatch(normalized)) {
    return '영문 소문자, 숫자, -만 쓸 수 있고 -로 시작하거나 끝날 수 없습니다.';
  }
  if (normalized.contains('--')) return '-를 연달아 쓸 수 없습니다.';
  return null;
}

/// Site names (not the domain): 1–64 of letters, digits, `_`, `-`, starting
/// with a letter or digit, not shaped like an id (services/console/src/team.ts
/// `resourceName` + sites.ts `SITE_NAME`).
final _siteName = RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$');
final _idLike = RegExp(
  r'^(team|prj|ver|iss|dsc|cmt|lnk|ca|ab|art|af|st|sd|kv|lb|auth|topic|match|lobby|q|m|tok|dbg|up)_',
  caseSensitive: false,
);

String? validateSiteName(String trimmed) {
  if (trimmed.isEmpty) return '이름을 입력하세요.';
  if (!_siteName.hasMatch(trimmed)) {
    return '영문·숫자로 시작하고 영문, 숫자, _, -만 64자까지 쓸 수 있습니다.';
  }
  if (_idLike.hasMatch(trimmed)) return 'id처럼 보이는 이름(st_… 등)은 쓸 수 없습니다.';
  return null;
}

/// The body of an edit: only the keys that changed. A blank description or
/// domain clears it (`null`); [domain] is null when the form has no domain
/// field, and then the key is never sent.
Map<String, Object?> buildSitePatch(
  Site site, {
  required String name,
  required String description,
  String? domain,
}) {
  final body = <String, Object?>{};
  final n = name.trim();
  if (n != site.name) body['name'] = n;
  final d = description.trim();
  if (d != (site.description ?? '')) body['description'] = d.isEmpty ? null : d;
  if (domain != null) {
    final dn = normalizeSiteDomain(domain);
    if (dn != (site.domain ?? '')) body['domain'] = dn.isEmpty ? null : dn;
  }
  return body;
}
