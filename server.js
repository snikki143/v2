'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be set to a random string of at least 32 characters.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  cors: { origin: false }
});

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '32kb' }));

// Same-origin protection for cookie-authenticated state-changing requests.
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) {
          return res.status(403).json({ error: 'Cross-origin request blocked.' });
        }
      } catch {
        return res.status(403).json({ error: 'Invalid request origin.' });
      }
    }
  }
  next();
});

const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  name: 'ourchat.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 14 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait and try again.' }
});
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Search limit reached. Please try again shortly.' }
});

const onlineUsers = new Map(); // userId -> Set(socketId)
const clean = (value, max) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Please sign in to continue.' });
  }
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    ourChatId: user.our_chat_id,
    username: user.username,
    displayName: user.display_name,
    avatarUrl: user.avatar_url || null,
    bio: user.bio || '',
    lastSeen: user.last_seen || null,
    online: onlineUsers.has(user.id)
  };
}

function pairKey(a, b) {
  return [a, b].sort().join(':');
}

async function getUserById(id) {
  const result = await pool.query(
    `SELECT id, our_chat_id, username, display_name, avatar_url, bio, last_seen
       FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function isBlocked(a, b) {
  const result = await pool.query(
    `SELECT 1 FROM blocks
      WHERE (blocker_id = $1 AND blocked_id = $2)
         OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [a, b]
  );
  return result.rowCount > 0;
}

async function conversationForPair(a, b) {
  const result = await pool.query(
    `SELECT c.id
       FROM conversations c
       JOIN conversation_members ma ON ma.conversation_id = c.id AND ma.user_id = $1
       JOIN conversation_members mb ON mb.conversation_id = c.id AND mb.user_id = $2
      LIMIT 1`,
    [a, b]
  );
  return result.rows[0] || null;
}

