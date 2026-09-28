import 'package:yyt_console/app_theme.dart';
import 'package:flutter/material.dart';

/// The one-card body of an empty, failed or no-match list.
class CatalogStateCard extends StatelessWidget {
  const CatalogStateCard({
    super.key,
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
