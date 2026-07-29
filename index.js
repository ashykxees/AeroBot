require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
  ComponentType,
} = require('discord.js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = process.env.ALLOWED_GUILD_ID || process.env.GUILD_ID || '1531847605645082664';
const DEFAULT_ROLE_IDS = '1531861205470416936,1531860536193450174,1531860022814965902';
const rawAllowedRoles = process.env.ALLOWED_ROLE_IDS || process.env.STAFF_ROLE_ID || DEFAULT_ROLE_IDS;
const ALLOWED_ROLE_IDS = rawAllowedRoles
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || '';
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || '';
const EXP_CHANNEL_ID = process.env.EXP_CHANNEL_ID || '';

const DATA_FILE = path.join(__dirname, 'data.json');
let db = { points: {}, claims: {}, drops: {} };

function loadData() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db.drops = db.drops || {};
    db.points = db.points || {};
    db.claims = db.claims || {};
  } catch {
    db = { points: {}, claims: {}, drops: {} };
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

loadData();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function inAllowedGuild(guildId) {
  return guildId === ALLOWED_GUILD_ID;
}

function hasAllowedRole(member) {
  if (!member || !member.roles) return false;
  if (member.id === member.guild.ownerId) return true;
  return ALLOWED_ROLE_IDS.some((id) => member.roles.cache.has(id));
}

function botHighestPosition(guild) {
  return guild.members.me?.roles?.highest?.position ?? 0;
}

function canModerateActor(actor, target) {
  if (actor.id === actor.guild.ownerId) return true;
  if (target.id === target.guild.ownerId) return false;
  const actorPos = actor.roles.highest.position;
  const targetPos = target.roles?.highest?.position ?? 0;
  return actorPos > targetPos;
}

function canBotAct(guild, targetMember) {
  const botPos = botHighestPosition(guild);
  if (!targetMember || !targetMember.roles) return true;
  if (targetMember.id === guild.ownerId) return false;
  return botPos > targetMember.roles.highest.position;
}

function parseDuration(input) {
  const str = String(input || '').trim();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    m: 60000,
    min: 60000,
    mins: 60000,
    minute: 60000,
    minutes: 60000,
    h: 3600000,
    hr: 3600000,
    hrs: 3600000,
    hour: 3600000,
    hours: 3600000,
    d: 86400000,
    day: 86400000,
    days: 86400000,
    w: 604800000,
    week: 604800000,
    weeks: 604800000,
  };
  const ms = multipliers[unit] || 60000;
  return Math.round(value * ms);
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const h = Math.floor(m / 60);
  const min = m % 60;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (hr) parts.push(`${hr}h`);
  if (min) parts.push(`${min}m`);
  if (s && !parts.length) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

function safeDefer(interaction, ephemeral = true) {
  return interaction.deferred || interaction.replied
    ? Promise.resolve()
    : interaction.deferReply({ ephemeral });
}

async function safeReply(interaction, payload, ephemeral = true) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp({ ...payload, ephemeral });
    }
    return await interaction.reply({ ...payload, ephemeral });
  } catch (err) {
    console.error('Reply error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Roblox lookup
// ---------------------------------------------------------------------------
async function fetchRobloxUser(username) {
  const resolveRes = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  if (!resolveRes.ok) return null;
  const resolveJson = await resolveRes.json();
  const match = resolveJson.data?.[0];
  if (!match) return null;

  const [detailsRes, thumbRes] = await Promise.all([
    fetch(`https://users.roblox.com/v1/users/${match.userId}`),
    fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshots?userIds=${match.userId}&size=150x150&format=Png&isCircular=false`,
    ),
  ]);

  let details = {};
  if (detailsRes.ok) details = await detailsRes.json();

  let thumbUrl = '';
  if (thumbRes.ok) {
    const thumbJson = await thumbRes.json();
    thumbUrl = thumbJson.data?.[0]?.imageUrl || '';
  }

  return { ...details, avatarUrl: thumbUrl };
}

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user and DM them the reason.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to ban.').setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Ban reason.').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a user and DM them the reason.')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to kick.').setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Kick reason.').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout a user and DM them the reason and duration.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to timeout.').setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('duration')
        .setDescription('Duration like 1h, 30m, 1d.')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Timeout reason.').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('dm')
    .setDescription('DM a specified user with an embed.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('User to DM.')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('message')
        .setDescription('Message to send.')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('View Roblox account info and avatar.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt
        .setName('roblox_user')
        .setDescription('Roblox username.')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('View your server EXP rank.'),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('View the bot latency.'),
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Post the support ticket panel.'),
].map((cmd) => cmd.toJSON());

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, ALLOWED_GUILD_ID), {
      body: commands,
    });
    console.log('Registered slash commands for the allowed guild.');
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
  scheduleNextExpDrop();
});

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
  }
});

async function handleSlashCommand(interaction) {
  if (!inAllowedGuild(interaction.guildId)) {
    return safeReply(interaction, { content: 'This bot is restricted to the AeroPulse Studios server.' });
  }

  const { commandName } = interaction;
  const member = interaction.member;
  const guild = interaction.guild;

  switch (commandName) {
    case 'ping': {
      return safeReply(interaction, { content: `Pong! ${Math.round(client.ws.ping)}ms` });
    }

    case 'rank': {
      const guildPoints = db.points[interaction.guildId] || {};
      const points = guildPoints[interaction.user.id] || 0;
      const sorted = Object.entries(guildPoints).sort((a, b) => b[1] - a[1]);
      const rank = sorted.findIndex(([id]) => id === interaction.user.id) + 1;
      const total = sorted.length;
      const embed = new EmbedBuilder()
        .setTitle('AeroPulse EXP Rank')
        .setColor(0x5865f2)
        .setDescription(`You have **${points}** EXP.`)
        .addFields(
          { name: 'Rank', value: rank ? `#${rank} of ${total}` : 'Unranked', inline: true },
          { name: 'Server', value: guild.name, inline: true },
        )
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    case 'ticket': {
      if (!member.permissionsIn(interaction.channel).has(PermissionFlagsBits.SendMessages)) {
        return safeReply(interaction, { content: 'I do not have permission to send messages here.' });
      }
      const embed = new EmbedBuilder()
        .setTitle('AeroPulse Studios tickets')
        .setDescription(
          'Pick a category, then describe your request in the form.\n\n' +
            '• **Report** — player / behavior report\n' +
            '• **Support** — general help\n' +
            '• **Content creator** — partnership / creators',
        )
        .setColor(0x5865f2);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_report')
          .setLabel('Report')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('ticket_support')
          .setLabel('Support')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('ticket_creator')
          .setLabel('Content creator')
          .setStyle(ButtonStyle.Success),
      );
      await interaction.channel.send({ embeds: [embed], components: [row] });
      return safeReply(interaction, { content: 'Ticket panel posted.' });
    }

    default: {
      if (!hasAllowedRole(member)) {
        return safeReply(interaction, { content: 'You do not have permission to use this command.' });
      }
      break;
    }
  }

  // Moderation / staff commands
  try {
    switch (commandName) {
      case 'ban': {
        const targetUser = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

        if (targetUser.id === guild.ownerId) {
          return safeReply(interaction, { content: 'I cannot ban the server owner.' });
        }
        if (targetMember && !canModerateActor(member, targetMember)) {
          return safeReply(interaction, { content: 'You cannot ban this user due to role hierarchy.' });
        }
        if (targetMember && !canBotAct(guild, targetMember)) {
          return safeReply(interaction, { content: 'My role is too low to ban this user.' });
        }

        const dmEmbed = new EmbedBuilder()
          .setTitle('You have been banned')
          .setColor(0xed4245)
          .setDescription(`You were banned from **${guild.name}**.`)
          .addFields({ name: 'Reason', value: reason })
          .setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] }).catch(() => {});

        await guild.members.ban(targetUser, { reason });
        return safeReply(interaction, { content: `Banned ${targetUser.tag}.` });
      }

      case 'kick': {
        const targetUser = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

        if (!targetMember) {
          return safeReply(interaction, { content: 'That user is not in the server.' });
        }
        if (targetMember.id === guild.ownerId) {
          return safeReply(interaction, { content: 'I cannot kick the server owner.' });
        }
        if (!canModerateActor(member, targetMember)) {
          return safeReply(interaction, { content: 'You cannot kick this user due to role hierarchy.' });
        }
        if (!canBotAct(guild, targetMember)) {
          return safeReply(interaction, { content: 'My role is too low to kick this user.' });
        }

        const dmEmbed = new EmbedBuilder()
          .setTitle('You have been kicked')
          .setColor(0xed4245)
          .setDescription(`You were kicked from **${guild.name}**.`)
          .addFields({ name: 'Reason', value: reason })
          .setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] }).catch(() => {});

        await targetMember.kick(reason);
        return safeReply(interaction, { content: `Kicked ${targetUser.tag}.` });
      }

      case 'timeout': {
        const targetUser = interaction.options.getUser('user', true);
        const durationInput = interaction.options.getString('duration', true);
        const reason = interaction.options.getString('reason', true);
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        const ms = parseDuration(durationInput);

        if (!ms || ms <= 0) {
          return safeReply(interaction, { content: 'Invalid duration. Use a format like `1h`, `30m`, or `1d`.' });
        }
        if (ms < 10000) {
          return safeReply(interaction, { content: 'Timeout must be at least 10 seconds.' });
        }
        if (ms > 28 * 24 * 60 * 60 * 1000) {
          return safeReply(interaction, { content: 'Timeout cannot exceed 28 days.' });
        }
        if (!targetMember) {
          return safeReply(interaction, { content: 'That user is not in the server.' });
        }
        if (targetMember.id === guild.ownerId) {
          return safeReply(interaction, { content: 'I cannot timeout the server owner.' });
        }
        if (!canModerateActor(member, targetMember)) {
          return safeReply(interaction, { content: 'You cannot timeout this user due to role hierarchy.' });
        }
        if (!canBotAct(guild, targetMember)) {
          return safeReply(interaction, { content: 'My role is too low to timeout this user.' });
        }

        const dmEmbed = new EmbedBuilder()
          .setTitle('You have been timed out')
          .setColor(0xfaa61a)
          .setDescription(`You were timed out in **${guild.name}**.`)
          .addFields(
            { name: 'Reason', value: reason },
            { name: 'Duration', value: formatDuration(ms) },
          )
          .setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] }).catch(() => {});

        await targetMember.timeout(ms, reason);
        return safeReply(interaction, { content: `Timed out ${targetUser.tag} for ${formatDuration(ms)}.` });
      }

      case 'dm': {
        const targetUser = interaction.options.getUser('user', true);
        const message = interaction.options.getString('message', true);
        const embed = new EmbedBuilder()
          .setTitle('AeroPulse Studios')
          .setColor(0x5865f2)
          .setDescription(message)
          .setFooter({ text: `Sent by ${interaction.user.tag} from ${guild.name}` })
          .setTimestamp();
        const sent = await targetUser.send({ embeds: [embed] }).catch((err) => {
          console.error('DM failed:', err);
          return null;
        });
        if (!sent) {
          return safeReply(interaction, { content: 'Could not DM that user. They may have DMs disabled.' });
        }
        return safeReply(interaction, { content: `DM sent to ${targetUser.tag}.` });
      }

      case 'avatar': {
        const username = interaction.options.getString('roblox_user', true);
        await interaction.deferReply({ ephemeral: false });
        const roblox = await fetchRobloxUser(username);
        if (!roblox) {
          return interaction.editReply({ content: 'Could not find that Roblox user.' });
        }
        const embed = new EmbedBuilder()
          .setTitle(roblox.name || username)
          .setURL(`https://www.roblox.com/users/${roblox.id}/profile`)
          .setColor(0x5865f2)
          .setThumbnail(roblox.avatarUrl || null)
          .addFields(
            { name: 'Display Name', value: roblox.displayName || roblox.name || 'N/A', inline: true },
            { name: 'User ID', value: String(roblox.id), inline: true },
            { name: 'Created', value: roblox.created ? new Date(roblox.created).toLocaleDateString() : 'N/A', inline: true },
            { name: 'Banned', value: roblox.isBanned ? 'Yes' : 'No', inline: true },
          );
        if (roblox.description) {
          embed.setDescription(roblox.description.slice(0, 2048));
        }
        return interaction.editReply({ embeds: [embed] });
      }

      default:
        return safeReply(interaction, { content: 'Unknown command.' });
    }
  } catch (err) {
    console.error(`Command error (${commandName}):`, err);
    return safeReply(interaction, { content: 'An error occurred while running that command.' });
  }
}

