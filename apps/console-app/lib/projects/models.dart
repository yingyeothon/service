/// Console API views (services/console/src/team.ts `teamView`, `projectView`,
/// `issueView`, `commentView`). Only the fields the app shows are parsed.
/// Console timestamps are unix seconds (`nowSec`), not milliseconds.
DateTime _time(Object? v) =>
    v is num
        ? DateTime.fromMillisecondsSinceEpoch(v.toInt() * 1000, isUtc: true)
        : DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);

/// `createdBy` is null when the member no longer exists.
String _login(Object? v) => v is String && v.isNotEmpty ? v : '(알 수 없음)';

String teamRoleLabel(String role) => switch (role) {
  'owner' => '소유자',
  'member' => '멤버',
  'pending' => '승인 대기',
  'admin' => '관리자',
  _ => role,
};

class Team {
  const Team({required this.id, required this.name, required this.role});

  final String id;
  final String name;

  /// `owner` | `member` | `pending` | `admin` (platform admin, unseated).
  final String role;

  bool get canRead => role != 'pending';

  /// Issues and comments need a seat (`secret: true` resource access), which
  /// an unseated platform admin does not have.
  bool get canWrite => role == 'owner' || role == 'member';

  static Team fromJson(Map<String, dynamic> j) => Team(
    id: j['id'] as String,
    name: j['name'] as String,
    role: (j['role'] as String?) ?? 'pending',
  );
}

class Project {
  const Project({
    required this.id,
    required this.teamId,
    required this.name,
    required this.description,
  });

  final String id;
  final String teamId;
  final String name;
  final String description;

  static Project fromJson(Map<String, dynamic> j) => Project(
    id: j['id'] as String,
    teamId: j['teamId'] as String,
    name: j['name'] as String,
    description: (j['description'] as String?) ?? '',
  );
}

class Issue {
  const Issue({
    required this.id,
    required this.projectId,
    required this.number,
    required this.title,
    required this.bodyMd,
    required this.status,
    required this.createdBy,
    required this.createdAt,
    required this.updatedAt,
    this.comments = const [],
  });

  final String id;
  final String projectId;
  final int number;
  final String title;
  final String bodyMd;

  /// `open` | `closed`.
  final String status;
  final String createdBy;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<IssueComment> comments;

  bool get isOpen => status == 'open';

  static Issue fromJson(Map<String, dynamic> j) => Issue(
    id: j['id'] as String,
    projectId: j['projectId'] as String,
    number: (j['number'] as num).toInt(),
    title: j['title'] as String,
    bodyMd: (j['bodyMd'] as String?) ?? '',
    status: (j['status'] as String?) ?? 'open',
    createdBy: _login(j['createdBy']),
    createdAt: _time(j['createdAt']),
    updatedAt: _time(j['updatedAt']),
    comments:
        ((j['comments'] as List<dynamic>?) ?? const [])
            .cast<Map<String, dynamic>>()
            .map(IssueComment.fromJson)
            .toList(),
  );
}

class IssueComment {
  const IssueComment({
    required this.id,
    required this.bodyMd,
    required this.createdBy,
    required this.createdAt,
    required this.mine,
  });

  final String id;
  final String bodyMd;
  final String createdBy;
  final DateTime createdAt;
  final bool mine;

  static IssueComment fromJson(Map<String, dynamic> j) => IssueComment(
    id: j['id'] as String,
    bodyMd: (j['bodyMd'] as String?) ?? '',
    createdBy: _login(j['createdBy']),
    createdAt: _time(j['createdAt']),
    mine: j['mine'] == true,
  );
}

/// A team discussion (`discussionView`); `comments` only on the single-entity
/// route.
class Discussion {
  const Discussion({
    required this.id,
    required this.teamId,
    required this.title,
    required this.bodyMd,
    required this.createdBy,
    required this.createdAt,
    required this.updatedAt,
    required this.mine,
    this.comments = const [],
  });

  final String id;
  final String teamId;
  final String title;
  final String bodyMd;
  final String createdBy;
  final DateTime createdAt;
  final DateTime updatedAt;
  final bool mine;
  final List<IssueComment> comments;

  static Discussion fromJson(Map<String, dynamic> j) => Discussion(
    id: j['id'] as String,
    teamId: (j['teamId'] as String?) ?? '',
    title: j['title'] as String,
    bodyMd: (j['bodyMd'] as String?) ?? '',
    createdBy: _login(j['createdBy']),
    createdAt: _time(j['createdAt']),
    updatedAt: _time(j['updatedAt']),
    mine: j['mine'] == true,
    comments:
        ((j['comments'] as List<dynamic>?) ?? const [])
            .cast<Map<String, dynamic>>()
            .map(IssueComment.fromJson)
            .toList(),
  );
}
