const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const AVATARS = ['😀','😎','🤠','🥳','😈','👻','🤖','🦊','🐼','🐸','🦄','🐯'];
const LEVELS = {
  beginner: { name: 'BEGINNER', sub: 'Soft Zone 😊😁', cls: 'l1' },
  advanced: { name: 'ADVANCED', sub: 'Chill Zone 🥵💃', cls: 'l2' },
  hard:     { name: 'HARD',     sub: 'Hot and Spicy 💋😘👅', cls: 'l3' },
};
const levelOf = (cat) => LEVELS[cat] || LEVELS.beginner;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let me = null, room = null, players = [];
let channel = null, pollTimer = null, beatTimer = null, refreshTimer = null;
let lastGameKey = '';
let levelCounts = null; // how many built-in questions each level has
let avatar = localStorage.getItem('avatar') || AVATARS[0];
let mode = localStorage.getItem('mode') === 'sequential' ? 'sequential' : 'random';

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

// only touch the page when the content really changed (keeps things smooth)
function setHtml(el, html) {
  if (el._h === html) return false;
  el.innerHTML = html;
  el._h = html;
  return true;
}

function paintMode() {
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('sel', b.dataset.mode === mode));
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
  paintMode();

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
  localStorage.setItem('mode', mode);
  const { data, error } = await sb.rpc('create_room', { p_nickname: nick, p_avatar: avatar, p_mode: mode });
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
  lastGameKey = '';
  show('room');
  await refresh();
  loadLevelCounts();
  subscribe();
  beat();
  beatTimer = setInterval(beat, 30000);
  pollTimer = setInterval(refresh, 6000);
}

// ---------- LIVE DATA ----------
function subscribe() {
  const queue = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); };
  channel = sb.channel('room-' + room.id);
  for (const table of ['rooms', 'players']) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, queue);
  }
  channel.subscribe();
}

async function refresh() {
  if (!room) return;
  const [r, p] = await Promise.all([
    sb.from('rooms').select('*').eq('id', room.id).maybeSingle(),
    sb.from('players').select('*').eq('room_id', room.id).order('joined_at'),
  ]);
  if (r.error || p.error) return; // network hiccup, try again later
  if (!r.data) return leave(true, 'This room is no longer available');
  if (!p.data.some((x) => x.user_id === me.id)) return leave(true, 'You are no longer in this room');
  room = r.data; players = p.data;
  render();
}

function beat() {
  if (!room) return;
  sb.from('players').update({ last_seen: new Date().toISOString() })
    .eq('room_id', room.id).eq('user_id', me.id).then(() => {});
}

// ---------- SCREEN ----------
async function loadLevelCounts() {
  const { data, error } = await sb.from('questions').select('category').is('room_id', null).limit(2000);
  if (error) return;
  levelCounts = {};
  data.forEach((q) => { levelCounts[q.category] = (levelCounts[q.category] || 0) + 1; });
  if (room) render();
}

function levelButtons() {
  return Object.entries(LEVELS).map(([key, l]) => {
    const empty = levelCounts && !levelCounts[key];
    return `<button class="level ${l.cls} ${room.category === key ? 'sel' : ''}" data-level="${key}" ${empty ? 'disabled' : ''}>
       <b>${l.name}</b><span>${l.sub}${empty ? ' · 🔒 Coming soon' : ''}</span></button>`;
  }).join('');
}

