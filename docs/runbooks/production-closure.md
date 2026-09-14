# Production closure worksheet

For Sam and the release operator. Review artifact only: none of the provider commands below has been executed. Do not run this as one script. Each numbered gate needs its recorded result before the next. Sam owns release authorization and PR merges.

## 1. Preserve the candidate and close its effective config

Wait for the accepted native and paired Terminal SDK/benchmark candidate. Do not build Modal images against the interim SDK pin. Keep the accepted checkout unchanged through later image build, four probes and publication. Shared runner or image-name changes require a separately established development drain; production's empty-object evidence does not drain development's 11 stored objects.

From the accepted checkout root, in Bash with `jq`, Git and the installed Wrangler 4.110.0:

```bash
set -euo pipefail
set -o noclobber
umask 077
WINDOW=$(mktemp -d "${TMPDIR:-/tmp}/cogportal-window.XXXXXX")
SOURCE_CONFIG="$PWD/apps/portal/wrangler.jsonc"
cp -p "$SOURCE_CONFIG" "$WINDOW/wrangler.original.jsonc"
git rev-parse HEAD > "$WINDOW/source-head.txt"
git submodule status > "$WINDOW/benchmark-pins.txt"
git apply --check docs/runbooks/production-closure.patch
git apply docs/runbooks/production-closure.patch
git diff -- apps/portal/wrangler.jsonc > "$WINDOW/closure.diff"
```

The patch changes only `env.production.workers_dev=false`, `preview_urls=false` and `triggers.crons=[]`. It leaves both custom-domain routes in place, so a separate provider block is essential. Do not change execution provider, bindings, secrets, migration names, or the development configuration. If the patch no longer applies, stop and review the new config rather than forcing it.

Both build and deployment must consume the patched config. Do not run the ordinary production deployment command before closure and drain. A later build can leave a redirected deployment config; checking the source file alone is insufficient.

## 2. Capture before state, then close ingress

Use only Sam-authorized credentials. Do not use `set -x`, print tokens, or borrow another session's failed credential route.

```bash
: "${CLOUDFLARE_API_TOKEN:?supply an authorized token without logging it}"
ACCOUNT=eb0505bac408b0230cff849b0c0ff6b4
ZONE=73ff5d651f37365cda00117fc68b79a0
WORKER="accounts/$ACCOUNT/workers/scripts/cogportal-production"
DO="accounts/$ACCOUNT/workers/durable_objects/namespaces/dd23153db188448596ae40cf1e3917cf"
cf() {
  curl --silent --show-error --fail \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4/$1" "${@:2}" |
    jq -e 'if .success then . else error("Cloudflare refused the request") end'
}
cf "$WORKER/subdomain" > "$WINDOW/before-subdomain.json"
cf "$WORKER/schedules" > "$WINDOW/before-schedules.json"
cf "$WORKER/deployments" > "$WINDOW/before-deployments.json"
cf "zones/$ZONE/rulesets/phases/http_request_firewall_custom/entrypoint" \
  > "$WINDOW/before-firewall.json"
jq '.result | {enabled,previews_enabled}' "$WINDOW/before-subdomain.json" > "$WINDOW/restore-subdomain.json"
jq '[.result.schedules[] | {cron}]' "$WINDOW/before-schedules.json" > "$WINDOW/restore-schedules.json"
```

A missing custom-rules entrypoint is a stop, not an empty successful read. Sam can create the temporary rule through the dashboard, or approve creation of that entrypoint separately. Never PUT a replacement ruleset over existing rules.

Add exactly one first-position rule. Preserve its returned ID and all existing rules. This expression has no operator bypass:

```bash
RULESET=$(jq -er '.result.id' "$WINDOW/before-firewall.json")
cf "zones/$ZONE/rulesets/$RULESET/rules" -X POST --data \
  '{"action":"block","expression":"http.host in {\"cogportal.sillion.app\" \"cogactivity.sillion.app\"}","description":"CogPortal authorized release closure","enabled":true,"position":{"index":1}}' \
  > "$WINDOW/created-firewall.json"
RULE=$(jq -er '.result.rules[0] | select(.action=="block" and .enabled==true and .expression=="http.host in {\"cogportal.sillion.app\" \"cogactivity.sillion.app\"}") | .id' "$WINDOW/created-firewall.json")
printf '%s\n' "$RULE" > "$WINDOW/closure-rule-id.txt"
# Save non-secret shell state before continuing; do not repeat the rule POST.
declare -p WINDOW SOURCE_CONFIG ACCOUNT ZONE WORKER DO RULESET RULE > "$WINDOW/resume.sh"
declare -f cf >> "$WINDOW/resume.sh"
cf "$WORKER/subdomain" -X POST --data '{"enabled":false,"previews_enabled":false}' > "$WINDOW/close-subdomain-result.json"
cf "$WORKER/schedules" -X PUT --data '[]' > "$WINDOW/close-schedules-result.json"
date -u +%FT%TZ > "$WINDOW/closure-requested-at.txt"
```

