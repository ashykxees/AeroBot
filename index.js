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
  OverwriteType,
  AttachmentBuilder,
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
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_ID || process.env.ALLOWED_ROLE_IDS || DEFAULT_ROLE_IDS)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TICKET_PING_ROLE_ID = process.env.TICKET_PING_ROLE_ID || '1531861205470416936';
const TICKET_CLAIM_ROLE_IDS = (process.env.TICKET_CLAIM_ROLE_IDS || '1531860536193450174,1531861205470416936')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ESCALATION_ROLE_ID = process.env.ESCALATION_ROLE_ID || '1531860536193450174';
const TICKET_LOG_CHANNEL_ID = process.env.TICKET_LOG_CHANNEL_ID || '';
const EXP_CHANNEL_ID = process.env.EXP_CHANNEL_ID || '';
const TICKET_PANEL_CHANNEL_ID = process.env.TICKET_PANEL_CHANNEL_ID || '1532222077480730744';

const DATA_FILE = path.join(__dirname, 'data.json');
let db = { points: {}, claims: {}, drops: {}, ticketPanel: {}, tickets: {}, expRewards: {} };

function loadData() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db.drops = db.drops || {};
    db.points = db.points || {};
    db.claims = db.claims || {};
    db.ticketPanel = db.ticketPanel || {};
    db.tickets = db.tickets || {};
    db.expRewards = db.expRewards || {};
  } catch {
    db = { points: {}, claims: {}, drops: {}, ticketPanel: {}, tickets: {}, expRewards: {} };
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

function isAdmin(member) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  return hasAllowedRole(member);
}

function canClaimTicket(member) {
  if (isAdmin(member)) return true;
  return TICKET_CLAIM_ROLE_IDS.some((id) => member.roles.cache.has(id));
}

function canCloseTicket(member, ticket) {
  if (isAdmin(member)) return true;
  if (ticket && (ticket.claimedBy === member.id || ticket.openerId === member.id)) return true;
  return false;
}

function buildTicketPanel() {
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
  return { embeds: [embed], components: [row] };
}

