# AWS Cost Optimization: CloudWatch Alarms and S3

Status: **A applied 2026-08-26** (10-alarm design, dev + prod auth/topic/match;
console/state prod follow the state-prod prerequisites) and **B-1 applied to the
dev bucket**; prod bucket, B-2 and C are open.

Revision 2026-08-26: the user chose a stricter target than section A below —
**stay inside the 10-alarm account free tier, $0/month**, with the minimum
signal set: prod 8 (`auth`/`console`/`state` Lambda `Errors`, console
`expire-errors`, match `tick-errors`, topic `authorize-errors`, match+topic
`ws-errors`) + dev 2 (match/topic `ws-errors`). Any 11th alarm needs a user
decision (`rules/serverless-aws.md`). The baseline below was also stale: 40
alarms existed, not 34 (a fifth `state` stack, throttle alarms deployed to dev
only, `authorizer-throttles` on topic), and the prod SNS topic had no
subscription at all (subscribed 2026-08-26, confirmation pending). Section A's
15-alarm table is kept as the analysis that ranked the signals; the retained
set is the top of that ranking.

Last reviewed: 2026-08-25 KST. All cost figures are USD/month estimates for
`ap-northeast-2`. Recheck Cost Explorer after a complete billing month because
the alarms were created recently and billing data lags live resources.

## Goals

- Reduce CloudWatch alarm cost without removing the only signal for a production
  failure mode.
- Reduce S3 storage cost before deleting durable or externally referenced binary
  artifacts.
- Make all changes through source-controlled CloudFormation/lifecycle policy,
  with a preview and an explicit approval gate for destructive work.
- Target an immediate alarm saving of about `$1.90/month`, plus a conditional
  S3 saving of `$0–1/month` after Intelligent-Tiering has observed access for at
  least 30 days.

## Verified baseline

### CloudWatch

- 34 standard alarms exist: 17 dev and 17 prod.
- The eight `services/{auth,console,match,topic}` × `{dev,prod}` stacks own all
  alarms. Deleting alarms in the AWS console is temporary; the next deployment
  recreates them.
- All alarms are currently `OK`. No real `ALARM` transition was observed in the
  short post-deployment sample, and sampled errors/throttles were zero.
- All alarms use `TreatMissingData: notBreaching`. They monitor error volume, not
  service liveness: no traffic, a missing scheduled invocation, or an absent
  metric can still remain `OK`.
- Dev email delivery is confirmed. Prod email delivery is still pending, so prod
  alarms currently have no confirmed human response path.
- The four WebSocket `MessageCount` alarms use thresholds of 100,000 or 200,000
  messages/hour. Sampled dev maxima were 90 and 33; prod had no samples. These
  thresholds do not provide useful protection at current traffic levels.
- Expected steady alarm charge is `$2.40/month` with the standard 10-alarm free
  tier (`34 - 10` billable metrics at `$0.10`).

### S3

- Total measured storage is about 94.7 GiB; roughly 98% is in the two binary
  catalog distribution buckets already configured in `services/console`.
- Production binary storage: about 93.6 decimal GB / 820 objects. About 92.6 GB
  is older than 90 days and 6.5 GB is older than 365 days.
- Dev binary storage: about 6.4 decimal GB / 129 objects. About 2.6 GB is older
  than 90 days.
- Binary artifacts are all Standard class; the two buckets have neither
  versioning nor lifecycle rules. Lifecycle expiration is therefore permanent.
- Production data is primarily APK, IPA, and AAB files grouped by application
  prefix. Object age alone does not establish that a public download is unused.
- The shared Serverless deployment bucket is versioned and holds 445 noncurrent
  versions (about 1.42 GB) plus 445 delete markers. Its maximum possible saving
  is only about `$0.03–0.04/month`, and the amount already noncurrent for 30 days
  has not yet been calculated.
- Current S3 cost is about `$2.4–2.7/month`; request cost is negligible relative
  to storage.

All storage estimates use current Seoul-region list prices before tax. Absolute
free-tier charges can change if other account alarms consume the allowance; the
count-reduction saving is unaffected.

## A. CloudWatch alarm reduction

### Decision: retain 15 production alarms

Remove all 17 dev alarms. Retain these 15 prod alarms:

