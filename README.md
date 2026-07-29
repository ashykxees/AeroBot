# AeroBot

AeroPulse Studios Discord bot with moderation, support tickets, Roblox avatars, and an hourly EXP drop/claim system.

## Setup

1. Copy `.env.example` to `.env` and fill in values.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the bot:
   ```bash
   npm start
   ```

## Commands

- `/ban <user> <reason>` — Ban a user and DM them the reason.
- `/kick <user> <reason>` — Kick a user and DM them the reason.
- `/timeout <user> <duration> <reason>` — Timeout a user and DM them the reason and duration.
- `/dm <user> <message>` — DM a user with an embed.
- `/avatar <roblox-username>` — Show Roblox account info and avatar.
- `/rank` — Show your server EXP rank (open to all members).
- `/ping` — Show bot latency (open to all members).
- `/ticket` — Post the support ticket panel.

## Environment variables

- `DISCORD_TOKEN` — Bot token.
- `ALLOWED_GUILD_ID` — Server the bot operates in.
- `ALLOWED_ROLE_IDS` — Comma-separated staff role IDs for restricted commands.
- `TICKET_CATEGORY_ID` — Category for new ticket channels.
- `STAFF_ROLE_ID` — Staff role mentioned on new tickets.
- `EXP_CHANNEL_ID` — Channel for hourly EXP drops.

## Render

Create a **Background Worker** service and set the environment variables in the Render dashboard. The worker does not need a public port.
