const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const AVATARS = ['😀','😎','🤠','🥳','😈','👻','🤖','🦊','🐼','🐸','🦄','🐯'];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

let me = null, room = null, players = [], sessions = [];
let channel = null, pollTimer = null, beatTimer = null, refreshTimer = null;
let avatar = localStorage.getItem('avatar') || AVATARS[0];

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3000);
}

function show(view) {
  $('home').classList.toggle('hidden', view !== 'home');
  $('room').classList.toggle('hidden', view !== 'room');
}

// ---------- START ----------
async function init() {
  if (SUPABASE_URL.startsWith('PASTE') || SUPABASE_KEY.startsWith('PASTE')) {
    toast('Open config.js and paste your Supabase URL and key.');
    return;
  }
  let { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) { toast('Could not start guest login: ' + error.message); return; }
    session = data.session;
  }
  me = session.user;

  $('avatars').innerHTML = AVATARS.map((a) =>
    `<button type="button" class="av ${a === avatar ? 'sel' : ''}" data-av="${a}">${a}</button>`).join('');
  $('nick').value = localStorage.getItem('nick') || '';

  const linkCode = new URLSearchParams(location.search).get('room');
  if (linkCode) $('code').value = linkCode.toUpperCase().slice(0, 6);

  const last = localStorage.getItem('lastRoom');
  if (last) {
    $('btnRejoin').textContent = '↩ Rejoin room ' + last;
    $('btnRejoin').classList.remove('hidden');
  }
  show('home');
}

function profile() {
  const nick = $('nick').value.trim();
  if (!nick) { toast('Type a nickname first'); $('nick').focus(); return null; }
  localStorage.setItem('nick', nick);
  localStorage.setItem('avatar', avatar);
  return nick;
}

async function createRoom() {
  const nick = profile(); if (!nick) return;
  const { data, error } = await sb.rpc('create_room', { p_nickname: nick, p_avatar: avatar });
  if (error) return toast(error.message);
  await enterRoom(data.code);
}

async function joinRoom(codeArg) {
  const nick = profile(); if (!nick) return;
  const code = (codeArg || $('code').value).trim().toUpperCase();
  if (code.length < 4) return toast('Enter the room code');
  const { data, error } = await sb.rpc('join_room', { p_code: code, p_nickname: nick, p_avatar: avatar });
  if (error) return toast(error.message);
  await enterRoom(data.code);
}

async function enterRoom(code) {
  localStorage.setItem('lastRoom', code);
  history.replaceState(null, '', location.pathname + '?room=' + code);
  const { data, error } = await sb.from('rooms').select('*').eq('code', code).maybeSingle();
  if (error || !data) return toast('Could not open the room');
  room = data;
  show('room');
  await refresh();
  subscribe();
  beat();
  beatTimer = setInterval(beat, 30000);
  pollTimer = setInterval(refresh, 6000);
}

// ---------- LIVE DATA ----------
function subscribe() {
  const queue = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); };
  channel = sb.channel('room-' + room.id);
  for (const table of ['rooms', 'players', 'game_sessions', 'questions']) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, queue);
  }
  channel.subscribe();
}

async function refresh() {
  if (!room) return;
  const [r, p, s] = await Promise.all([
    sb.from('rooms').select('*').eq('id', room.id).maybeSingle(),
    sb.from('players').select('*').eq('room_id', room.id).order('joined_at'),
    sb.from('game_sessions').select('*').eq('room_id', room.id)
      .order('created_at', { ascending: false }).limit(100),
  ]);
  if (r.error || p.error) return; // network hiccup, try again later
  if (!r.data) return leave(true, 'This room is no longer available');
  if (!p.data.some((x) => x.user_id === me.id)) return leave(true, 'You are no longer in this room');
  room = r.data; players = p.data; sessions = s.data || [];
  render();
}

function beat() {
  if (!room) return;
  sb.from('players').update({ last_seen: new Date().toISOString() })
    .eq('room_id', room.id).eq('user_id', me.id).then(() => {});
}