| Service | Retained signal              | Reason                                                                        |
| ------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Auth    | API Lambda `Errors`          | Application/runtime failure                                                   |
| Auth    | API Gateway `5xx`            | Gateway/integration failure not guaranteed to appear as Lambda `Errors`       |
| Console | API Lambda `Errors`          | Application/runtime failure                                                   |
| Console | API Gateway `5xx`            | Gateway/integration failure                                                   |
| Console | expiry Lambda `Errors`       | Daily cleanup can fail without request traffic                                |
| Match   | WebSocket Lambda `Errors`    | Client/message handler failure                                                |
| Match   | worker Lambda `Errors`       | Async match dispatch failure                                                  |
| Match   | tick Lambda `Errors`         | Scheduled timeout processing failure                                          |
| Match   | custom authorize errors      | Handled dependency failures become Deny and may not increment Lambda `Errors` |
| Topic   | HTTP Lambda `Errors`         | HTTP handler failure                                                          |
| Topic   | HTTP Lambda `Throttles`      | Throttled invocations do not increment `Errors`                               |
| Topic   | WebSocket Lambda `Errors`    | WebSocket handler failure                                                     |
| Topic   | WebSocket Lambda `Throttles` | Throttling can silently drop WebSocket messages                               |
| Topic   | authorizer Lambda `Errors`   | Authorizer failure prevents handler execution                                 |
| Topic   | custom authorize errors      | Handled Redis/MySQL failures can deny all connections without Lambda `Errors` |

Remove these two prod alarms:

- Match and Topic message-count alarms: thresholds are orders of magnitude above
  observed traffic and are not actionable capacity guards.

Result: 34 → 15 alarms. Expected charge becomes about `$0.50/month` if the account
retains the full 10-alarm free tier, or `$1.50/month` without it. The saving is `$1.90/month` in
either case.

An aggressive 13-alarm option removes both custom authorize alarms and saves an
additional `$0.20/month`, but it can miss a complete Match/Topic authentication
outage when dependency failures are handled as Deny. An extreme 10-alarm option
also removes the Topic authorizer Lambda and both throttle alarms, saving another
`$0.30/month`. Neither is the default because each removes the only signal for a
production failure mode. Record an explicit coverage exception first.

### Source changes

Add a stage-aware alarm condition to each service template so dev deployments do
not create alarms. Prefer one shared convention, for example:

```yaml
custom:
  alarmsEnabled:
    dev: false
    prod: true

resources:
  Conditions:
    AlarmsEnabled:
      !Equals ["${self:custom.alarmsEnabled.${self:custom.stage}}", "true"]
```

Attach `Condition: AlarmsEnabled` to retained alarm resources. Remove unused prod
alarm resources from the source templates rather than conditionally keeping dead
configuration:

- `services/auth/serverless.yml`: retain both alarm resources, prod only.
- `services/console/serverless.yml`: retain all three alarm resources, prod only.
- `services/match/serverless.yml`: retain `WsErrorsAlarm`, `WorkerErrorsAlarm`,
  `TickErrorsAlarm`, `AuthorizeErrorsAlarm`, and its metric filter; remove
  `WsMessageCountAlarm`.
- `services/topic/serverless.yml`: retain handler errors/throttles and
  both authorizer signals; remove `WsMessageCountAlarm`.
- Update `rules/serverless-aws.md`, whose current cost-guard text still requires
  message-count alarms.
- Update `services/match/README.md` and `services/topic/README.md` so their alarm
  inventories match the retained set.

Do not combine many metrics into one metric-math alarm only to reduce the visible
alarm count. CloudWatch charges based on alarm metrics evaluated, and a large
combined expression is harder to diagnose.

### Alarm implementation checklist

- [x] Confirm the prod SNS subscription before approving the alarm design (subscribed 2026-08-26; user confirms the email). If the
      email cannot be confirmed, choose a real owner/channel or explicitly remove
      alarms that nobody will act on.
- [x] Add stage-aware alarm conditions to all five service templates (`Condition: IsProd`).
- [x] Remove the two message-count alarms and their obsolete rule/README text.
- [x] For each service, run `AWS_PROFILE=yyt pnpm --dir "services/$service" exec serverless package --stage dev`.
- [x] Confirm each retained alarm resource has `Condition: IsProd` (implemented instead of the `alarmsEnabled` map sketched above; the two dev `ws-errors` alarms carry no condition) and
      the rendered dev condition is false; a CloudFormation condition does not
      remove it from the package.

- [x] Package prod for all five services and confirm exactly 8 guarded alarms with
      a true prod condition remain, with the expected logical IDs, dimensions,
      thresholds, and alarm actions.
- [x] Create/review CloudFormation change sets. Expected destructive diff: remove
      30 alarms (40 → 10); no Lambda/API/data resource replacement.
- [x] Obtain explicit approval for the observability reduction before deployment (2026-08-26).
- [x] Deploy dev first and verify only the two dev `ws-errors` alarms remain.
- [ ] Deploy prod (auth/topic/match done 2026-08-26; console/state after the state-prod prerequisites); verify 8 alarms are `OK` and all point
      to the confirmed prod notification topic.