// ---------------------------------------------------------------------------
// Buttons: ticket + EXP claim
// ---------------------------------------------------------------------------
async function handleButton(interaction) {
  try {
    if (interaction.customId.startsWith('ticket_')) {
      const category = interaction.customId.replace('ticket_', '');
      return showTicketModal(interaction, category);
    }

    if (interaction.customId === 'exp_claim') {
      return handleExpClaim(interaction);
    }
  } catch (err) {
    console.error('Button error:', err);
  }
}

function showTicketModal(interaction, category) {
  const modal = new ModalBuilder()
    .setCustomId(`ticket_modal_${category}`)
    .setTitle(`Ticket · ${category}`);

  const usernameInput = new TextInputBuilder()
    .setCustomId(`ticket_${category}_username`)
    .setLabel('Roblox username')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const reasonInput = new TextInputBuilder()
    .setCustomId(`ticket_${category}_reason`)
    .setLabel(category === 'support' ? 'Why do you need support?' : 'Why are you opening this ticket?')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2000);

  let extraInput;
  if (category === 'creator') {
    extraInput = new TextInputBuilder()
      .setCustomId(`ticket_${category}_channel`)
      .setLabel('Channel link (YouTube, TikTok, etc.)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
  } else {
    extraInput = new TextInputBuilder()
      .setCustomId(`ticket_${category}_extras`)
      .setLabel(
        category === 'report'
          ? 'Links (proof, screenshots, video) · optional'
          : 'Additional details · optional',
      )
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(2000);
  }

  modal.addComponents(
    new ActionRowBuilder().addComponents(usernameInput),
    new ActionRowBuilder().addComponents(reasonInput),
    new ActionRowBuilder().addComponents(extraInput),
  );

  return interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// Modal submissions
// ---------------------------------------------------------------------------
async function handleModal(interaction) {
  if (!interaction.customId.startsWith('ticket_modal_')) return;
  const category = interaction.customId.replace('ticket_modal_', '');
  const username = interaction.fields.getTextInputValue(`ticket_${category}_username`);
  const reason = interaction.fields.getTextInputValue(`ticket_${category}_reason`);
  let extra = '';
  if (category === 'creator') {
    extra = interaction.fields.getTextInputValue(`ticket_${category}_channel`);
  } else {
    extra = interaction.fields.getTextInputValue(`ticket_${category}_extras`) || '';
  }

  if (!inAllowedGuild(interaction.guildId)) {
    return safeReply(interaction, { content: 'Tickets are only available in the AeroPulse Studios server.' });
  }

  const guild = interaction.guild;
  const user = interaction.user;

  try {
    const channelName = `${category}-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 100);
    const permissionOverwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ];
    if (STAFF_ROLE_ID) {
      permissionOverwrites.push({
        id: STAFF_ROLE_ID,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      });
    }

    let ticketChannel;
    if (TICKET_CATEGORY_ID) {
      ticketChannel = await guild.channels.create({
        name: channelName || 'ticket',
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID,
        permissionOverwrites,
        reason: `Ticket created by ${user.tag}`,
      });
    }

    const fields = [
      { name: 'Category', value: category, inline: true },
      { name: 'Roblox username', value: username, inline: true },
      { name: 'Submitted by', value: `${user} (\`${user.tag}\`)`, inline: true },
      { name: 'Reason / Details', value: reason.slice(0, 1024) },
    ];
    if (extra) {
      fields.push({
        name: category === 'creator' ? 'Channel link' : 'Links / Additional details',
        value: extra.slice(0, 1024),
      });
    }

    const ticketEmbed = new EmbedBuilder()
      .setTitle(`New ticket · ${category}`)
      .setColor(0x5865f2)
      .addFields(fields)
      .setTimestamp();

    if (ticketChannel) {
      const mentionParts = [user.toString()];
      if (STAFF_ROLE_ID) mentionParts.push(`<@&${STAFF_ROLE_ID}>`);
      await ticketChannel.send({ content: mentionParts.join(' '), embeds: [ticketEmbed] });
      return safeReply(interaction, { content: `Ticket created: ${ticketChannel}` });
    }

    // No ticket category configured; record and reply
    return safeReply(interaction, {
      content: `Ticket recorded. No ticket category is configured, so a channel was not created.`,
    });
  } catch (err) {
    console.error('Ticket creation error:', err);
    return safeReply(interaction, { content: 'Failed to create ticket. Check my permissions and the ticket category ID.' });
  }
}