async function requireConversationMember(conversationId, userId) {
  const result = await pool.query(
    `SELECT 1 FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return result.rowCount > 0;
}

async function emitToConversation(conversationId, event, payload) {
  const result = await pool.query(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
    [conversationId]
  );
  for (const row of result.rows) {
    io.to(`user:${row.user_id}`).emit(event, payload);
  }
}

async function emitPresence(userId, online) {
  const result = await pool.query(
    `SELECT DISTINCT other.user_id
       FROM conversation_members mine
       JOIN conversation_members other
         ON other.conversation_id = mine.conversation_id
      WHERE mine.user_id = $1 AND other.user_id <> $1`,
    [userId]
  );
  for (const row of result.rows) {
    io.to(`user:${row.user_id}`).emit('presence', { userId, online });
  }
}

async function makeOurChatId() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = 'OC-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const exists = await pool.query('SELECT 1 FROM users WHERE our_chat_id = $1', [id]);
    if (!exists.rowCount) return id;
  }
  throw new Error('Could not generate a unique Our Chat ID. Please retry.');
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => err ? reject(err) : resolve());
  });
}
function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => err ? reject(err) : resolve());
  });
}

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'our-chat-v2' }));

app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const username = clean(req.body.username, 24).toLowerCase();
  const displayName = clean(req.body.displayName, 40);
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!/^[a-z0-9._]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–24 characters using letters, numbers, dots or underscores.' });
  }
  if (displayName.length < 2) {
    return res.status(400).json({ error: 'Display name must contain at least 2 characters.' });
  }
  if (password.length < 10 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be between 10 and 128 characters.' });
  }

  const id = crypto.randomUUID();
  const ourChatId = await makeOurChatId();
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const result = await pool.query(
      `INSERT INTO users (id, our_chat_id, username, display_name, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, our_chat_id, username, display_name, avatar_url, bio, last_seen`,
      [id, ourChatId, username, displayName, passwordHash]
    );
    await regenerateSession(req);
    req.session.userId = id;
    await saveSession(req);
    res.status(201).json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'That username is already taken. Please choose another.' });
    }
    throw error;
  }
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const identity = clean(req.body.identity, 64);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!identity || !password) return res.status(400).json({ error: 'Enter your username or Our Chat ID and password.' });

  const result = await pool.query(
    `SELECT id, our_chat_id, username, display_name, avatar_url, bio, last_seen, password_hash
       FROM users
      WHERE LOWER(username) = LOWER($1) OR our_chat_id = UPPER($1)
      LIMIT 1`,
    [identity]
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect login details.' });
  }

  await regenerateSession(req);
  req.session.userId = user.id;
  await saveSession(req);
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', requireAuth, asyncRoute(async (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: 'Could not sign out.' });
    res.clearCookie('ourchat.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
    res.json({ ok: true });
  });
}));

app.get('/api/me', requireAuth, asyncRoute(async (req, res) => {
  const user = await getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Account not found.' });
  res.json({ user: publicUser(user) });
}));

app.patch('/api/profile', requireAuth, asyncRoute(async (req, res) => {
  const displayName = clean(req.body.displayName, 40);
  const bio = clean(req.body.bio, 160);
  if (displayName.length < 2) return res.status(400).json({ error: 'Display name must contain at least 2 characters.' });
  const result = await pool.query(
    `UPDATE users SET display_name = $1, bio = $2
      WHERE id = $3
      RETURNING id, our_chat_id, username, display_name, avatar_url, bio, last_seen`,
    [displayName, bio, req.session.userId]
  );
  res.json({ user: publicUser(result.rows[0]) });
}));

app.get('/api/users/search', requireAuth, searchLimiter, asyncRoute(async (req, res) => {
  const ourChatId = clean(req.query.id, 20).toUpperCase();
  if (!/^OC-[A-F0-9]{16}$/.test(ourChatId)) {
    return res.status(400).json({ error: 'Enter a valid Our Chat ID, for example OC-4A92F7B1C0D2E4F6.' });
  }
  const result = await pool.query(
    `SELECT id, our_chat_id, username, display_name, avatar_url, bio, last_seen
       FROM users WHERE our_chat_id = $1`,
    [ourChatId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'No Our Chat account found with that ID.' });
  if (result.rows[0].id === req.session.userId) {
    return res.status(400).json({ error: 'That is your own Our Chat ID.' });
  }
  const blocked = await isBlocked(req.session.userId, result.rows[0].id);
  if (blocked) return res.status(404).json({ error: 'This account is unavailable.' });
  res.json({ user: publicUser(result.rows[0]) });
}));

app.post('/api/requests', requireAuth, asyncRoute(async (req, res) => {
  const ourChatId = clean(req.body.ourChatId, 20).toUpperCase();
  if (!/^OC-[A-F0-9]{16}$/.test(ourChatId)) {
    return res.status(400).json({ error: 'Enter a valid Our Chat ID.' });
  }

  const found = await pool.query('SELECT id FROM users WHERE our_chat_id = $1', [ourChatId]);
  if (!found.rowCount) return res.status(404).json({ error: 'No account found with that Our Chat ID.' });
  const receiverId = found.rows[0].id;
  const senderId = req.session.userId;

  if (receiverId === senderId) return res.status(400).json({ error: 'You cannot send a request to yourself.' });
  if (await isBlocked(senderId, receiverId)) return res.status(403).json({ error: 'This account is unavailable.' });
  if (await conversationForPair(senderId, receiverId)) {
    return res.status(409).json({ error: 'You are already connected. Open your Chats tab.' });
  }

  const key = pairKey(senderId, receiverId);
  const existing = await pool.query(
    `SELECT id, sender_id, receiver_id FROM chat_requests
      WHERE pair_key = $1 AND status = 'pending' LIMIT 1`,
    [key]
  );
  if (existing.rowCount) {
    if (existing.rows[0].receiver_id === senderId) {
      return res.status(409).json({ error: 'This person has already sent you a request. Check your Requests tab.' });
    }
    return res.status(409).json({ error: 'Your request is already pending.' });
  }

  const requestId = crypto.randomUUID();
  try {
    await pool.query(
      `INSERT INTO chat_requests (id, sender_id, receiver_id, pair_key)
       VALUES ($1, $2, $3, $4)`,
      [requestId, senderId, receiverId, key]
    );
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A request between these accounts is already pending.' });
    throw error;
  }

  const sender = await getUserById(senderId);
  io.to(`user:${receiverId}`).emit('request_received', {
    id: requestId,
    sender: sender
  });
  res.status(201).json({ ok: true, message: 'Chat request sent.' });
}));

app.get('/api/requests', requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.userId;
  const incoming = await pool.query(
    `SELECT r.id, r.created_at,
            u.id AS user_id, u.our_chat_id, u.username, u.display_name, u.avatar_url, u.bio, u.last_seen
       FROM chat_requests r JOIN users u ON u.id = r.sender_id
      WHERE r.receiver_id = $1 AND r.status = 'pending'
      ORDER BY r.created_at DESC`,
    [userId]
  );
  const outgoing = await pool.query(
    `SELECT r.id, r.created_at,
            u.id AS user_id, u.our_chat_id, u.username, u.display_name, u.avatar_url, u.bio, u.last_seen
       FROM chat_requests r JOIN users u ON u.id = r.receiver_id
      WHERE r.sender_id = $1 AND r.status = 'pending'
      ORDER BY r.created_at DESC`,
    [userId]
  );
  const mapRow = (row) => ({
    id: row.id,
    createdAt: row.created_at,
    user: {
      id: row.user_id,
      ourChatId: row.our_chat_id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      bio: row.bio || '',
      lastSeen: row.last_seen,
      online: onlineUsers.has(row.user_id)
    }
  });
  res.json({ incoming: incoming.rows.map(mapRow), outgoing: outgoing.rows.map(mapRow) });
}));

app.post('/api/requests/:id/accept', requireAuth, asyncRoute(async (req, res) => {
  const requestId = req.params.id;
  const userId = req.session.userId;
  const client = await pool.connect();
  let conversationId;

  try {
    await client.query('BEGIN');
    const requestResult = await client.query(
      `SELECT * FROM chat_requests
        WHERE id = $1 AND receiver_id = $2 AND status = 'pending'
        FOR UPDATE`,
      [requestId, userId]
    );
    if (!requestResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This request is no longer available.' });
    }

    const request = requestResult.rows[0];
    const senderId = request.sender_id;
    const blocked = await client.query(
      `SELECT 1 FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1)
        LIMIT 1`,
      [userId, senderId]
    );
    if (blocked.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This account is unavailable.' });
    }

    const existing = await client.query(
      `SELECT c.id FROM conversations c
        JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
        JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
       LIMIT 1`,
      [userId, senderId]
    );

    if (existing.rowCount) {
      conversationId = existing.rows[0].id;
    } else {
      conversationId = crypto.randomUUID();
      await client.query(
        'INSERT INTO conversations (id, pair_key) VALUES ($1, $2)',
        [conversationId, pairKey(userId, senderId)]
      );
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)`,
        [conversationId, userId, senderId]
      );
    }

    await client.query(
      `UPDATE chat_requests
          SET status = 'accepted', conversation_id = $1, updated_at = NOW()
        WHERE id = $2`,
      [conversationId, requestId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const senderId = (await pool.query('SELECT sender_id FROM chat_requests WHERE id = $1', [requestId])).rows[0].sender_id;
  io.to(`user:${senderId}`).emit('request_updated', { id: requestId, status: 'accepted', conversationId });
  io.to(`user:${userId}`).emit('request_updated', { id: requestId, status: 'accepted', conversationId });
  res.json({ ok: true, conversationId });
}));

