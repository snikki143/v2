# Our Chat V2

A multi-user private messaging MVP. Every account receives a unique Our Chat ID. Users can discover one another by ID, but private messaging starts only after the recipient accepts a chat request.

## Included in this first build

- Individual registration and login
- Unique `OC-XXXXXXXXXXXXXXXX` Our Chat IDs
- Search by exact Our Chat ID
- Incoming and outgoing chat requests
- Accept, decline and cancel requests
- One-to-one conversations after acceptance
- Real-time message delivery with Socket.IO
- Typing indicators, read receipts and online presence
- Basic profile editing
- Blocking users
- PostgreSQL persistence
- Password hashing and server-side sessions in secure HttpOnly cookies

## Requirements

- Node.js 20+
- PostgreSQL 14+

## Local setup

1. Create a PostgreSQL database named `ourchat`.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL` and a long random `SESSION_SECRET`.
4. Install dependencies and create the database tables:

```bash
npm install
npm run db:setup
npm start
```

5. Open `http://localhost:3000`.

## Render deployment

1. Create a PostgreSQL database in Render.
2. Create a new Web Service from this project repository.
3. Set the build command to `npm install && npm run db:setup`.
4. Set the start command to `npm start`.
5. Add these environment variables:
   - `NODE_ENV=production`
   - `DATABASE_URL` = the Render PostgreSQL **internal** connection string when the database and web service are in the same region
   - `SESSION_SECRET` = a long random secret
   - `PGSSL=true` if required by your database connection
6. Deploy and test `/healthz`.

Do not delete or overwrite the V1 Render service while testing V2. Deploy V2 as a separate service first, test account creation and chat requests, and only switch the public domain after verification.

## Important privacy note

This MVP uses HTTPS in production, password hashing, HttpOnly session cookies and server-side access checks. Messages are stored in PostgreSQL and are **not end-to-end encrypted** in this first build. The server operator/database can technically access stored message content. Do not describe this version as end-to-end encrypted. A separate audited end-to-end encryption design would be needed for that promise.

## Current scope

This is the first multi-user foundation, not a finished Instagram-scale service. It currently supports one-to-one conversations. Group chats, attachments, push notifications, account recovery, moderation tooling, backups, observability, and independent security testing should be added before a public production launch.