If a command fails, leave completed closures in place and stop. If rule-ID extraction fails, inspect `created-firewall.json`; do not repeat the POST and create another block rule. Never overwrite the saved before state. For a new Bash shell, return to the same checkout, restore only the private state file and supply authorized credentials separately:

```bash
set -euo pipefail
set -o noclobber
source /absolute/path/to/the-recorded-window/resume.sh
: "${CLOUDFLARE_API_TOKEN:?supply an authorized token without logging it}"
```

`resume.sh` contains only paths, resource IDs and the function definition, not a token. It performs no API call. If the file was not created before failure, recover the rule ID from the saved response under operator review, never by rerunning the creation block.

## 3. Read back, drain, then take the final backup

Run these independent GETs after closure. On later reads change the first assignment to a fresh label, such as `STAGE=after-deploy` or `STAGE=after-rollback`. `noclobber` refuses to overwrite earlier evidence. API mutation responses alone are not readback.

```bash
STAGE=closed
cf "$WORKER/subdomain" > "$WINDOW/$STAGE-subdomain.json"
cf "$WORKER/schedules" > "$WINDOW/$STAGE-schedules.json"
cf "zones/$ZONE/rulesets/$RULESET" > "$WINDOW/$STAGE-firewall.json"
jq -e '.result.enabled==false and .result.previews_enabled==false' "$WINDOW/$STAGE-subdomain.json"
jq -e '.result.schedules==[]' "$WINDOW/$STAGE-schedules.json"
jq -e --arg id "$RULE" '.result.rules[0] | .id==$id and .enabled==true and .action=="block" and .expression=="http.host in {\"cogportal.sillion.app\" \"cogactivity.sillion.app\"}"' "$WINDOW/$STAGE-firewall.json"
```

Verify the current account workers.dev hostname and the current version's preview URL from the provider, rather than guessing them. Record denied HTTP probes for both custom domains, workers.dev and the version preview URL, with URL, UTC time, status and headers. Use unauthenticated GET `/` only, never login or a run-page read. A redirect, SPA success, or application response is not denial. Confirm no earlier account rule exempts these requests; if the WAF rule does not block them, stop.

Allow the documented 15-minute cron propagation period, then account for completion of requests and scheduled invocations already admitted. Record the actual drain evidence. Quiet D1 timestamps or absence of error logs is not proof: an alarm can park on Discord backoff or retry before a D1 write. Recheck the previously reviewed caller/route/queue/workflow inventory at the window; a new writer invalidates this procedure.

After effective closure and invocation drain, enumerate the production namespace with every returned cursor. Do not substitute the development namespace:

```bash
cursor=''; page=0
while :; do
  page=$((page+1))
  args=(--get --data-urlencode 'limit=1000')
  [ -z "$cursor" ] || args+=(--data-urlencode "cursor=$cursor")
  cf "$DO/objects" "${args[@]}" > "$WINDOW/$STAGE-production-objects-$page.json"
  jq -e '.result==[] and .result_info.count==0' "$WINDOW/$STAGE-production-objects-$page.json"
  cursor=$(jq -er '.result_info.cursor // ""' "$WINDOW/$STAGE-production-objects-$page.json")
  [ -n "$cursor" ] || break
done
pnpm --filter @cogworks/portal exec wrangler d1 execute cogportal-db-prod --config "$SOURCE_CONFIG" --remote --env production --command \
  'SELECT provider,status,COUNT(*) AS n FROM runs GROUP BY provider,status; SELECT COUNT(*) AS n FROM run_surfaces; SELECT COUNT(*) AS n FROM run_stream_events;' --json \
  > "$WINDOW/$STAGE-d1.json"
```

Require only terminal runs, zero surfaces/events and an exhaustive empty namespace. Any object is a hard stop for this procedure, even if its `hasStoredData` is false. The exact July Worker cannot arm a hub alarm without first storing its surface identity. This empty-production argument does not establish development alarm drain. If drain or inventory is uncertain, do not back up for cutover or migrate.

Only now take the final export, then its bookmark while closure remains effective:

```bash
pnpm --filter @cogworks/portal exec wrangler d1 export cogportal-db-prod --config "$SOURCE_CONFIG" --remote --env production --output "$WINDOW/final.sql"
pnpm --filter @cogworks/portal exec wrangler d1 time-travel info cogportal-db-prod --config "$SOURCE_CONFIG" --env production --json > "$WINDOW/final-bookmark.json"
```

Record the actual bookmark and original Worker version from the saved deployment response. Check export completion before proceeding. Use the separately accepted exact migration sequence and ledger checks, never an inferred filename order. This worksheet does not authorize migrations.

## 4. Build and deploy without reopening

After source, migrations, resources and immutable image receipts are accepted, build the Portal with the closure patch still applied:

```bash
CLOUDFLARE_ENV=production VITE_PORTAL_ORIGIN=https://cogportal.sillion.app \
  VITE_ACTIVITY_HOSTNAME=cogactivity.sillion.app pnpm --filter @cogworks/portal build
```

Read `apps/portal/.wrangler/deploy/config.json`. Resolve its `configPath` relative to that file's directory and record the resulting absolute path as `BUILT_CONFIG`. Do not reuse an older `dist` file or guess a worker output directory. Inspect the generated config before invoking Wrangler:

```bash
BUILT_CONFIG=$(node -e 'const fs=require("node:fs"),p=require("node:path"); const f=p.resolve("apps/portal/.wrangler/deploy/config.json"); process.stdout.write(p.resolve(p.dirname(f),JSON.parse(fs.readFileSync(f,"utf8")).configPath));')
jq -e '.name=="cogportal-production" and .workers_dev==false and .preview_urls==false and .triggers.crons==[]' "$BUILT_CONFIG"
cp -p "$BUILT_CONFIG" "$WINDOW/effective-closed-wrangler.json"
env -u CLOUDFLARE_ENV pnpm --filter @cogworks/portal exec wrangler deploy --config "$BUILT_CONFIG" --dry-run --outdir "$WINDOW/dry-run"
```

Review the generated bindings against the patched source: production D1 ID, R2 bucket, RUN_SURFACES class, variables, routes, asset settings and unchanged migration declarations must agree. Vite rewrites code, assets and migration directory paths relative to the output directory; those path rewrites are not binding changes. The generated config already selects production; do not add `--env` to this flattened config.

Only at the separately authorized deployment gate, deploy that same file without another build:

```bash
env -u CLOUDFLARE_ENV pnpm --filter @cogworks/portal exec wrangler deploy --config "$BUILT_CONFIG"
```

Repeat section 3's provider GETs and denied HTTP probes immediately. Check deployed binding identities separately through Worker settings, without printing secret values. Do not grant an operator exception yet. Local flags and a successful upload do not prove ingress remained closed.

## 5. Rollback or reopen only at an explicit gate

Keep the WAF block, workers.dev/previews disabled and cron empty during a rollback. With the recorded values, installed Wrangler accepts these forms; neither is an automatic recovery command:

```bash
: "${ORIGINAL_WORKER_VERSION:?recorded original version, not deployment ID}"
: "${FINAL_BOOKMARK:?recorded post-drain bookmark}"
pnpm --filter @cogworks/portal exec wrangler rollback "$ORIGINAL_WORKER_VERSION" --config "$SOURCE_CONFIG" --env production --name cogportal-production
pnpm --filter @cogworks/portal exec wrangler d1 time-travel restore cogportal-db-prod --config "$SOURCE_CONFIG" --env production --bookmark "$FINAL_BOOKMARK"
```

The root decision must account for any new DO migration before Worker rollback. Do not force a rollback Wrangler refuses. D1 restore excludes DO storage, R2, Discord and Modal image names. From the first admitted login, run-page read or smoke write, rollback may discard new data and cannot be called lossless. Reclose and drain again before any restore. Re-run closed-state readback after rollback, before considering reopening.

When root authorizes reopening, restore only the controls this worksheet changed. Retain unrelated WAF rules. Compare saved rules excluding the added rule before deleting it; unexpected concurrent changes require review. Reenabling cron also enables the candidate's team nudges and needs explicit authorization.

```bash
cf "$WORKER/subdomain" -X POST --data-binary "@$WINDOW/restore-subdomain.json" > "$WINDOW/reopen-subdomain-result.json"
cf "$WORKER/schedules" -X PUT --data-binary "@$WINDOW/restore-schedules.json" > "$WINDOW/reopen-schedules-result.json"
cf "zones/$ZONE/rulesets/$RULESET/rules/$RULE" -X DELETE > "$WINDOW/reopen-firewall-result.json"
git apply --reverse --check docs/runbooks/production-closure.patch
git apply --reverse docs/runbooks/production-closure.patch
cmp apps/portal/wrangler.jsonc "$WINDOW/wrangler.original.jsonc"
```

Read back subdomain flags and cron against the saved before state, verify only the temporary firewall rule disappeared, and repeat route probes. Local patch reversal does not reopen the provider. The generated build is still closed; any later normal deployment needs a fresh reviewed build, not reuse of that closed output. Preserve the entire window evidence directory.

Syntax checked against installed Wrangler4.110.0 and Cloudflare Vite plugin1.44.0 source. Provider API references: [add a rule](https://developers.cloudflare.com/ruleset-engine/rulesets-api/add-rule/), [delete one rule](https://developers.cloudflare.com/ruleset-engine/rulesets-api/delete-rule/), [subdomain controls](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/), [cron propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/). The focused patch test proves local normalization and reversal, not live closure or successful deployment.