app.post('/api/requests/:id/decline', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE chat_requests SET status = 'declined', updated_at = NOW()
      WHERE id = $1 AND receiver_id = $2 AND status = 'pending'
      RETURNING sender_id`,
    [req.params.id, req.session.userId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'This request is no longer available.' });
  io.to(`user:${result.rows[0].sender_id}`).emit('request_updated', { id: req.params.id, status: 'declined' });
  res.json({ ok: true });
}));

app.delete('/api/requests/:id', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE chat_requests SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND sender_id = $2 AND status = 'pending'
      RETURNING receiver_id`,
    [req.params.id, req.session.userId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'This request is no longer available.' });
  io.to(`user:${result.rows[0].receiver_id}`).emit('request_updated', { id: req.params.id, status: 'cancelled' });
  res.json({ ok: true });
}));

app.get('/api/conversations', requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.userId;
  const result = await pool.query(
    `SELECT c.id, c.created_at,
            u.id AS peer_id, u.our_chat_id, u.username, u.display_name, u.avatar_url, u.bio, u.last_seen,
            (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
            (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message_at,
            (SELECT COUNT(*) FROM messages m
              WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.read_at IS NULL) AS unread_count
       FROM conversations c
       JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = $1
       JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id <> $1
       JOIN users u ON u.id = other.user_id
      ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC`,
    [userId]
  );
  res.json({
    conversations: result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      peer: {
        id: row.peer_id,
        ourChatId: row.our_chat_id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        bio: row.bio || '',
        lastSeen: row.last_seen,
        online: onlineUsers.has(row.peer_id)
      },
      lastMessage: row.last_message,
      lastMessageAt: row.last_message_at,
      unreadCount: Number(row.unread_count)
    }))
  });
}));

app.get('/api/conversations/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  const conversationId = req.params.id;
  if (!(await requireConversationMember(conversationId, req.session.userId))) {
    return res.status(404).json({ error: 'Conversation not found.' });
  }
  const before = Number(req.query.before);
  const params = [conversationId];
  let beforeClause = '';
  if (Number.isSafeInteger(before) && before > 0) {
    params.push(before);
    beforeClause = 'AND id < $2';
  }
  const result = await pool.query(
    `SELECT id, sender_id, body, created_at, read_at
       FROM messages
      WHERE conversation_id = $1 ${beforeClause}
      ORDER BY id DESC LIMIT 100`,
    params
  );
  res.json({ messages: result.rows.reverse() });
}));