// ---------------------------------------------------------------------------
// EXP system
// ---------------------------------------------------------------------------
function scheduleNextExpDrop() {
  if (!EXP_CHANNEL_ID) return;
  const now = Date.now();
  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  // Random offset between 5 and 55 minutes within the hour
  const randomOffset = Math.floor((5 + Math.random() * 50) * 60 * 1000);
  const nextDrop = nextHour.getTime() + randomOffset;
  const delay = nextDrop - now;

  console.log(`Next EXP drop scheduled in ${Math.round(delay / 1000)}s`);
  setTimeout(async () => {
    await sendExpDrop();
    scheduleNextExpDrop();
  }, delay);
}

async function sendExpDrop() {
  try {
    const channel = await client.channels.fetch(EXP_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const points = Math.floor(Math.random() * 41) + 10; // 10-50
    const embed = new EmbedBuilder()
      .setTitle('EXP Drop!')
      .setColor(0x57f287)
      .setDescription('Be the first to click the button below and claim the EXP!')
      .addFields({ name: 'Reward', value: `${points} EXP`, inline: true })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('exp_claim').setLabel('Claim').setStyle(ButtonStyle.Success),
    );

    const message = await channel.send({ embeds: [embed], components: [row] });
    db.drops[message.id] = { points, sentAt: Date.now() };
    saveData();
    console.log(`Sent EXP drop message ${message.id} worth ${points} EXP`);
  } catch (err) {
    console.error('EXP drop error:', err);
  }
}