- [ ] Recheck Cost Explorer after one complete month for
      `CW:AlarmMonitorUsage`; verify 10 alarm metrics exist and that free-tier
      application produces the expected net cost instead of assuming the usage
      quantity itself will be five.

### Alarm acceptance criteria

- Dev stacks contain no CloudWatch alarms.
- Prod contains exactly the 8 alarms in the 2026-08-26 revision note (the 15-alarm table is the superseded ranking).
- There is a confirmed, owned prod notification destination.
- With explicit approval, use `cloudwatch set-alarm-state` on one retained alarm
  to test AlarmActions without changing its CloudFormation-owned threshold;
  verify delivery and let metric evaluation restore it (or set it back to `OK`).
- No source rule, service README, or TODO still claims that message-count alarms
  are required.
- The team explicitly accepts that these failure alarms do not provide scheduled
  job or service-liveness monitoring when missing data is non-breaching.

## B. S3 storage-class optimization

### Phase 1: Intelligent-Tiering without expiration

Transition existing and future objects in the two binary catalog buckets to
S3 Intelligent-Tiering. This is intentionally non-destructive.

Important timing and cost behavior:

- Existing Standard objects first enter Intelligent-Tiering Frequent Access, at
  approximately the Standard storage rate.
- They move to Infrequent Access only after 30 consecutive days without access.
- First-month saving is approximately `$0` and can be slightly negative because
  of transition requests and per-object monitoring.
- During days 30–89, saving is expected to be `$0–1/month`, depending on actual
  access. Last-modified age is not evidence of no access. After 90 days, cold
  objects may enter Archive Instant Access and save more; do not count that until
  the observed tier distribution supports it.
- Keep optional asynchronous Archive Access and Deep Archive Access tiers disabled
  for the first rollout. The default Archive Instant Access tier remains
  millisecond-accessible.
- Do not choose direct Standard-IA initially. It adds retrieval/transition charges,
  a 30-day minimum duration, and 128 KiB minimum billable size while access is
  still unknown.
- Objects smaller than 128 KiB remain in Frequent Access and are not monitored or
  automatically tiered. The dominant binary artifacts are much larger.

Implementation options, in preferred order:

1. Manage lifecycle configuration from the owning Console CloudFormation stack if
   the pre-existing buckets can be safely imported/adopted without replacement.
2. Otherwise add an idempotent, reviewed operations script that applies lifecycle
   configuration by bucket name and always saves the previous configuration to a
   private local file before update.

Do not add these pre-existing buckets as ordinary new CloudFormation resources:
that can fail adoption or introduce unintended deletion/replacement semantics.

### Intelligent-Tiering checklist

- [x] Export the current lifecycle configuration for both buckets (none); absence is an
      expected valid state.
- [x] Record bucket versioning, Object Lock, replication (all absent), and existing rule-filter
      state before designing the merged policy.
- [x] Prepare lifecycle JSON that transitions (`scripts/s3-intelligent-tiering.sh`) all binary objects to
      `INTELLIGENT_TIERING` and contains no expiration action.
- [x] Confirm whether temporary `uploads/` objects (console `expire` sweeps them; no lifecycle expiration added) are already cleaned by the
      application sweep; do not create a conflicting lifecycle expiration.
- [x] Re-read the live lifecycle immediately before apply (the script refuses foreign rules). Because PUT replaces
      the entire configuration, merge existing rules and abort if live state
      differs from the reviewed baseline.
- [x] Review the exact lifecycle diff and estimate (≈950 objects → monitoring ≈$0.003/month, one-time transition ≈$0.01) transition-request plus
      monitoring fees for the measured object count; obtain approval.
- [ ] Apply dev first (done 2026-08-26), then prod (`scripts/s3-intelligent-tiering.sh yyt-binary-dist --apply`).
- [ ] Verify lifecycle attachment without expecting immediate tier movement.
- [ ] Observe for at least 30 days, then record the actual Frequent/Infrequent
      bytes using S3 Storage Lens or daily CloudWatch storage metrics plus Cost
      Explorer usage types. Ordinary object listing shows only
      `INTELLIGENT_TIERING`, not the internal access tier.

### Phase 2: deployment-bucket version cleanup

For the shared versioned Serverless deployment bucket:

- Calculate the exact count/bytes that have been noncurrent for at least 30 days.
- Retain enough recent versions for rollback; do not assume all 1.42 GB qualifies.
  If lifecycle manages this, evaluate `NewerNoncurrentVersions`: S3 deletes a
  noncurrent version only after both the age and newer-version-count conditions
  are exceeded. Otherwise establish prefix/version-ID retention from actual
  Serverless rollback behavior.
