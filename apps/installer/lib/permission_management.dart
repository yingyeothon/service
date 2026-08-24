import 'package:catalog/api/permissions_api.dart';
import 'package:catalog/auth/auth_state.dart';
import 'package:flutter/material.dart';

class PermissionManagementScreen extends StatefulWidget {
  const PermissionManagementScreen({
    super.key,
    required this.appName,
    required this.authState,
  });

  final String appName;
  final AuthState authState;

  @override
  State<PermissionManagementScreen> createState() =>
      _PermissionManagementScreenState();
}

class _PermissionManagementScreenState
    extends State<PermissionManagementScreen> {
  final PermissionsApi _api = PermissionsApi();
  List<Permission> _permissions = [];
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _loadPermissions();
  }

  Future<void> _loadPermissions() async {
    setState(() {
      _isLoading = true;
    });

    try {
      final token = widget.authState.token;
      if (token == null) {
        throw Exception('로그인이 필요합니다');
      }

      final permissions = await _api.listAppPermissions(widget.appName, token);
      setState(() {
        _permissions = permissions;
        _isLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isLoading = false;
      });
      _showError('권한 목록 로드 실패: $e');
    }
  }

  Future<void> _addPermission() async {
    final result = await showDialog<Map<String, String>>(
      context: context,
      builder: (context) => const _AddPermissionDialog(),
    );

    if (result == null) return;

    final username = result['username']!;
    final level = result['level']!;

    try {
      final token = widget.authState.token;
      if (token == null) {
        throw Exception('로그인이 필요합니다');
      }

      await _api.addAppPermission(widget.appName, username, level, token);
      if (!mounted) return;
      _showSuccess('권한이 추가되었습니다');
      await _loadPermissions();
    } catch (e) {
      if (!mounted) return;
      _showError('권한 추가 실패: $e');
    }
  }

  Future<void> _updatePermission(Permission permission, String newLevel) async {
    try {
      final token = widget.authState.token;
      if (token == null) {
        throw Exception('로그인이 필요합니다');
      }

      // Console permissions upsert on POST: same call as add.
      await _api.addAppPermission(
        widget.appName,
        permission.username,
        newLevel,
        token,
      );
      if (!mounted) return;
      _showSuccess('권한이 수정되었습니다');
      await _loadPermissions();
    } catch (e) {
      if (!mounted) return;
      _showError('권한 수정 실패: $e');
    }
  }

  Future<void> _deletePermission(Permission permission) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder:
          (context) => AlertDialog(
            title: const Text('권한 삭제'),
            content: Text('${permission.username}의 권한을 삭제하시겠습니까?'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('취소'),
              ),
              TextButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('삭제'),
              ),
            ],
          ),
    );

    if (confirmed != true) return;

    try {
      final token = widget.authState.token;
      if (token == null) {
        throw Exception('로그인이 필요합니다');
      }

      await _api.removeAppPermission(widget.appName, permission.id, token);
      if (!mounted) return;
      _showSuccess('권한이 삭제되었습니다');
      await _loadPermissions();
    } catch (e) {
      if (!mounted) return;
      _showError('권한 삭제 실패: $e');
    }
  }

  void _showSuccess(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('${widget.appName} 권한 관리')),
      body:
          _isLoading
              ? const Center(child: CircularProgressIndicator())
              : _permissions.isEmpty
              ? const Center(child: Text('권한이 없습니다'))
              : ListView.builder(
                itemCount: _permissions.length,
                itemBuilder: (context, index) {
                  final permission = _permissions[index];
                  return _buildPermissionCard(permission);
                },
              ),
      floatingActionButton: FloatingActionButton(
        onPressed: _addPermission,
        child: const Icon(Icons.add),
      ),
    );
  }

  Widget _buildPermissionCard(Permission permission) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: ListTile(
        title: Text(permission.username),
        subtitle: Text('권한: ${_getLevelLabel(permission.permissionLevel)}'),
        trailing: PopupMenuButton<String>(
          onSelected: (value) {
            if (value == 'delete') {
              _deletePermission(permission);
            } else if (value == 'read' || value == 'edit') {
              _updatePermission(permission, value);
            }
          },
          itemBuilder:
              (context) => [
                const PopupMenuItem(value: 'read', child: Text('읽기로 변경')),
                const PopupMenuItem(value: 'edit', child: Text('편집으로 변경')),
                const PopupMenuDivider(),
                const PopupMenuItem(value: 'delete', child: Text('삭제')),
              ],
        ),
      ),
    );
  }

  String _getLevelLabel(String level) {
    switch (level) {
      case 'read':
        return '읽기';
      case 'edit':
        return '편집';
      default:
        return level;
    }
  }
}

class _AddPermissionDialog extends StatefulWidget {
  const _AddPermissionDialog();

  @override
  State<_AddPermissionDialog> createState() => _AddPermissionDialogState();
}

class _AddPermissionDialogState extends State<_AddPermissionDialog> {
  final _usernameController = TextEditingController();
  String _selectedLevel = 'read';

  @override
  void dispose() {
    _usernameController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('권한 추가'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _usernameController,
            decoration: const InputDecoration(
              labelText: 'GitHub Username',
              hintText: 'username',
            ),
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            initialValue: _selectedLevel,
            decoration: const InputDecoration(labelText: '권한 레벨'),
            items: const [
              DropdownMenuItem(value: 'read', child: Text('읽기')),
              DropdownMenuItem(value: 'edit', child: Text('편집')),
            ],
            onChanged: (value) {
              if (value != null) {
                setState(() {
                  _selectedLevel = value;
                });
              }
            },
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('취소'),
        ),
        TextButton(
          onPressed: () {
            final username = _usernameController.text.trim();
            if (username.isEmpty) {
              return;
            }
            Navigator.pop(context, {
              'username': username,
              'level': _selectedLevel,
            });
          },
          child: const Text('추가'),
        ),
      ],
    );
  }
}
