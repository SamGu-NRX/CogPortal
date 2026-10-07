# Verification: Discord

How to run this file: everything here needs the course guild with the bot deployed against the same portal the browser items use. There is no way to exercise `/cog` outside a guild, so an item with no guild is blocked rather than skipped. You also need a text channel the team can bind, a second guild member on the same team, and a Discord client that supports embedded applications for the activity items. Bind and unbind the channel between sections where an item says so; the binding is unique per channel, so two teams cannot share one.

Read every reply before dismissing it. Almost every `/cog` reply is ephemeral, so it is gone once the client is reloaded and cannot be recovered.

## discord/commands.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| COG-01 | P1 | discord | Every reply is private except the shared leaderboard ([Summary](../discord/commands.md)). | Any member. | 1. Run `/cog` and each of its five views.<br>2. Ask a teammate whether they can see any of them. | Only the deliberate share posts to the channel. Everything else is visible to the invoker alone. | not run |
| COG-02 | P1 | discord | An unlinked student is offered a link that states its lifetime ([the connect card](../discord/commands.md)). | An account not linked to the portal. | 1. Run `/cog`. | The connect card, one link button, and a sentence saying the link works once and expires in ten minutes. | not run |
| COG-03 | P1 | discord | An already-linked student choosing "Connect account" gets a card with no link (suspected dead end) ([Edge cases](../discord/commands.md)). | A linked account with no team. | 1. Run `/cog view:connect`. | Record every button on the card. The document expects only "Refresh", with the text still telling them to go to the portal. | not run |
| COG-04 | P1 | discord | Sharing the leaderboard is the only thing that posts to a channel ([the leaderboard view](../discord/commands.md)). | Any member. | 1. Run `/cog view:leaderboard` and press "Share in channel". | One channel message, no buttons on it, footed as official published results. | not run |
| COG-05 | P1 | discord | The home view names the next action rather than listing all of them ([the home view](../discord/commands.md)). | A team with a finished run. | 1. Run `/cog`. | Exactly one action button plus the portal link, chosen by the documented priority. | not run |
| COG-06 | P1 | discord | A hosted verification says what it costs ([the confirmations](../discord/commands.md)). | A team with practice runs remaining. | 1. Choose "Verify hosted" and read the confirmation. | Record the exact text. The document expects "It's practice and spends nothing.", which is a suspected bug because the practice quota counts it. | not run |
| COG-07 | P1 | discord | Spending an official attempt is confirmed with its number ([the confirmations](../discord/commands.md)). | A promotable run. | 1. Choose "Promote to official". | The confirm button names which attempt of three. Compare that number with the dashboard. | not run |
| COG-08 | P1 | discord | A portal error reads as an unreachable portal (suspected bug) ([Cancel and interrupt](../discord/commands.md)). | A team whose channel the bot cannot post in, or an exhausted official quota. | 1. Trigger the condition and read the reply. | Record it. The document expects the generic sentence rather than the portal's own message. | not run |
| COG-09 | P2 | discord | Choosing a benchmark shows the exact command to run ([the benchmarks view](../discord/commands.md)). | Any member. | 1. Run `/cog view:benchmarks` and pick one. | A fenced `cogworks run --benchmark {id} --live` and a line explaining what `--live` shares. | not run |
| COG-10 | P2 | discord | Binding a channel states who will see what ([the bind prompt](../discord/commands.md)). | A maintainer, in an unbound channel. | 1. Run `/cog` and press the bind button. | A prompt naming author, commit, progress, and self-reported score as visible to everyone who can read the channel, and saying source and raw outputs stay on the device. | not run |
| COG-11 | P2 | discord | Running `/cog` outside a channel says where to run it ([Answered without work](../discord/commands.md)). | A DM or a context with no channel. | 1. Try to bind. | "Open /cog inside the channel your team will use." | not run |
| COG-12 | P2 | discord | Local notes are marked never leaderboard-eligible ([the local view](../discord/commands.md)). | A team with synced reports. | 1. Run `/cog view:local`. | Up to eight rows, footed "self-reported, never leaderboard-eligible". | not run |
| COG-13 | P3 | discord | Custom emoji degrade to glyphs rather than breaking ([Modifiers](../discord/commands.md)). | A guild where the app emoji are unavailable. | 1. Run `/cog`. | Font glyphs in place of the custom emoji, with the layout intact. | not run |
| COG-14 | P3 | discord | Metadata is separated by wide spaces, not middots ([the home view](../discord/commands.md)). | Any member, on mobile and desktop. | 1. Read the meta line on both. | The parts stay separated on mobile; no `·` between them. | not run |

Not checkable by hand:

- The read-role divergence. No write path can store a role outside the three the actor check allows, so the state cannot be produced without editing the database.
- The dead `open_portal` branch and the `open_console` fallback string, neither of which is reachable through the interface.

