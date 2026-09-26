# Candidate 0d53687 acceptance

Historical Audio floor presentation passes in signed-in Helium. Both previously reported page defects remain. Fresh hosted producer-to-page acceptance was blocked before Run because the demo team has a configured Discord channel.

Local source is exactly `0d536870be2bdbe2ab8d6965a6a8df8896ba28d2`, detached. Port 5187 uses the preserved disposable D1 with migration 0037 applied. The deployed result was inspected in the existing Sam Helium session during the manager's candidate hold, with a final viewport capture afterward. No product edits or delegates.

## Findings

- **P1, withheld results remain hidden.** `run_verify_withheld` is still a succeeded injected record with no primary, a withheld-overall diagnostic and supporting text/retrieval evidence. Helium shows pipeline, Promote and log only. `apps/portal/src/routes/RunDetailPage.tsx:249` still gates the entire result block on `primary`. [Rendered page](withheld-primary.png), [DOM](withheld-primary.txt). This is fixture evidence, not a real Language score.
- **P2, Back restores the previous account display.** Exact sequence: verify-staff sign-in, join page, full navigation to `/admin`, explicit sign-out, verify-empty sign-in in the same document, EMPTY26 join, `/connect`, Back. Helium restored `/join` displaying verify-staff. Reload showed verify-empty at `/connect`. [Before](history-exact-before.txt), [restored document](history-exact-back.png), [after reload](history-reloaded.txt). An initial attempt with an extra full-page sign-in navigation did not reproduce; the original sequence did. No old-account server access was demonstrated. Relevant unchanged cache settings are `src/lib/queries.ts:25` and `src/App.tsx:27`; this pass does not prove the browser's internal cache mechanism.

## Accepted observations

- **Actual deployed RUN 5E29:** `run_bb29405e29`, practice succeeded, repository SHA `71258046e60fecd3295c0b52236fc6e476b0e9cf`, duration **3m 06s**. Primary **0.5375** displays Chance **0.0333** and Trivial baseline **0.2417** beneath it, at matching precision with no floor arrows. Both explanations are visibly present. Margin separation **0.774** and median identify time **0.057** read **not scored**. [Viewport](hosted-floors.png), [complete rendered text](hosted-5e29.txt). This accepts historical Audio presentation only. It neither proves a fresh producer run nor assigns roles to historical Week 3 rows.
- **Main/setup restored:** preserved creator team, repository, seven selected-track runs, quota and setup command list load at the candidate. [Dashboard](local-dashboard.txt), [setup](setup.txt).
- **Scoped progress rendering:** four injected records for verify-creator, one unscoped clone and three Clustering-scoped environment/project/wiring records, produce **Clustering 4/5** and **Recognition 1/5**. Track switching changes the benchmark command and only the shared clone stays verified. No active device connection was injected. [Clustering](scoped-clustering.txt), [Recognition](scoped-recognition.txt). Audio is not offered in this disposable cohort, so the scope check used its existing Clustering track. These records were removed afterward. This does not establish CLI-to-page delivery.
- **Failed-read display:** the development gallery shows verified checkmarks on the successful-read side and unknown-progress dashes on the failed-read side, with undimmed commands. The supporting orphan floor also remains visible without a direction arrow. [Viewport](failed-read-gallery.png), [DOM](gallery.txt). This accepts component rendering; no real failed API response was injected.

## Hosted gate and remaining acceptance

The signed-in dashboard identified SamGu-NRX, team CogPortal, repository `SamGu-NRX/cogportal-demo-week1`, six of ten practice attempts remaining, and no active run. Before pressing Run, a read-only query against development D1 confirmed team `team_368410ea89c62b51` has Discord channel `1515858059405295762`. Run was not pressed. Notifications were not changed. The manager subsequently released the deployment hold and is obtaining explicit authorization separately.

No fresh run ID, producer metrics or duration exist for this phase. A final read-only development query returned **zero nonterminal runs**. No hosted run remains active at this handoff. No promotion, publication, production change or course message occurred.

The optional displayed install and Audio check-to-page repetition was not performed. The displayed SDK pin remains `99281c5260e61e1f599a299983071a5f15fe5f1e`; this is not final SDK acceptance. No course environment, dependency requirements or student repository was modified.

## Preserved state

Stopped only the old verifier Vite PID 28922. Backed up local D1 privately before switching the detached checkout. Migration 0037 succeeded. All 16 local run rows, 115 metric rows excluding role metadata, and the original setup record match the pre-candidate backup after fixture cleanup. Original verify-empty cohort fields were restored. [Preservation check](preservation.json).

The only retained service is verifier Vite **PID 40082**, exec session **64511**, port **5187**, [log](server.log). Browser tab 1693191317 ends at local `/signin`, signed out; the deployed Sam session was not signed out. No local runs are active. Evidence and the private backup remain in this untracked directory; tracked source is unchanged.