app.post('/api/conversations/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  const conversationId = req.params.id;
  const userId = req.session.userId;
  if (!(await requireConversationMember(conversationId, userId))) {
    return res.status(404).json({ error: 'Conversation not found.' });
  }

  const peerResult = await pool.query(
    `SELECT user_id FROM conversation_members
      WHERE conversation_id = $1 AND user_id <> $2 LIMIT 1`,
    [conversationId, userId]
  );
  if (!peerResult.rowCount) return res.status(404).json({ error: 'Conversation not found.' });
  if (await isBlocked(userId, peerResult.rows[0].user_id)) {
    return res.status(403).json({ error: 'Messaging is unavailable for this conversation.' });
  }

  const body = typeof req.body.body === 'string' ? req.body.body.replace(/\r\n?/g, '\n').trim() : '';
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (body.length > 4000) return res.status(400).json({ error: 'Message is too long (maximum 4000 characters).' });

  const result = await pool.query(
    `INSERT INTO messages (conversation_id, sender_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, sender_id, body, created_at, read_at`,
    [conversationId, userId, body]
  );
  const message = result.rows[0];
  await emitToConversation(conversationId, 'new_message', { conversationId, message });
  res.status(201).json({ message });
}));

app.post('/api/conversations/:id/read', requireAuth, asyncRoute(async (req, res) => {
  const conversationId = req.params.id;
  const userId = req.session.userId;
  if (!(await requireConversationMember(conversationId, userId))) {
    return res.status(404).json({ error: 'Conversation not found.' });
  }
  const result = await pool.query(
    `UPDATE messages SET read_at = NOW()
      WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL
      RETURNING id`,
    [conversationId, userId]
  );
  if (result.rowCount) {
    const upTo = Math.max(...result.rows.map((row) => Number(row.id)));
    const peerResult = await pool.query(
      `SELECT user_id FROM conversation_members
        WHERE conversation_id = $1 AND user_id <> $2`,
      [conversationId, userId]
    );
    for (const row of peerResult.rows) {
      io.to(`user:${row.user_id}`).emit('messages_read', { conversationId, by: userId, upTo });
    }
  }
  res.json({ ok: true });
}));

app.post('/api/users/:id/block', requireAuth, asyncRoute(async (req, res) => {
  const blockedId = req.params.id;
  if (blockedId === req.session.userId) return res.status(400).json({ error: 'You cannot block yourself.' });
  const exists = await pool.query('SELECT 1 FROM users WHERE id = $1', [blockedId]);
  if (!exists.rowCount) return res.status(404).json({ error: 'Account not found.' });
  await pool.query(
    `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [req.session.userId, blockedId]
  );
  await pool.query(
    `UPDATE chat_requests SET status = 'cancelled', updated_at = NOW()
      WHERE status = 'pending'
        AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))`,
    [req.session.userId, blockedId]
  );
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: isProduction ? '1h' : 0
}));

io.use((socket, next) => {
  const userId = socket.request.session && socket.request.session.userId;
  if (!userId) return next(new Error('Please sign in first.'));
  socket.userId = userId;
  next();
});

io.on('connection', async (socket) => {
  const userId = socket.userId;
  socket.join(`user:${userId}`);

  let sockets = onlineUsers.get(userId);
  if (!sockets) onlineUsers.set(userId, (sockets = new Set()));
  const wasOffline = sockets.size === 0;
  sockets.add(socket.id);
  if (wasOffline) {
    await pool.query('UPDATE users SET last_seen = NULL WHERE id = $1', [userId]).catch(() => {});
    emitPresence(userId, true).catch(() => {});
  }

  socket.on('typing', async (data = {}) => {
    const conversationId = typeof data.conversationId === 'string' ? data.conversationId : '';
    if (!conversationId || !(await requireConversationMember(conversationId, userId))) return;
    const peerResult = await pool.query(
      `SELECT user_id FROM conversation_members
        WHERE conversation_id = $1 AND user_id <> $2`,
      [conversationId, userId]
    );
    for (const row of peerResult.rows) {
      io.to(`user:${row.user_id}`).emit('typing', {
        conversationId,
        userId,
        typing: !!data.typing
      });
    }
  });

  socket.on('disconnect', async () => {
    const set = onlineUsers.get(userId);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      onlineUsers.delete(userId);
      await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]).catch(() => {});
      emitPresence(userId, false).catch(() => {});
    }
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

server.listen(PORT, () => {
  console.log(`Our Chat V2 is running on port ${PORT}`);
});

async function shutdown() {
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
