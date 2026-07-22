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
- **One live bubble per shared run.** `cogworks run --live` opens one message in the mapped team
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

- `src/index.ts` verifies signed Discord requests, immediately defers private commands/components,
  edits the original response through the interaction webhook, and accepts the explicit public
  leaderboard share synchronously.
- `src/commands.ts` is the state-aware product flow and copy layer.
- `src/interaction.ts` is the interaction protocol layer: request/response shapes, deferred-response
  plumbing, mention suppression, and privacy flags. Layout primitives, accent colors, the custom
  app-emoji vocabulary, and formatting rules live in the shared `@cogworks/discord-kit` package
  (`packages/discord-kit`), which the Cog*Portal worker also uses for the public live run message.
- `src/verify.ts` owns Ed25519 verification.
- `scripts/register-commands.mjs` replaces the guild command set with the one `/cog` entry point.

The interaction Worker remains stateless and has no D1 binding. CogPortal is the sole owner of
identity, teams, channel mappings, live-run delivery state, runs, and leaderboard data. CogPortal
holds the bot token as a secret only because it creates and edits the live team messages.

## Application identity

Course deployment identifiers (public, not credentials):

- **Discord application ID:** `1526706029356646460`
- **Course guild ID:** `1515858059027550321`

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

## Local interaction testing (tunnel)

Discord only talks to a public HTTPS endpoint, so testing unreleased interaction code means
tunneling your local worker instead of deploying:

1. Run both dev servers so the `PORTAL` service binding resolves through wrangler's local dev
   registry: `pnpm --filter @cogworks/portal dev` and `pnpm --filter @cogworks/discord-bot dev`.
2. Expose the bot's local port with any HTTPS tunnel, for example
   `cloudflared tunnel --url http://localhost:8787`.
3. In the Discord developer portal, temporarily set the application's **Interactions Endpoint
   URL** to the tunnel URL. Discord sends a signed PING to verify it.
4. Use `/cog` in the course guild; interactions now hit your local code.
5. When you're done, restore the endpoint to the deployed `cogbot` worker URL. Leaving it on a
   dead tunnel breaks every interaction in the guild.

## Live smoke test

After CogPortal and CogBot are deployed and `/cog` is registered:

1. Open `/cog` as an unlinked student. Confirm the message is private and has two actions.
2. Open the link, sign in with GitHub, read the consent surface, and connect Discord.
3. Return to the original Discord message and choose **I've connected**. Confirm it updates in place.
4. Open leaderboard, benchmarks, and local reports using buttons. Confirm personal views stay private.
5. Choose **Share in channel** from the leaderboard. Confirm only published leaderboard data appears.
6. Test a student without a team, a team with no runs, an active run, and a failed run.
7. As a team creator/maintainer, choose **Use this as our team channel** and confirm the visibility
   warning. Run `cogworks run --benchmark vision-recognition --live`; confirm exactly one message is
   created and edited through every stage. Repeat with a dirty worktree and a failure.
8. Try the command outside the configured course guild and confirm it fails closed.
