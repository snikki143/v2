CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  our_chat_id VARCHAR(20) NOT NULL UNIQUE,
  username VARCHAR(24) NOT NULL,
  display_name VARCHAR(40) NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  bio VARCHAR(160) NOT NULL DEFAULT '',
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uq
  ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  pair_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS conversation_members_user_idx
  ON conversation_members (user_id, conversation_id);

CREATE TABLE IF NOT EXISTS chat_requests (
  id UUID PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair_key TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_id <> receiver_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_requests_one_pending_pair_uq
  ON chat_requests (pair_key) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS chat_requests_receiver_status_idx
  ON chat_requests (receiver_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_requests_sender_status_idx
  ON chat_requests (sender_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body VARCHAR(4000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS messages_conversation_id_idx
  ON messages (conversation_id, id DESC);

CREATE INDEX IF NOT EXISTS messages_unread_idx
  ON messages (conversation_id, read_at) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
