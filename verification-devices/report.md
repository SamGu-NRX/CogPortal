# Device round-trip at 49f6a98

Actual CLI → Helium approval → CLI completion → status → Connections succeeded twice against **http://127.0.0.1:5187**, using frozen source **49f6a98f75eee39fcf38c800d879ca1382558e04**. The original code survived a fresh account joining a team. Expiring a second approval produced a clear error; a fresh link succeeded. Both disposable devices were then revoked.

## Invocation and isolation

Interpreter `/Users/samgu/BWSI/2026/CogPortal/.venv-test/bin/python`, Python **3.11.15**. `PYTHONPATH=/Users/samgu/.codex/worktrees/dd61/CogPortal/python/cogbench/src` supplied the exact source; import-path output verified `cogbench` and `cogbench.cli` came from that worktree. `PYTHONDONTWRITEBYTECODE=1` prevented source bytecode writes. No installed environment was changed, and no benchmark code or scoring ran.

Commands were `python -m cogbench link --portal http://127.0.0.1:5187 --no-browser` and `python -m cogbench status`. `COGBENCH_CONFIG` pointed only to `verification-devices/private/device.json` or `private/recovery.json`. That directory is mode 0700, the saved files mode 0600, and `private/` is locally gitignored. Tokens are not included in logs or this report. The command directory was a new empty Git fixture at `verification-devices/project`, with origin `https://github.com/cogworks-demo/face-finder.git`; no clone or network repository access occurred.

Helium CUA extension browser 2, tab 1693191317, remained on the isolated loopback host. The account `verify-device-new` was created through Local sign-in. It initially had no cohort/team and no GitHub identity. It joined VISION26 and Verification Creator Team through the UI. No synthetic GitHub identity was needed for device approval. Status's “GitHub @verify-device-new” line is a DEV_AUTH display label, not a verified GitHub account.

## Stable-ID evidence

| IDs | Observed result |
| --- | --- |
| LINK-01/02 | Terminal printed the privacy sentence, explicit approval URL and matching user code. `--no-browser` left opening to the tester. [Initial/final transcript](link-roundtrip.txt). This was captured stdout, not a TTY timing test. |
| LINK-03 | Original approval URL sent signed-out browser to sign-in, then the fresh account to `/join`. A status message said a team was needed and to run link again. After cohort/team join, browser reached Setup, not pending approval. Manually reopening the **original** URL showed the approval form; approval completed the same waiting CLI process successfully. The code was not burned. [No-team notice](no-team-recovery.jpg), [joined Setup](joined-setup.jpg), [original approval](approval-original.jpg). |
| LINK-05/09; STATUS-01/07 | Named device `dd61 device roundtrip` appeared in Connections. CLI status exited 0 with the seven labelled lines, team/repository, no channel chosen, device name, expiry and loopback origin. Saved config permissions were 0600. [Status](status-linked.txt), [Connections](connections-linked.jpg). No piped-versus-TTY comparison or exact label-padding assertion was run. |
| SETUP-06, partial SETUP-01 | Successful link printed `setup: updated clone`; approval returned to Setup showing 2 of 5 verified. This covers clone/device evidence only, not a benchmark check or scoped environment evidence. [Setup](setup-after-link.jpg). |
| LINK-08 | Second authorization's expires_at was changed to the past in **local D1 only**. Browser approval showed “The device code is invalid, expired, or already used.” CLI exited 2 with “The device authorization expired. Start again.” [Injected timestamp](expiry-fixture.json), [terminal](link-expired.txt), [browser](expired-approval.jpg). This tests server expiry handling, not waiting out the CLI's original ten-minute deadline. |
| LINK-05, recovery | Fresh `link --no-browser` produced a new code. Approving `dd61 recovered device` returned to Setup and completed exit 0 with clone update. Status exited 0; both devices appeared in Connections. [Terminal](link-recovery.txt), [status](status-recovered.txt), [Connections](connections-recovered.jpg). |
| STATUS-05/11, revocation variant | Revoked only the recovered device through Connections, then ran status using its private config. It exited 2, with “This CogBench connection expired or was revoked.” Config content hash was unchanged and mode remained 0600. [Output](status-revoked.txt), [metadata](status-revoked-metadata.json). This is server revocation, not a locally expired saved token. |
| Connections revoke | Revoked the remaining disposable round-trip device through UI. Empty list now tells the user to run `cogworks link`. [Final list](connections-revoked.jpg), [local device IDs/revocation times](final-state.json). |

## Recovery gaps for Opus

- **No-team return is manual, not automatic.** `App.tsx:66–69` records a dropped link; `lib/pending-return.ts:30–36` deletes its saved return and keeps only the link kind. `DroppedLinkNotice.tsx:23–24` sends the user to run link again. The observed original code remained valid and completed after manual return, so comments saying it “dies” overstate what happens. Preserve the distinction between losing the browser return and consuming the authorization. LINK-03's silent-code-death premise is not the current outcome.
- **Revoked status lacks a next command.** The server message at `worker/auth/device.ts:35` uses the old CogBench name and says only expired/revoked. `cli.py:1040` forwards that error, unlike the missing-token branch at 1038, which explicitly names `cogworks link`. Add a useful next step to this recovery message; current CLI output does not meet that part of the requested check. The Connections empty state does supply the command.

No transient-5xx, outside-worktree, failed-clone update, interrupted polling or early-navigation timer case was run. LINK-04/06/07/10 remain open. No token was read from any real account or manager configuration.

## Handoff

All three link processes joined: session **60933 exit 0**, **40064 exit 2**, **35752 exit 0**. Status commands joined with the exits above. Both local device tokens are revoked; their private files remain solely for evidence, excluded from Git. No active authorization poll remains. Eight JPEG captures and terminal artifacts are retained here. Browser is signed out.

Frozen Git tree has no tracked edits. The only retained service is the existing **Vite PID 28922, exec session 92345, port 5187**, [log](../verification-roles/server.log). Original checkout, installed interpreter environment, Opus runtime and real credentials were untouched. No delegates or independently verified model telemetry. Displayed-install, scoped-check and repaired-page acceptance remain for Opus's final candidate.
