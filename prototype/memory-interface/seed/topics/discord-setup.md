# discord-setup
> Discord server layout, bot setup, where things are configured

## Server "Rogier's lab"
- Guild id 1098823001177342
- Channels: #general (chat), #ops (bot alerts and CI noise), #hydra-dev (build discussion), DM with Rogier for everything private.
- #ops channel id: 1188429077315

## Bot
- Bot user "Athena"; application created 2026-07; runs on the Mac mini under launchd.
- Token stored in the macOS keychain item "hydra-discord-bot" (never paste it).
- Intents enabled: message content, guild messages, direct messages.
- Mention-gated in channels, always-on in DMs.
