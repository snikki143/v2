(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    user: null,
    page: 'chats',
    conversations: [],
    requests: { incoming: [], outgoing: [] },
    activeConversation: null,
    messages: [],
    socket: null,
    typingTimer: null,
    toastTimer: null
  };

  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
  }

  function avatar(name, small = false) {
    return `<div class="avatar ${small ? 'avatar-small' : ''}">${escapeHTML(initials(name))}</div>`;
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  function showAuth(mode = 'login') {
    $('authView').classList.remove('hidden');
    $('appView').classList.add('hidden');
    const login = mode === 'login';
    $('loginForm').classList.toggle('hidden', !login);
    $('registerForm').classList.toggle('hidden', login);
    $('authTitle').textContent = login ? 'Welcome back.' : 'Create your space.';
    $('authSubtitle').textContent = login
      ? 'Sign in to continue your conversations.'
      : 'A personal account. A unique ID. Your own space.';
    $('authSwitch').innerHTML = login
      ? 'New to Our Chat? <button type="button" id="showRegister">Create an account</button>'
      : 'Already have an account? <button type="button" id="showLogin">Sign in</button>';
    $('authError').textContent = '';
  }

  function showApp() {
    $('authView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('sideName').textContent = state.user.displayName;
    $('sideHandle').textContent = '@' + state.user.username;
    $('sideAvatar').textContent = initials(state.user.displayName);
    $('topAvatar').textContent = initials(state.user.displayName);
    renderPage();
  }

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    state.socket = io({ withCredentials: true });

    state.socket.on('connect_error', () => {
      // A page refresh will restore the session if the connection is interrupted.
    });
    state.socket.on('new_message', async ({ conversationId, message }) => {
      if (state.activeConversation && state.activeConversation.id === conversationId) {
        if (!state.messages.some((item) => Number(item.id) === Number(message.id))) {
          state.messages.push(message);
          renderMessages();
          if (message.sender_id !== state.user.id) {
            api(`/api/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => {});
          }
        }
      }
      await loadConversations();
      if (state.page === 'chats') renderPage();
    });
    state.socket.on('request_received', async () => {
      await loadRequests();
      updateCounts();
      if (state.page === 'requests') renderPage();
      toast('You received a new chat request.');
    });
    state.socket.on('request_updated', async () => {
      await Promise.all([loadRequests(), loadConversations()]);
      updateCounts();
      if (state.page === 'requests' || state.page === 'chats') renderPage();
    });
    state.socket.on('messages_read', ({ conversationId, by }) => {
      if (state.activeConversation?.id !== conversationId || by === state.user.id) return;
      state.messages.forEach((message) => {
        if (message.sender_id === state.user.id) message.read_at = new Date().toISOString();
      });
      renderMessages();
    });
    state.socket.on('typing', ({ conversationId, typing, userId }) => {
      if (state.activeConversation?.id !== conversationId || userId === state.user.id) return;
      const line = $('typingLine');
      if (!line) return;
      line.textContent = typing ? `${state.activeConversation.peer.displayName} is typing…` : '';
    });
    state.socket.on('presence', async () => {
      await loadConversations();
      if (state.page === 'chats') renderPage();
    });
  }

  async function loadConversations() {
    const data = await api('/api/conversations');
    state.conversations = data.conversations;
    if (state.activeConversation) {
      const refreshed = state.conversations.find((item) => item.id === state.activeConversation.id);
      if (refreshed) state.activeConversation = refreshed;
    }
    updateCounts();
  }

  async function loadRequests() {
    state.requests = await api('/api/requests');
    updateCounts();
  }

  function updateCounts() {
    const incoming = state.requests.incoming.length;
    $('requestCount').textContent = incoming ? incoming : '';
    $('requestCount').classList.toggle('hidden', !incoming);
    const unread = state.conversations.reduce((sum, item) => sum + Number(item.unreadCount || 0), 0);
    $('chatCount').textContent = unread ? unread : '';
    $('chatCount').classList.toggle('hidden', !unread);
  }

  function setPage(page) {
    state.page = page;
    state.activeConversation = null;
    document.querySelectorAll('.nav-item').forEach((button) => {
      button.classList.toggle('active', button.dataset.page === page);
    });
    renderPage();
  }

  function renderPage() {
    const titles = {
      chats: ['YOUR INBOX', 'Messages'],
      discover: ['MAKE A CONNECTION', 'Find people'],
      requests: ['YOUR CONNECTIONS', 'Chat requests'],
      profile: ['YOUR ACCOUNT', 'My profile']
    };
    $('pageEyebrow').textContent = titles[state.page][0];
    $('pageTitle').textContent = titles[state.page][1];

    if (state.page === 'chats') renderChatsPage();
    if (state.page === 'discover') renderDiscoverPage();
    if (state.page === 'requests') renderRequestsPage();
    if (state.page === 'profile') renderProfilePage();
  }

  function renderChatsPage() {
    const conversations = state.conversations;
    const list = conversations.length ? conversations.map((item) => `
      <button class="conversation-item ${state.activeConversation?.id === item.id ? 'selected' : ''}" data-open-chat="${item.id}">
        ${avatar(item.peer.displayName)}
        <span class="conversation-info">
          <span class="conversation-topline"><strong>${escapeHTML(item.peer.displayName)}</strong><time>${escapeHTML(formatTime(item.lastMessageAt))}</time></span>
          <span class="conversation-preview">${escapeHTML(item.lastMessage || 'You are connected. Say hello!')}</span>
        </span>
        ${item.unreadCount ? `<span class="unread-pill">${item.unreadCount}</span>` : ''}
      </button>`).join('') : `<div class="empty-list">No conversations yet.<br>Find someone by their Our Chat ID to get started.</div>`;

    $('pageContent').innerHTML = `
      <div class="chat-layout ${state.activeConversation ? 'has-active' : ''}">
        <section class="chat-list-panel">
          <div class="panel-heading"><h2>All messages</h2><span class="subtle-count">${conversations.length} connections</span></div>
          <div class="conversation-list">${list}</div>
        </section>
        ${state.activeConversation ? renderActiveChat() : `
          <section class="chat-empty">
            <div><div class="empty-icon">✧</div><h2>Your conversations live here.</h2><p>Choose a conversation or find someone using their unique Our Chat ID.</p></div>
          </section>`}
      </div>`;
    bindChatPage();
  }

  function renderActiveChat() {
    const peer = state.activeConversation.peer;
    return `
      <section class="active-chat">
        <header class="chat-header">
          ${avatar(peer.displayName)}
          <div class="chat-header-info"><strong>${escapeHTML(peer.displayName)}</strong><span>${peer.online ? '● Online now' : `Last seen ${escapeHTML(formatTime(peer.lastSeen) || 'earlier')}`} · @${escapeHTML(peer.username)}</span></div>
          <div class="chat-header-actions"><button class="danger-btn" id="blockUserBtn">Block</button></div>
        </header>
        <div class="messages" id="messages"></div>
        <div class="typing-line" id="typingLine"></div>
        <form class="composer" id="messageForm">
          <textarea id="messageInput" maxlength="4000" rows="1" placeholder="Write a message…" autocomplete="off"></textarea>
          <button type="submit" aria-label="Send message">↑</button>
        </form>
      </section>`;
  }

  function bindChatPage() {
    document.querySelectorAll('[data-open-chat]').forEach((button) => {
      button.addEventListener('click', () => openConversation(button.dataset.openChat));
    });
    if (state.activeConversation) {
      renderMessages();
      $('messageForm').addEventListener('submit', sendMessage);
      $('messageInput').addEventListener('input', () => {
        state.socket?.emit('typing', { conversationId: state.activeConversation.id, typing: true });
        clearTimeout(state.typingTimer);
        state.typingTimer = setTimeout(() => {
          state.socket?.emit('typing', { conversationId: state.activeConversation.id, typing: false });
        }, 900);
      });
      $('blockUserBtn').addEventListener('click', blockActiveUser);
    }
  }

  async function openConversation(id) {
    const item = state.conversations.find((conversation) => conversation.id === id);
    if (!item) return;
    state.activeConversation = item;
    const data = await api(`/api/conversations/${id}/messages`);
    state.messages = data.messages;
    renderChatsPage();
    await api(`/api/conversations/${id}/read`, { method: 'POST' }).catch(() => {});
    await loadConversations();
  }

  function renderMessages() {
    const box = $('messages');
    if (!box) return;
    box.innerHTML = state.messages.map((message) => {
      const mine = message.sender_id === state.user.id;
      const status = mine ? (message.read_at ? 'Seen ✓✓' : 'Sent ✓') : '';
      return `<div class="message ${mine ? 'mine' : ''}">${escapeHTML(message.body)}<div class="message-meta">${escapeHTML(formatTime(message.created_at))} ${status}</div></div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  async function sendMessage(event) {
    event.preventDefault();
    const input = $('messageInput');
    const body = input.value.trim();
    if (!body || !state.activeConversation) return;
    input.value = '';
    state.socket?.emit('typing', { conversationId: state.activeConversation.id, typing: false });
    try {
      await api(`/api/conversations/${state.activeConversation.id}/messages`, {
        method: 'POST', body: JSON.stringify({ body })
      });
    } catch (error) {
      input.value = body;
      toast(error.message);
    }
  }

  async function blockActiveUser() {
    if (!state.activeConversation) return;
    if (!confirm(`Block ${state.activeConversation.peer.displayName}? They will not be able to message you.`)) return;
    try {
      await api(`/api/users/${state.activeConversation.peer.id}/block`, { method: 'POST' });
      state.activeConversation = null;
      await loadConversations();
      renderPage();
      toast('Account blocked.');
    } catch (error) { toast(error.message); }
  }

  function renderDiscoverPage() {
    $('pageContent').innerHTML = `
      <div class="content-heading"><div><h2>Find someone on Our Chat</h2><p>Search using their unique Our Chat ID. No phone number required.</p></div></div>
      <section class="discover-card">
        <p class="eyebrow">SEARCH BY OUR CHAT ID</p>
        <form class="search-row" id="userSearchForm">
          <input class="search-input" id="userSearchInput" maxlength="20" placeholder="Example: OC-4A92F7B1C0D2E4F6" autocomplete="off" required>
          <button class="primary-btn" type="submit">Search <span>⌕</span></button>
        </form>
        <div id="searchResult"></div>
        <p class="inline-note">When you send a request, the other person must accept it before you can start chatting.</p>
      </section>`;
    $('userSearchForm').addEventListener('submit', searchUser);
  }

  async function searchUser(event) {
    event.preventDefault();
    const id = $('userSearchInput').value.trim().toUpperCase();
    const resultBox = $('searchResult');
    resultBox.innerHTML = '<p class="muted">Searching…</p>';
    try {
      const data = await api(`/api/users/search?id=${encodeURIComponent(id)}`);
      const person = data.user;
      resultBox.innerHTML = `
        <div class="search-result">
          ${avatar(person.displayName)}
          <div class="search-result-info"><strong>${escapeHTML(person.displayName)}</strong><p>@${escapeHTML(person.username)} · ${escapeHTML(person.ourChatId)}</p><p>${escapeHTML(person.bio || 'No bio added yet.')}</p></div>
          <button class="primary-btn" id="sendRequestBtn">Send request <span>→</span></button>
        </div>`;
      $('sendRequestBtn').addEventListener('click', async () => {
        try {
          await api('/api/requests', { method: 'POST', body: JSON.stringify({ ourChatId: person.ourChatId }) });
          $('sendRequestBtn').disabled = true;
          $('sendRequestBtn').textContent = 'Request sent';
          toast('Chat request sent.');
          await loadRequests();
        } catch (error) { toast(error.message); }
      });
    } catch (error) {
      resultBox.innerHTML = `<div class="empty-state">${escapeHTML(error.message)}</div>`;
    }
  }

  function requestCard(item, incoming) {
    return `<article class="request-card">
      ${avatar(item.user.displayName)}
      <div class="request-info"><strong>${escapeHTML(item.user.displayName)}</strong><p>@${escapeHTML(item.user.username)} · ${escapeHTML(item.user.ourChatId)}</p></div>
      <div class="request-actions">
        ${incoming
          ? `<button class="primary-btn" data-accept="${item.id}">Accept</button><button class="secondary-btn" data-decline="${item.id}">Decline</button>`
          : `<button class="secondary-btn" data-cancel="${item.id}">Cancel</button>`}
      </div>
    </article>`;
  }

  function renderRequestsPage() {
    const incoming = state.requests.incoming;
    const outgoing = state.requests.outgoing;
    $('pageContent').innerHTML = `
      <div class="content-heading"><div><h2>Connection requests</h2><p>You choose who can start a private conversation with you.</p></div></div>
      <div class="request-columns">
        <section class="request-section"><h3>Received · ${incoming.length}</h3>
          ${incoming.length ? incoming.map((item) => requestCard(item, true)).join('') : '<div class="empty-state">No new requests. When someone finds your ID, their request will appear here.</div>'}
        </section>
        <section class="request-section"><h3>Sent · ${outgoing.length}</h3>
          ${outgoing.length ? outgoing.map((item) => requestCard(item, false)).join('') : '<div class="empty-state">Requests you send will appear here until they respond.</div>'}
        </section>
      </div>`;
    document.querySelectorAll('[data-accept]').forEach((button) => button.addEventListener('click', () => handleRequest(button.dataset.accept, 'accept')));
    document.querySelectorAll('[data-decline]').forEach((button) => button.addEventListener('click', () => handleRequest(button.dataset.decline, 'decline')));
    document.querySelectorAll('[data-cancel]').forEach((button) => button.addEventListener('click', () => handleRequest(button.dataset.cancel, 'cancel')));
  }

  async function handleRequest(id, action) {
    try {
      if (action === 'cancel') await api(`/api/requests/${id}`, { method: 'DELETE' });
      else await api(`/api/requests/${id}/${action}`, { method: 'POST' });
      await Promise.all([loadRequests(), loadConversations()]);
      renderPage();
      if (action === 'accept') toast('Request accepted. You can now chat.');
    } catch (error) { toast(error.message); }
  }

  function renderProfilePage() {
    const user = state.user;
    $('pageContent').innerHTML = `
      <div class="content-heading"><div><h2>Your Our Chat identity</h2><p>Share your unique ID with people you want to connect with.</p></div></div>
      <section class="profile-card">
        <div class="profile-head">${avatar(user.displayName)}<div><h2>${escapeHTML(user.displayName)}</h2><p>@${escapeHTML(user.username)}</p><div class="id-copy"><code>${escapeHTML(user.ourChatId)}</code><button id="copyIdBtn" type="button">Copy ID</button></div></div></div>
        <form class="profile-form" id="profileForm">
          <label>Display name<input name="displayName" maxlength="40" value="${escapeHTML(user.displayName)}" required></label>
          <label>Bio<textarea name="bio" maxlength="160" placeholder="A little about you…">${escapeHTML(user.bio || '')}</textarea></label>
          <p class="inline-note">Your Our Chat ID is permanent and cannot be changed. Your username is also reserved for your account.</p>
          <button class="primary-btn" type="submit">Save profile <span>✓</span></button>
        </form>
      </section>`;
    $('copyIdBtn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(user.ourChatId); toast('Our Chat ID copied.'); }
      catch { toast(`Your Our Chat ID is ${user.ourChatId}`); }
    });
    $('profileForm').addEventListener('submit', saveProfile);
  }

  async function saveProfile(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const data = await api('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: form.get('displayName'), bio: form.get('bio') })
      });
      state.user = data.user;
      showApp();
      toast('Profile updated.');
    } catch (error) { toast(error.message); }
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    state.socket?.disconnect();
    state.user = null;
    state.conversations = [];
    state.requests = { incoming: [], outgoing: [] };
    state.activeConversation = null;
    showAuth('login');
  }

  $('authSwitch').addEventListener('click', (event) => {
    if (event.target.id === 'showRegister') showAuth('register');
    if (event.target.id === 'showLogin') showAuth('login');
  });

  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    $('authError').textContent = '';
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identity: form.get('identity'), password: form.get('password') })
      });
      await startApp(data.user);
    } catch (error) { $('authError').textContent = error.message; }
    finally { button.disabled = false; }
  });

  $('registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    $('authError').textContent = '';
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          displayName: form.get('displayName'),
          username: form.get('username'),
          password: form.get('password')
        })
      });
      await startApp(data.user);
    } catch (error) { $('authError').textContent = error.message; }
    finally { button.disabled = false; }
  });

  $('logoutBtn').addEventListener('click', logout);
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => setPage(button.dataset.page));
  });

  async function startApp(user) {
    state.user = user;
    await Promise.all([loadConversations(), loadRequests()]);
    connectSocket();
    showApp();
  }

  async function init() {
    showAuth('login');
    try {
      const data = await api('/api/me');
      await startApp(data.user);
    } catch {
      // Not signed in yet.
    }
  }

  init();
})();
