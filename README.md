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

## Inviting the bot

Your invite link must include the `bot` **and** `applications.commands` scopes, plus the permissions the bot needs (Ban, Kick, Moderate, Manage Channels, Send Messages, etc.):

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=274878197248
```

Replace `YOUR_APP_ID` with your bot’s Application ID from the Discord Developer Portal.

> The bot automatically registers slash commands in `ALLOWED_GUILD_ID` once it logs in. If commands don’t appear, make sure the bot is in the server and the invite included `applications.commands`.

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

Required:
- `DISCORD_TOKEN` — Bot token.

Optional (the guild and role defaults are already set to the AeroPulse server/roles):
- `ALLOWED_GUILD_ID` (or `GUILD_ID`) — Server the bot operates in.
- `ALLOWED_ROLE_IDS` — Comma-separated staff role IDs for restricted commands. Falls back to `STAFF_ROLE_ID` if not set.
- `TICKET_CATEGORY_ID` — Category for new ticket channels.
- `STAFF_ROLE_ID` — Comma-separated staff role IDs mentioned on new tickets.
- `EXP_CHANNEL_ID` — Channel for hourly EXP drops.
- `TICKET_PANEL_CHANNEL_ID` — Channel where the ticket panel is auto-posted on startup (defaults to `1532222077480730744`).

## Hosting

### Railway
1. Connect the `ashykxees/AeroBot` GitHub repo to Railway.
2. Create a new service and set the start command to `npm start`.
3. Add the environment variables above.
4. Make the service private (no public domain/port).

### Render
This repo includes `render.yaml` for a **Background Worker**.

#### New service (recommended)
1. In Render, choose **Blueprint** and select this repo.
2. Enter the environment variables when prompted.
3. Deploy.

#### Existing service
If you already created the service and see a `go build` error, the service Runtime is set to **Go**:
1. In the Render dashboard, go to **Settings**.
2. Change **Runtime** to **Node**.
3. Set **Build Command** to `npm install` (or leave it blank — Render detects `package.json`).
4. Set **Start Command** to `npm start`.
5. Make sure the environment variables from the screenshot are still present: `DISCORD_TOKEN`, `GUILD_ID`, `STAFF_ROLE_ID`, `TICKET_CATEGORY_ID`, `EXP_CHANNEL_ID`, `TICKET_PANEL_CHANNEL_ID`.
6. Click **Manual Deploy** → **Clear build cache & deploy**.

The bot does not need a public port. A lightweight health server listens on `process.env.PORT || 3000` for hosts that expect one.