function render() {
  const isHost = room.host_id === me.id;
  const lv = levelOf(room.category);
  const cur = players.find((p) => p.id === room.current_player_id);
  const isCur = !!cur && cur.user_id === me.id;
  const canAct = isHost || isCur;
  const modeLabel = room.mode === 'sequential' ? '🔁 In order' : '🎲 Random';

  $('roomCode').textContent = room.code;
  const badge = $('levelBadge');
  badge.className = 'lvlbadge ' + lv.cls;
  badge.textContent = `${lv.name} - ${lv.sub}`;

  // ----- main game panel -----
  let html;
  if (room.status === 'lobby') {
    html = `<div class="bigav">🎉</div><div class="who">Lobby</div>
      <p class="muted">${players.length} player${players.length === 1 ? '' : 's'} in the room<br>
      Mode: ${modeLabel}<br>Share the code or invite link with your friends.</p>` +
      (isHost ? `<button data-act="start" class="primary">▶ Start game</button>`
              : `<p class="muted">Waiting for the host to start...</p>`);
  } else if (!cur) {
    html = `<div class="bigav">🎲</div><div class="who">Ready for the next turn</div>` +
      (isHost ? `<button data-act="turn" class="primary">▶ Start next turn</button>`
              : `<p class="muted">Waiting for the host...</p>`);
  } else if (!room.current_prompt) {
    html = `<div class="bigav">${esc(cur.avatar)}</div>
      <div class="who">${isCur ? `Your turn, ${esc(cur.nickname)}!` : `${esc(cur.nickname)}'s turn`}</div>` +
      (canAct
        ? `<p class="muted">${isCur ? 'Truth or dare?' : 'Wait for them to choose, or choose for them:'}</p>
           <div class="row"><button data-act="pick-truth" class="primary">Truth</button>
           <button data-act="pick-dare" class="primary">Dare</button></div>
           <button data-act="skip" class="ghost">⏭ Skip this turn</button>`
        : `<p class="muted">Waiting for ${esc(cur.nickname)} to choose...</p>`);
  } else {
    html = `<div class="bigav">${esc(cur.avatar)}</div>
      <div class="who">${esc(cur.nickname)}${isCur ? ' (you)' : ''}</div>
      <div><span class="badge ${room.current_type}">${room.current_type.toUpperCase()}</span></div>
      <div class="prompt">${esc(room.current_prompt)}</div>` +
      (canAct
        ? `<div class="row"><button data-act="done" class="good">✅ Done · next</button>
           <button data-act="skip" class="bad">⏭ Skip</button></div>
           <button data-act="reroll" class="ghost">🔄 Different question</button>`
        : `<p class="muted">Waiting for ${esc(cur.nickname)} to finish...</p>`);
  }
  const box = $('gameBox');
  box.className = 'card game ' + lv.cls;
  const changed = setHtml(box, `<div class="inner">${html}</div>`);
  const key = [room.status, room.current_player_id, room.current_prompt].join('|');
  if (changed && key !== lastGameKey) box.firstElementChild.classList.add('pop');
  lastGameKey = key;

  // ----- host controls -----
  const hb = $('hostBox');
  hb.classList.toggle('hidden', !isHost);
  if (isHost) {
    setHtml(hb, `<h2>👑 Host controls</h2>
      <div class="levels-title">LEVELS</div>
      <div class="levels">${levelButtons()}</div>
      <p class="small">Mode: ${modeLabel}</p>` +
      (room.status === 'playing' ? `<button data-act="end" class="ghost">⏹ Back to lobby</button>` : ''));
  }

  // ----- players -----
  setHtml($('playersBox'), players.map((p) => {
    const online = Date.now() - new Date(p.last_seen).getTime() < 90000;
    const turn = p.id === room.current_player_id;
    return `<div class="player ${turn ? 'turn ' + lv.cls : ''}">
      <span class="dot ${online ? 'on' : ''}"></span>
      <span class="pav">${esc(p.avatar)}</span>
      <span class="pname">${esc(p.nickname)}
        <span class="tag">${p.user_id === room.host_id ? '👑 host ' : ''}${p.user_id === me.id ? '(you)' : ''}</span></span>
      ${turn ? '<span class="tag">🎯 turn</span>' : ''}
      ${isHost && p.user_id !== me.id ? `<button class="kick" data-act="kick" data-id="${p.id}">✕</button>` : ''}
    </div>`;
  }).join(''));
}

// ---------- ACTIONS ----------
async function updateRoom(fields) {
  const { error } = await sb.from('rooms').update(fields).eq('id', room.id);
  if (error) throw error;
  await refresh();
}

async function call(name, args) {
  const { error } = await sb.rpc(name, { p_room_id: room.id, ...args });
  if (error) throw error;
  await refresh();
}

async function act(a, el) {
  try {
    if (a === 'start') { await updateRoom({ status: 'playing' }); await call('next_turn', {}); }
    else if (a === 'turn') await call('next_turn', {});
    else if (a === 'pick-truth') await call('choose_prompt', { p_type: 'truth' });
    else if (a === 'pick-dare') await call('choose_prompt', { p_type: 'dare' });
    else if (a === 'reroll') await call('choose_prompt', { p_type: room.current_type });
    else if (a === 'done') await call('next_turn', { p_result: 'completed' });
    else if (a === 'skip') await call('next_turn', { p_result: 'skipped' });
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
  channel = null; room = null; players = [];
  ['gameBox', 'hostBox', 'playersBox'].forEach((id) => { $(id)._h = null; });
  localStorage.removeItem('lastRoom');
  $('btnRejoin').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
  show('home');
  if (msg) toast(msg);
}

// ---------- EVENTS ----------
document.addEventListener('click', (e) => {
  const av = e.target.closest('[data-av]');
  if (av) {
    avatar = av.dataset.av;
    document.querySelectorAll('.av').forEach((b) => b.classList.toggle('sel', b === av));
    return;
  }
  const md = e.target.closest('[data-mode]');
  if (md) { mode = md.dataset.mode; paintMode(); return; }
  const lvl = e.target.closest('[data-level]');
  if (lvl) { updateRoom({ category: lvl.dataset.level }).catch((x) => toast(x.message)); return; }
  const btn = e.target.closest('[data-act]');
  if (btn) act(btn.dataset.act, btn);
});
$('btnCreate').addEventListener('click', createRoom);
$('btnJoin').addEventListener('click', () => joinRoom());
$('btnRejoin').addEventListener('click', () => joinRoom(localStorage.getItem('lastRoom')));

init();