async function handleExpClaim(interaction) {
  if (!inAllowedGuild(interaction.guildId)) {
    return safeReply(interaction, { content: 'EXP drops are only available in the AeroPulse Studios server.' });
  }

  const messageId = interaction.message.id;
  if (db.claims[messageId]) {
    return interaction.reply({ content: 'This drop has already been claimed.', ephemeral: true });
  }

  if (!interaction.message.editable) {
    return interaction.reply({ content: 'I cannot edit this drop message.', ephemeral: true });
  }

  const points = db.drops[messageId]?.points || Math.floor(Math.random() * 41) + 10;
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  if (!db.points[guildId]) db.points[guildId] = {};
  db.points[guildId][userId] = (db.points[guildId][userId] || 0) + points;
  db.claims[messageId] = {
    claimedBy: userId,
    points,
    claimedAt: Date.now(),
  };
  saveData();

  const claimedEmbed = new EmbedBuilder()
    .setTitle('EXP Drop Claimed!')
    .setColor(0x57f287)
    .setDescription(`${interaction.user} claimed **${points}** EXP!`)
    .addFields({ name: 'Total EXP', value: String(db.points[guildId][userId]), inline: true })
    .setTimestamp();

  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('exp_claim')
      .setLabel('Claimed')
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
  );

  await interaction.update({ embeds: [claimedEmbed], components: [disabledRow] });
  await interaction.followUp({ content: `You claimed **${points}** EXP!`, ephemeral: true });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing. Set it in your .env file or environment.');
  process.exit(1);
}

client.login(DISCORD_TOKEN);

// Minimal health endpoint for Render / container hosts
const port = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AeroBot is running');
  })
  .listen(port, () => console.log(`Health server listening on port ${port}`));