- Proposed initial lifecycle: expire only noncurrent versions beyond the agreed
  age and retained count, remove compatible expired-object delete markers, and
  abort incomplete multipart uploads after seven days. A tag-filtered rule cannot
  use `ExpiredObjectDeleteMarker`; validate filter compatibility.
- Maximum present saving is only `$0.03–0.04/month`; operational cleanliness and
  bounded growth are stronger reasons than immediate cost.

Checklist:

- [ ] Produce a noncurrent-version age/size report.
- [ ] Produce an exact version-ID dry-run showing retained and deleted versions.
- [ ] Verify Serverless rollback/deploy does not reference versions beyond 30 days.
- [ ] Confirm the maximum legitimate multipart upload duration; use seven days
      unless measurements justify a shorter window.
- [ ] Back up the old lifecycle configuration, review the new policy, and obtain
      explicit approval.
- [ ] Apply and verify without deleting current objects.
- [ ] Verify rollback within the retained window and record that versions outside
      it are permanently unrecoverable.

## C. S3 deletion policy

### Dev binary artifacts

A possible 180-day expiration must not be enabled directly because the bucket is
unversioned. First generate a candidate manifest containing key, size,
last-modified time, application prefix, platform, and whether the object is
referenced by the catalog database/current release metadata.

- The measured >90-day cohort is 2.65 GB; the >180-day eligible amount is not yet
  known.
- Validate that dev URLs are not used as durable public releases.
- Quarantine into a separate versioned recovery bucket. Moving within the same
  unversioned bucket is copy+delete and breaks the original URL immediately; it
  is only a recovery mechanism, not continuity. Verify checksum, size, and
  metadata before source deletion and record source key → quarantine key/version.
- Require explicit approval of the final candidate manifest.

### Production binary artifacts

Do not apply a blanket age-only expiration. S3 Lifecycle cannot express “keep the
latest N releases per application and platform.” Implement an application-aware
cleanup command/job with all of these guards:

- Keep at least the latest three releases per application and platform.
- Never delete an artifact referenced by the current-release manifest, catalog
  row, installer metadata, or a published immutable URL still in use.
- Require a minimum age of 365 days even when the keep-count allows deletion.
- Produce a dry-run manifest and total bytes/savings before mutation.
- Make the manifest reviewable and require explicit approval.
- Copy candidates to a separate versioned quarantine bucket for a defined recovery
  period, verify checksum/metadata, rehearse restore, then delete the source.
- Log every deletion result and make retries idempotent.

Only 6.52 GB is currently older than 365 days, worth about `$0.15/month`. Even a
complete deletion of all binary data saves only about `$2.3/month`, so breaking a
published download is far more expensive than the storage saved.

### Deletion checklist

- [ ] Add a read-only candidate-report mode to the catalog cleanup tooling.
- [ ] Join S3 metadata to catalog/current-release references.
- [ ] Decide retention counts and quarantine duration with the artifact owners.
- [ ] Run against dev and manually verify every candidate class.
- [ ] Obtain explicit approval for the exact object manifest.
- [ ] Quarantine first; approve quarantine expiration separately and delete only
      after the recovery window.
- [ ] Re-run the report and verify no referenced/current artifacts are missing.

## Rollout and measurement order

1. Confirm/fix the prod alarm notification destination.
2. Implement and package the 15-alarm design; inspect dev/prod change sets.
3. Deploy alarm changes after explicit approval.
4. Apply non-destructive Intelligent-Tiering to dev, then prod after approval.
5. Measure alarm charges and S3 access tiers for one full month.
6. Apply shared deployment-version cleanup only after measuring eligible versions.
7. Build deletion candidate reports; do not delete artifacts in the same task.
8. Approve and execute quarantine/deletion as a separately reviewed task.

## Expected outcome

| Stage                             |     Monthly saving | Confidence                              |
| --------------------------------- | -----------------: | --------------------------------------- |
| 34 → 15 alarms                    |      about `$1.90` | High after billing catches up           |
| Intelligent-Tiering first 30 days |         about `$0` | High                                    |
| Intelligent-Tiering after 30 days |          `$0–1.00` | Access-dependent                        |
| Deployment noncurrent cleanup     | up to `$0.03–0.04` | Eligible bytes not yet measured         |
| Safe 365-day prod deletion cohort |      about `$0.15` | Candidate/reference validation required |

The non-destructive target is `$1.9–2.9/month` during days 30–89, reducing the
current account planning range from roughly `$22–24` to roughly `$19–22/month`.
Treat larger S3 savings as optional: they require application-aware deletion, not
a broad lifecycle expiration.
