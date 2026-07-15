# CogBot

Cog is the CogWorks lab partner inside Discord. The entire student experience starts with
`/cog`; there is no help command and no command tree to memorize.

## Experience contract

- **One front door.** `/cog` opens the student's current state. The optional `view` picker is a
  shortcut, not required knowledge.
- **Private by default.** Team status, local reports, identity, and linking always use ephemeral
  messages. The only public path is the explicit **Share in channel** leaderboard action.
- **One message, not a trail.** Native buttons update the original ephemeral surface instead of
  posting a new response for each view.
- **One live bubble per shared run.** `cogbench run --live` opens one message in the mapped team
  channel; CogPortal edits it through prepare, check, evaluate, score, and the terminal state.
- **A closed linking loop.** An unlinked student gets a single-use CogPortal button and an
  **I've connected** button. After browser confirmation, that button refreshes the same Discord
  surface into their team bench.
- **Warm, not chatty.** Cog sounds like a calm lab partner. Copy is short, status language is human,
  and delight is reserved for empty states and successful endings.
- **Trust stays visible.** Local reports always say self-reported; official leaderboard data is
  labeled; account linking explains what Cog cannot access.

This follows Discord's current direction toward discoverable application commands and native
components: [application commands](https://docs.discord.com/developers/interactions/application-commands),
[Components V2](https://docs.discord.com/developers/components/reference), and
[interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding).

## Code shape

- `src/index.ts` verifies signed Discord requests, applies the 2.5-second response budget, and
  accepts commands plus component interactions.
- `src/commands.ts` is the state-aware product flow and copy layer.
- `src/interaction.ts` is a small, typed Components V2 presentation kit. It owns Discord constants,
  layout primitives, privacy flags, mention suppression, and response shapes.
- `src/verify.ts` owns Ed25519 verification.
- `scripts/register-commands.mjs` replaces the guild command set with the one `/cog` entry point.

The interaction Worker remains stateless and has no D1 binding. CogPortal is the sole owner of
identity, teams, channel mappings, live-run delivery state, runs, and leaderboard data. CogPortal
holds the bot token as a secret only because it creates and edits the live team messages.

## Application identity

Recommended Discord developer profile:

- **Name:** Cog
- **One-line description:** Your CogWorks lab bench, right inside Discord.
- **About:** Keep an eye on team runs, compare official results, and bring local field notes back to
  your teammates. Cog stays private unless you choose to share.
- **Avatar:** `assets/cog-avatar.png` — a warm field-notebook beaver mark designed for Discord's
  small circular crop.

Keep the app course-guild-only. It does not need Message Content intent, presence, automatic DMs,
or broad server permissions. Install the `applications.commands` and `bot` scopes with only
**View Channels** and **Send Messages** in the team channels. CogBot needs the application public
key; CogPortal separately needs the bot token as an encrypted Worker secret for live message
delivery. Never store that token in `wrangler.jsonc`.

## Local verification

```sh
pnpm --filter @cogworks/discord-bot check
pnpm --filter @cogworks/discord-bot test
pnpm --filter @cogworks/discord-bot build
```

Set `PORTAL_ORIGIN` to enable CogPortal buttons. Local `.dev.vars` values are documented in
`.dev.vars.example`.

## Live smoke test

After CogPortal and CogBot are deployed and `/cog` is registered:

1. Open `/cog` as an unlinked student. Confirm the message is private and has two actions.
2. Open the link, sign in with GitHub, read the consent surface, and connect Discord.
3. Return to the original Discord message and choose **I've connected**. Confirm it updates in place.
4. Open leaderboard, benchmarks, and local reports using buttons. Confirm personal views stay private.
5. Choose **Share in channel** from the leaderboard. Confirm only published leaderboard data appears.
6. Test a student without a team, a team with no runs, an active run, and a failed run.
7. As a team creator/maintainer, choose **Use this as our team channel** and confirm the visibility
   warning. Run `cogbench run --benchmark vision-recognition --live`; confirm exactly one message is
   created and edited through every stage. Repeat with a dirty worktree and a failure.
8. Try the command outside the configured course guild and confirm it fails closed.