## discord/the-activity.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ACT-01 | P1 | discord | Launching the activity posts nothing to the channel ([Asking](../discord/the-activity.md)). | Any member in a voice channel. | 1. Launch it from the entry point and from a run bubble's watch control. | The activity opens both ways and no channel message appears. | not run |
| ACT-02 | P1 | discord | A student who has never authorized the app gets a dead card (suspected bug) ([Cancel and interrupt](../discord/the-activity.md)). | An account that has never authorized this application. | 1. Launch the activity. | Record what appears. The document expects the generic error card with no prompt to authorize and nothing to press. | not run |
| ACT-03 | P1 | discord | A linked student with no team gets its own card, not the not-linked one ([Answered without work](../discord/the-activity.md)). | Linked, no team. | 1. Launch the activity. | "You are linked, but not on a team yet." with a control that opens `/connect`, not the linking card. | not run |
| ACT-04 | P1 | discord | The activity does not notice a link completing ([Cancel and interrupt](../discord/the-activity.md)). | Not linked. | 1. Launch the activity, follow the link, complete linking in the browser, and return without closing the activity. | The activity still shows the not-linked card and instructs the student to close and reopen it. | not run |
| ACT-05 | P1 | discord | The activity shows the portal's own error text ([How it ends](../discord/the-activity.md)). | An exhausted official quota. | 1. Try to promote from the activity. | The portal's sentence, verbatim. Compare with what the bot says for the same condition in COG-08; the two are expected to differ. | not run |
| ACT-06 | P2 | discord | Another team's surface is not reachable ([Asking](../discord/the-activity.md)). | A surface id from another team. | 1. Request it through the activity. | Not found, with no hint the surface exists. | not run |
| ACT-07 | P2 | discord | Opened outside Discord, it says where it belongs ([Answered without work](../discord/the-activity.md)). | A browser, not Discord. | 1. Open the activity URL. | The "Open the live bench from Discord." card, naming `/cog` and the console control. | not run |
| ACT-08 | P2 | discord | The console reconnects and says so ([While it works](../discord/the-activity.md)). | A run in progress. | 1. Drop the network for ten seconds and restore it. | The status chip passes through "Reconnecting…" and returns to "Live". | not run |
| ACT-09 | P3 | discord | The session outlives the link it was created from ([Modifiers](../discord/the-activity.md)). | A fresh activity session. | 1. Note the time, then keep the activity open past ten minutes without reloading. | It keeps working, which is the documented one-hour session rather than the ten minutes the connect card advertises. | not run |

## discord/channel-messages.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CHAN-01 | P1 | discord, device | One bubble per shared run, edited rather than repeated ([the run bubble](../discord/channel-messages.md)). | A bound channel and a linked device. | 1. Run `cogworks run --benchmark <id> --live` and watch the channel for the whole run. | Exactly one message appears and changes in place. No second message, no repeats. | not run |
| CHAN-02 | P1 | discord, device | Nothing is posted when no channel is bound ([Answered without work](../discord/channel-messages.md)). | No bound channel. | 1. Run a `--live` run. | No message anywhere, and the terminal says the run synced but Discord delivery has no channel. | not run |
| CHAN-03 | P1 | discord, device | A killed run leaves the bubble live forever (suspected bug) ([Cancel and interrupt](../discord/channel-messages.md)). | A `--live` run in progress. | 1. `kill -9` the CLI.<br>2. Watch the channel for an hour. | Record whether the bubble ever settles. The document expects it to stay on the running loader indefinitely. | not run |
| CHAN-04 | P1 | discord, device | A refusal reaches the channel truncated ([the run bubble](../discord/channel-messages.md)). | A run that produces a long refusal headline. | 1. Read the terminal bubble's final state. | Record the text and its length. The document expects it cut at 300 characters. | not run |
| CHAN-05 | P1 | discord | A nudge names no person and counts nothing per person ([team nudges](../discord/channel-messages.md)). | A team past the first-light threshold. | 1. Wait for the nudge and read it. | No name, no per-person number, no ranking. | not run |
| CHAN-06 | P1 | discord | Each nudge is posted once ([team nudges](../discord/channel-messages.md)). | A team that has received one. | 1. Wait through several cron cycles. | It is not repeated. | not run |
| CHAN-07 | P2 | discord | The first-light nudge re-arms after a run scores (suspected gap) ([team nudges](../discord/channel-messages.md)). | A team that received the first-light nudge, then scores a run, then goes quiet again. | 1. Watch over the following days. | Record whether the nudge can ever fire again. The document notes the clearing function is never called. | not run |
| CHAN-08 | P2 | discord, device | A new team best is called out ([the run bubble](../discord/channel-messages.md)). | A run that beats the team's previous best. | 1. Read the terminal bubble. | A line naming the previous best it passed. | not run |
| CHAN-09 | P2 | discord, device | A dirty worktree is marked ([the run bubble](../discord/channel-messages.md)). | A `--live` run from a dirty tree. | 1. Read the bubble. | It says the workspace has uncommitted changes and that hosted verification needs a commit and push. | not run |
| CHAN-10 | P3 | discord, device | The bubble is edited on a fixed tick (suspected waste) ([While it works](../discord/channel-messages.md)). | A long run. | 1. Watch the message's edit indicator. | Record how often it is edited and whether the content changed each time. | not run |

Not checkable by hand:

- Whether the rail would misreport stages for a surface published before it reached the official stage. The state is not reachable through the interface.
- Whether nudge delivery would drop a team past two hundred bound channels in one tick, which needs a cohort larger than any real one.