// ---------- SCREEN ----------
function render() {
  const isHost = room.host_id === me.id;
  $('roomCode').textContent = room.code;
  const cur = players.find((p) => p.id === room.current_player_id);
  const box = $('gameBox');

  if (room.status === 'lobby') {
    box.innerHTML = `<div class="bigav">🎉</div><div class="who">Lobby</div>
      <p class="muted">${players.length} player${players.length === 1 ? '' : 's'} in the room.<br>
      Share the code or invite link with your friends.</p>` +
      (isHost ? `<button data-act="start" class="primary">▶ Start game</button>`
              : `<p class="muted">Waiting for the host to start...</p>`);
  } else if (!cur) {
    box.innerHTML = `<div class="bigav">🎲</div><div class="who">Ready for the next turn</div>` +
      (isHost ? `<button data-act="spin" class="primary">🎲 Pick a random player</button>`
              : `<p class="muted">Waiting for the host to spin...</p>`);
  } else if (!room.current_prompt) {
    const you = cur.user_id === me.id;
    box.innerHTML = `<div class="bigav">${esc(cur.avatar)}</div>
      <div class="who">${esc(cur.nickname)}${you ? ' (you)' : ''}, truth or dare?</div>` +
      (isHost ? `<p class="muted">Tap what they choose:</p>
        <div class="row"><button data-act="pick-truth" class="primary">Truth</button>
        <button data-act="pick-dare" class="primary">Dare</button></div>`
              : `<p class="muted">${you ? 'Tell the host your choice!' : 'Waiting for their choice...'}</p>`);
  } else {
    box.innerHTML = `<div class="bigav">${esc(cur.avatar)}</div>
      <div class="who">${esc(cur.nickname)}${cur.user_id === me.id ? ' (you)' : ''}</div>
      <div><span class="badge ${room.current_type}">${room.current_type.toUpperCase()}</span></div>
      <div class="prompt">${esc(room.current_prompt)}</div>` +
      (isHost ? `<div class="row"><button data-act="done" class="good">✅ Done +1</button>
        <button data-act="skip" class="bad">⏭ Skip</button></div>
        <button data-act="reroll" class="ghost">🔄 Different question</button>`
              : `<p class="muted">The host will mark it done or skipped.</p>`);
  }

  const hb = $('hostBox');
  hb.classList.toggle('hidden', !isHost);
  if (isHost) {
    hb.innerHTML = `<h2>👑 Host controls</h2>
      <label for="catSel">Question category</label>
      <select id="catSel">
        ${['mixed', 'mild', 'spicy'].map((c) =>
          `<option value="${c}" ${room.category === c ? 'selected' : ''}>${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}
      </select>` +
      (room.status === 'playing' ? `<button data-act="end" class="ghost">⏹ Back to lobby</button>` : '');
  }

  const sorted = [...players].sort((a, b) => b.score - a.score || a.joined_at.localeCompare(b.joined_at));
  $('scoreBox').innerHTML = sorted.map((p) => {
    const online = Date.now() - new Date(p.last_seen).getTime() < 90000;
    return `<div class="player ${p.id === room.current_player_id ? 'turn' : ''}">
      <span class="dot ${online ? 'on' : ''}"></span>
      <span class="pav">${esc(p.avatar)}</span>
      <span class="pname">${esc(p.nickname)}
        <span class="tag">${p.user_id === room.host_id ? '👑 host ' : ''}${p.user_id === me.id ? '(you)' : ''}</span></span>
      <span class="pts">${p.score}</span>
      ${isHost && p.user_id !== me.id ? `<button class="kick" data-act="kick" data-id="${p.id}">✕</button>` : ''}
    </div>`;
  }).join('');
}

// ---------- ACTIONS ----------
async function updateRoom(fields) {
  const { error } = await sb.from('rooms').update(fields).eq('id', room.id);
  if (error) throw error;
  await refresh();
}

async function pickPrompt(type) {
  const { data, error } = await sb.from('questions').select('text,category,room_id').eq('type', type);
  if (error) throw error;
  let pool = data.filter((q) => q.room_id === null || q.room_id === room.id);
  if (room.category !== 'mixed') {
    pool = pool.filter((q) => q.room_id !== null || q.category === room.category);
  }
  const used = new Set(sessions.map((s) => s.prompt));
  const fresh = pool.filter((q) => !used.has(q.text));
  const choice = rand(fresh.length ? fresh : pool);
  if (!choice) throw new Error('No questions found for this category');
  await updateRoom({ current_type: type, current_prompt: choice.text });
}

async function spin() {
  const counts = {};
  players.forEach((p) => (counts[p.id] = 0));
  sessions.forEach((s) => { if (s.player_id in counts) counts[s.player_id]++; });
  const min = Math.min(...Object.values(counts));
  let pool = players.filter((p) => counts[p.id] === min);
  const last = sessions[0] && sessions[0].player_id;
  if (pool.length > 1) pool = pool.filter((p) => p.id !== last);
  await updateRoom({ current_player_id: rand(pool).id, current_type: null, current_prompt: null });
}

async function finish(result) {
  const { error } = await sb.rpc('finish_turn', { p_room_id: room.id, p_result: result });
  if (error) throw error;
  await refresh();
}

async function act(a, el) {
  try {
    if (a === 'start') await updateRoom({ status: 'playing' });
    else if (a === 'spin') await spin();
    else if (a === 'pick-truth') await pickPrompt('truth');
    else if (a === 'pick-dare') await pickPrompt('dare');
    else if (a === 'reroll') await pickPrompt(room.current_type);
    else if (a === 'done') await finish('completed');
    else if (a === 'skip') await finish('skipped');
    else if (a === 'end') await updateRoom({ status: 'lobby', current_player_id: null, current_type: null, current_prompt: null });
    else if (a === 'kick') {
      const { error } = await sb.from('players').delete().eq('id', el.dataset.id);
      if (error) throw error;
      await refresh();
    }
    else if (a === 'copy') { await navigator.clipboard.writeText(room.code); toast('Code copied: ' + room.code); }
    else if (a === 'share') {
      const link = location.origin + location.pathname + '?room=' + room.code;
      if (navigator.share) await navigator.share({ title: 'Truth or Dare', text: 'Join my Truth or Dare room!', url: link });
      else { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
    }
    else if (a === 'leave') await leave(false);
  } catch (e) {
    if (e && e.name === 'AbortError') return; // share sheet closed
    toast(e.message || 'Something went wrong');
  }
}

async function leave(silent, msg) {
  if (room && !silent) {
    await sb.from('players').delete().eq('room_id', room.id).eq('user_id', me.id);
  }
  if (channel) sb.removeChannel(channel);
  clearInterval(pollTimer); clearInterval(beatTimer); clearTimeout(refreshTimer);
  channel = null; room = null; players = []; sessions = [];
  localStorage.removeItem('lastRoom');
  $('btnRejoin').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
  show('home');
  if (msg) toast(msg);
}

async function addQuestion() {
  const text = $('cqText').value.trim();
  if (text.length < 3) return toast('Write at least 3 letters');
  const { error } = await sb.from('questions').insert({
    room_id: room.id, type: $('cqType').value, category: 'custom', text, created_by: me.id,
  });
  if (error) return toast(error.message);
  $('cqText').value = '';
  toast('Question added!');
}

// ---------- EVENTS ----------
document.addEventListener('click', (e) => {
  const av = e.target.closest('[data-av]');
  if (av) {
    avatar = av.dataset.av;
    document.querySelectorAll('.av').forEach((b) => b.classList.toggle('sel', b === av));
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (btn) act(btn.dataset.act, btn);
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'catSel') updateRoom({ category: e.target.value }).catch((x) => toast(x.message));
});
$('btnCreate').addEventListener('click', createRoom);
$('btnJoin').addEventListener('click', () => joinRoom());
$('btnRejoin').addEventListener('click', () => joinRoom(localStorage.getItem('lastRoom')));
$('btnAddQ').addEventListener('click', addQuestion);

init();
