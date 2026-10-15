# Site access

Basic Auth is an approved capability, not a default hosting option. Create a
site and choose **Request Basic Auth** in its Access section.
The shared request drawer preselects `site.basicAuth` with value `1`; enter the
reason and send it. Wait for a platform admin to approve the request. Pending and rejected requests confer
no permission. Pending requests show **Approval pending**; **Edit access** appears
only after approval. Approval is permanent until the site is deleted; the generic
limit set/revoke routes cannot change this capability.

A seated team member can then use **Edit access** to set one shared ID/password.
The password is write-only and accepts 4–128 Unicode characters, including
spaces, without letter/number/symbol requirements. Control characters and
malformed Unicode are refused. The ID is 1–64 printable non-space ASCII characters without a
colon. The web and app show a local advisory grade below the password input:
**Too easy** (red), **Medium** (yellow/amber), or **Strong** (green). The grade
uses length, character variety and simple common/repeated/sequential patterns;
it does not block saving, and no scoring service receives the password.
Only the independent host works for a protected site. Rebuild a
path-specific build with a relative base before enabling protection.

```sh
yyt limit request site.basicAuth 1 --site preview --reason "Private review"
yyt site auth set preview --username viewer --password-stdin < /path/to/private/password-file
yyt site auth sync preview
yyt site auth clear preview --confirm-public
```

Never put the password in command arguments, shell history, repository files or
URLs. The console app provides the same approval request and access controls.

Platform admins can suspend/resume access separately, with an audit reason:

```sh
yyt site suspend preview --reason "Unexpected traffic"
yyt site resume preview --reason "Incident resolved"
```

Suspension blocks both addresses and preserves the credentials and approval.
Member writes cannot bypass it. A busy deploy/move must finish before the site
can be suspended; use the existing distribution emergency stop for an incident
that cannot wait. Resume restores the preceding access mode; it never grants
approval or makes a protected site public.

## Propagation and recovery

`PUT /sites/{site}/auth` accepts `{mode:"public"}` or
`{mode:"basic", username, password}`. `PUT /admin/sites/{site}/suspension` accepts
`{suspended, reason}`. Both return 202 and a site view. The `access` field reports
`mode`, `username`, `suspended`, `available` and `sync` (`pending` or `submitted`).
It never contains a password, salt or verifier. Older metadata PATCH requests
preserve access settings.

Desired state is durable before publication. `pending` requires retry through
`POST /sites/{site}/access-sync` with `{}` (or the UI/CLI retry action).
After a successful change, the web console shows a dismissible notice that
propagation may take tens of seconds and the previous settings may still apply,
including an ID/password prompt after switching to Public. A pending result
shows retry instructions instead.

`submitted` means the policy was accepted, not that every edge has received it.
There is no global propagation-complete signal. The dev smoke observed changes
taking tens of seconds. Previously downloaded files and browser/service-worker
copies cannot be recalled. A new private site should configure protection
before uploading private content.

Every network request is checked before CDN cache access. Protected responses
have `Cache-Control: private, no-store` for browsers. Missing, malformed or
unavailable policy records deny access. Policy updates compare the authoritative
site configuration and active operation to prevent stale retries reopening a
site. Moves keep the target blocked while copying and submit an old-prefix
block before switching; failed publication is repaired with access-sync.

## Costs and rollout

Existing viewer-request functions read the policy; the independent host also
uses a viewer-response function to set browser cache headers. Conservative
incremental cost before free allowances is up to $0.16 per million independent
host requests, plus $0.03 per million shared-path policy reads. Assets and
unsuccessful authentication attempts count as requests. Existing CDN request
and transfer charges remain separate. See [AWS pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/).

Management attempts are conservatively reserved in pairs before any outbound
call. Failures and lost replies never refund a reservation. SDK retries are
disabled. The fixed deployment allocation is dev 100 and prod 900 attempts
per UTC month, with 10 and 90 reserved for admin suspension/repair. Normal
creation, moves, deletion and authentication updates cannot spend that reserve.
These are application limits; an operator calling AWS directly must account for
those calls separately. The existing CDN guard remains the traffic backstop,
not a guaranteed billing ceiling.

Per-stage rollout (prod requires an explicit release request):

1. Deploy console with enforcement absent/false. This creates the store and
   expands the schema without changing existing access.
2. `node scripts/site-access-bootstrap.mjs <stage> seed` registers managed sites
   and legacy prefixes and publishes the policies within the stage's budget.
3. `node scripts/site-access-bootstrap.mjs <stage> enable` creates a missing
   SecureString pepper without rotating an existing one and enables enforcement.
4. Redeploy console, then deploy the web console. Verify the real AWS function
   runtime and run `scripts/smoke/site-access.mjs` on dev with `YYT_DEBUG_KEY` in
   the environment. The script creates and removes only its test site.

The KVS SDK and its optional SigV4a signer are bundled together. CloudFront's
JavaScript runtime is not Node: await a KVS read in a separate statement before
parsing JSON; Node unit tests alone do not validate its syntax restrictions.

Never disable enforcement, detach the functions, reopen the S3 origin or roll
back to a pre-authentication template while protected/suspended sites exist.
Deployment and origin-revert scripts enforce this for the current workflow.
The pepper is stored at `console/site-access-pepper` under the stage SSM path;
losing it requires credential resets. Do not rotate it as a routine deploy.

## Release status

Production API, CDN enforcement and web console were released on 2026-10-15.
Existing shared-path sites, including registered 64-character legacy prefixes,
were verified unchanged. Production acceptance covered pending-approval denial,
authenticated access, shared-path blocking, Public restoration, suspension and
resume; the temporary site was deleted afterward.

The console app is available as 1.6.6+32 and the CLI as 0.17.1.
The unpublished 0.17.0 CLI build was cancelled after acceptance found a process
stdin initialization bug; 0.17.1 includes the fix and regression coverage.