async function ensureTicketPanel() {
  if (!TICKET_PANEL_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(TICKET_PANEL_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.warn('Ticket panel channel not found or not a text channel.');
      return;
    }

    const { messageId } = db.ticketPanel || {};
    if (messageId) {
      try {
        const existing = await channel.messages.fetch(messageId);
        if (existing) {
          console.log(`Ticket panel already exists: ${messageId}`);
          return;
        }
      } catch {
        // message deleted or inaccessible; continue
      }
    }

    const messages = await channel.messages.fetch({ limit: 100 });
    const existing = messages.find(
      (m) =>
        m.author.id === client.user.id &&
        m.embeds[0]?.title === 'AeroPulse Studios tickets',
    );
    if (existing) {
      db.ticketPanel = { channelId: channel.id, messageId: existing.id };
      saveData();
      console.log(`Found existing ticket panel: ${existing.id}`);
      return;
    }

    const panel = buildTicketPanel();
    const sent = await channel.send(panel);
    db.ticketPanel = { channelId: channel.id, messageId: sent.id };
    saveData();
    console.log(`Sent ticket panel: ${sent.id}`);
  } catch (err) {
    console.error('Failed to ensure ticket panel:', err.message);
  }
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
    .setName('dm')
    .setDescription('DM a specified user with an embed.')
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
  new SlashCommandBuilder()
    .setName('checkexp')
    .setDescription("Check a user's EXP total (staff only).")
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('User to check.')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('addexp')
    .setDescription('Add EXP to a user (staff only).')
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('User to add EXP to.')
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('amount')
        .setDescription('Amount of EXP to add.')
        .setRequired(true)
        .setMinValue(1),
    ),
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
  ensureTicketPanel();
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
      await interaction.channel.send(buildTicketPanel());
      return safeReply(interaction, { content: 'Ticket panel posted.' });
    }
  }

  // Staff-only commands (dm, avatar, checkexp, addexp)
  if (!hasAllowedRole(member)) {
    return safeReply(interaction, { content: 'You do not have permission to use this command.' });
  }

  try {
    switch (commandName) {
      case 'checkexp': {
        const targetUser = interaction.options.getUser('user', true);
        const guildPoints = db.points[interaction.guildId] || {};
        const points = guildPoints[targetUser.id] || 0;
        return safeReply(interaction, { content: `${targetUser} has **${points}** EXP.` });
      }

      case 'addexp': {
        const targetUser = interaction.options.getUser('user', true);
        const amount = interaction.options.getInteger('amount', true);
        const guildPoints = db.points[interaction.guildId] || {};
        const current = guildPoints[targetUser.id] || 0;
        const newTotal = current + amount;
        guildPoints[targetUser.id] = newTotal;
        db.points[interaction.guildId] = guildPoints;
        saveData();
        await notifyExpRewards(targetUser, newTotal);
        return safeReply(interaction, { content: `Added **${amount}** EXP to ${targetUser}. New total: **${newTotal}** EXP.` });
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
const TICKET_OPEN_IDS = ['ticket_report', 'ticket_support', 'ticket_creator'];

async function handleButton(interaction) {
  try {
    if (interaction.customId === 'exp_claim') {
      return handleExpClaim(interaction);
    }

    if (TICKET_OPEN_IDS.includes(interaction.customId)) {
      const category = interaction.customId.replace('ticket_', '');
      return showTicketModal(interaction, category);
    }

    if (interaction.customId === 'ticket_claim') {
      return handleTicketClaim(interaction);
    }

    if (interaction.customId === 'ticket_escalate') {
      return handleTicketEscalate(interaction);
    }

    if (interaction.customId === 'ticket_close') {
      return handleTicketClose(interaction);
    }
  } catch (err) {
    console.error('Button error:', err);
  }
}

async function handleTicketClaim(interaction) {
  const member = interaction.member;
  if (!canClaimTicket(member)) {
    return safeReply(interaction, { content: 'You do not have permission to claim this ticket.' });
  }

  const ticket = db.tickets[interaction.channelId];
  if (ticket && ticket.claimedBy) {
    return safeReply(interaction, { content: `This ticket is already claimed by <@${ticket.claimedBy}>.` });
  }

  await interaction.deferUpdate();

  const message = interaction.message;
  const embed = EmbedBuilder.from(message.embeds[0]);
  embed.addFields({ name: 'Claimed by', value: `${interaction.user} (\`${interaction.user.tag}\`)`, inline: true });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel('Claimed')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder().setCustomId('ticket_escalate').setLabel('Escalate').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Secondary),
  );

  await message.edit({ embeds: [embed], components: [row] });

  if (ticket) {
    ticket.claimedBy = member.id;
    saveData();
  }

  await interaction.followUp({ content: 'Ticket claimed.', ephemeral: true });
}

async function handleTicketEscalate(interaction) {
  const member = interaction.member;
  if (!canClaimTicket(member)) {
    return safeReply(interaction, { content: 'You do not have permission to escalate this ticket.' });
  }

  await interaction.reply({ content: 'Ticket escalated.', ephemeral: true });
  await interaction.channel.send({
    content: `<@&${ESCALATION_ROLE_ID}> Ticket escalated by ${interaction.user}.`,
  });
}

async function buildChannelTranscript(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = [];
  for (const msg of sorted) {
    const timestamp = new Date(msg.createdTimestamp).toISOString();
    const author = msg.author ? `${msg.author.tag} (${msg.author.id})` : 'Unknown';
    let content = msg.content || '';
    if (msg.attachments.size > 0) {
      const attachmentUrls = Array.from(msg.attachments.values()).map((a) => a.url).join(' ');
      content += (content ? ' ' : '') + `[Attachments: ${attachmentUrls}]`;
    }
    if (!content) content = '*No text content*';
    lines.push(`[${timestamp}] ${author}: ${content}`);
  }
  return lines.join('\n');
}

async function getTicketInfo(channel) {
  const fromDb = db.tickets[channel.id];
  if (fromDb) return fromDb;

  const messages = await channel.messages.fetch({ limit: 50 });
  const ticketMessage = messages.find((m) => m.author.id === client.user.id && m.embeds[0]?.title?.startsWith('New ticket'));
  if (!ticketMessage) return null;

  const embed = ticketMessage.embeds[0];
  const openerField = embed.fields.find((f) => f.name === 'Submitted by');
  const claimedField = embed.fields.find((f) => f.name === 'Claimed by');
  const categoryField = embed.fields.find((f) => f.name === 'Category');
  const openerMatch = openerField?.value?.match(/<@!?(\d+)>/);
  const claimedMatch = claimedField?.value?.match(/<@!?(\d+)>/);

  return {
    openerId: openerMatch ? openerMatch[1] : null,
    claimedBy: claimedMatch ? claimedMatch[1] : null,
    category: categoryField?.value || 'unknown',
    messageId: ticketMessage.id,
  };
}

async function handleTicketClose(interaction) {
  const channel = interaction.channel;
  const member = interaction.member;
  const ticket = db.tickets[channel.id] || (await getTicketInfo(channel));

  if (!canCloseTicket(member, ticket)) {
    return safeReply(interaction, { content: 'You do not have permission to close this ticket.' });
  }

  await interaction.deferUpdate();

  let transcript = '';
  try {
    transcript = await buildChannelTranscript(channel);
  } catch (err) {
    console.error('Failed to build transcript:', err.message);
  }

  const openerId = ticket?.openerId;
  const claimedBy = ticket?.claimedBy || 'Unclaimed';
  const fileName = `transcript-${channel.name}.txt`;
  const fileBuffer = Buffer.from(transcript, 'utf-8');

  if (openerId) {
    try {
      const opener = await interaction.guild.members.fetch(openerId);
      const dmAttachment = new AttachmentBuilder(fileBuffer, { name: fileName });
      await opener.send({
        content: `Your ticket in **${interaction.guild.name}** has been closed. A transcript is attached.`,
        files: [dmAttachment],
      });
    } catch (err) {
      console.error('Failed to DM ticket transcript:', err.message);
    }
  }

  if (TICKET_LOG_CHANNEL_ID) {
    try {
      const logChannel = await client.channels.fetch(TICKET_LOG_CHANNEL_ID);
      if (logChannel && logChannel.type === ChannelType.GuildText) {
        const logAttachment = new AttachmentBuilder(Buffer.from(transcript, 'utf-8'), { name: fileName });
        const logEmbed = new EmbedBuilder()
          .setTitle('Ticket Closed')
          .setColor(0xed4245)
          .addFields(
            { name: 'Channel', value: channel.name, inline: true },
            { name: 'Opened by', value: openerId ? `<@${openerId}> (\`${openerId}\`)` : 'Unknown', inline: true },
            { name: 'Claimed by', value: claimedBy !== 'Unclaimed' ? `<@${claimedBy}>` : 'Unclaimed', inline: true },
            { name: 'Closed by', value: `${interaction.user} (\`${interaction.user.tag}\`)`, inline: true },
          )
          .setTimestamp();
        await logChannel.send({ embeds: [logEmbed], files: [logAttachment] });
      }
    } catch (err) {
      console.error('Failed to send ticket log:', err.message);
    }
  }

  if (ticket && db.tickets[channel.id]) {
    delete db.tickets[channel.id];
    saveData();
  }

  try {
    await channel.delete(`Ticket closed by ${interaction.user.tag}`);
  } catch (err) {
    console.error('Failed to delete ticket channel:', err.message);
    await interaction.followUp({ content: 'Transcript saved, but I could not delete the channel.', ephemeral: true });
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
      { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ];
    for (const roleId of STAFF_ROLE_IDS) {
      permissionOverwrites.push({
        id: roleId,
        type: OverwriteType.Role,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      });
    }

    let ticketChannel;
    let parentError = null;
    const channelProps = {
      name: channelName || 'ticket',
      type: ChannelType.GuildText,
      permissionOverwrites,
      reason: `Ticket created by ${user.tag}`,
    };

    if (TICKET_CATEGORY_ID) {
      try {
        ticketChannel = await guild.channels.create({
          ...channelProps,
          parent: TICKET_CATEGORY_ID,
        });
      } catch (err) {
        parentError = err;
        console.warn(`Ticket creation under category ${TICKET_CATEGORY_ID} failed:`, err.message);
      }
    }

    // Fallback: create without a category if the parent category failed or wasn't set
    if (!ticketChannel) {
      try {
        ticketChannel = await guild.channels.create(channelProps);
      } catch (err) {
        console.error('Ticket creation error (no parent):', err.message, err.stack);
        if (parentError) {
          console.error('Original category error:', parentError.message, parentError.stack);
        }
        return safeReply(interaction, {
          content: `Failed to create ticket channel. Discord error: \`${err.message || err}\``,
        });
      }
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

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_claim')
        .setLabel('Claim')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('ticket_escalate')
        .setLabel('Escalate')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('ticket_close')
        .setLabel('Close')
        .setStyle(ButtonStyle.Secondary),
    );

    const mentionParts = [user.toString()];
    if (TICKET_PING_ROLE_ID) mentionParts.push(`<@&${TICKET_PING_ROLE_ID}>`);
    const ticketMessage = await ticketChannel.send({
      content: mentionParts.join(' '),
      embeds: [ticketEmbed],
      components: [actionRow],
    });

    db.tickets[ticketChannel.id] = {
      openerId: user.id,
      claimedBy: null,
      category,
      username,
      reason,
      extra,
      createdAt: Date.now(),
      messageId: ticketMessage.id,
    };
    saveData();

    return safeReply(interaction, { content: `Ticket created: ${ticketChannel}` });
  } catch (err) {
    console.error('Ticket creation error:', err.message, err.stack);
    return safeReply(interaction, { content: `Failed to create ticket. \`${err.message || err}\`` });
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

  await notifyExpRewards(interaction.user, db.points[guildId][userId]);
}

async function notifyExpRewards(user, total) {
  try {
    const guildId = ALLOWED_GUILD_ID;
    db.expRewards[guildId] = db.expRewards[guildId] || {};
    const rewards = db.expRewards[guildId][user.id] || [];

    const thresholds = [
      { amount: 1000, robux: 100 },
      { amount: 5000, robux: 250 },
    ];

    for (const { amount, robux } of thresholds) {
      if (total >= amount && !rewards.includes(String(amount))) {
        rewards.push(String(amount));
        await user.send(
          `Congragulations ${user.username}, you have reached ${amount.toLocaleString()} EXP! ` +
            `You can now cash out for ${robux} robux. If you wish to cash out your prize, please create a ticket inside of <#${TICKET_PANEL_CHANNEL_ID}>`,
        );
      }
    }

    db.expRewards[guildId][user.id] = rewards;
    saveData();
  } catch (err) {
    console.error('EXP reward notification error:', err.message);
  }
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
