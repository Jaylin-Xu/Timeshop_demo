/* ===========================================================
   Time Shop 前端逻辑（账号 + 全站时间 + Online Lounge）
   Front-end logic for Time Shop
   -----------------------------------------------------------
   桌面端：窗口在前台 + 页面有焦点 + 鼠标在窗口内 才计时
   移动端：窗口在前台 + 页面可见 即计时（切走 App / tab 即暂停）
   -----------------------------------------------------------
   计时逻辑使用 setTimeout 实现递归调用：
   https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout

   如需更复杂会话管理，可结合 sessionStorage：
   https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage
   =========================================================== */

// ----------------- 基础常量 -----------------
const BASE_COINS = 2;
const COIN_INTERVAL = 120;
const COIN_LIFETIME = 3000;

// ----------------- 账号层状态 -----------------
let currentUser = null;
let currentPassword = null;
let loggedIn = false;

let state = {
  totalSeconds: 0,
  coinsSpent: 0,
  cards: [],
  coinsClaimed: 0,
  coinEventsTriggered: 0
};

// ----------------- DOM 引用 -----------------

const authOverlay   = document.getElementById('authOverlay');
const authUsername  = document.getElementById('authUsername');
const authPassword  = document.getElementById('authPassword');
const signupBtn     = document.getElementById('signupBtn');
const loginBtn      = document.getElementById('loginBtn');
const authMessageEl = document.getElementById('authMessage');

const usernameLabel      = document.getElementById('usernameLabel');
const usernameLabelSide  = document.getElementById('usernameLabel-side');
const coinLabel          = document.getElementById('coinLabel');
const sessionTimerEl     = document.getElementById('sessionTimer');
const globalTimerDisplay = document.getElementById('timerDisplay');

const drawBtn  = document.getElementById('drawBtn');
const resetBtn = document.getElementById('resetBtn');

const invGrid = document.getElementById('inventory');
const logBox  = document.getElementById('log');
const flipCard    = document.getElementById('flipCard');
const cardFront   = document.getElementById('cardFront');
const cardBackImg = document.getElementById('cardBack');

const coinSpawnBtn = document.getElementById('coinSpawnBtn');

const onlineUsersList = document.getElementById('onlineUsersList');
const hideCoinsToggle = document.getElementById('toggleHideCoins');

// ----------------- 活跃状态判定 -----------------

let hasFocus = document.hasFocus();
let pointerInside = true;

// 简单判定是否为触摸设备（近似为“移动端”）
const isTouchDevice =
  'ontouchstart' in window || navigator.maxTouchPoints > 0;

window.addEventListener('focus', () => {
  hasFocus = true;
});
window.addEventListener('blur', () => {
  hasFocus = false;
});

document.addEventListener('visibilitychange', () => {
  hasFocus = !document.hidden;
});

// 鼠标相关事件主要用于桌面端
document.addEventListener('mouseenter', () => {
  pointerInside = true;
});
document.addEventListener('mouseleave', () => {
  pointerInside = false;
});

/**
 * 是否处于“计时中”的状态
 * Desktop：需要 pointerInside；Mobile：只要 tab 可见且有焦点即可
 */
function isActiveForTimer() {
  if (!loggedIn || document.hidden || !hasFocus) return false;

  if (isTouchDevice) {
    // 移动端无法可靠监听鼠标离开；只要用户没有切走 App / tab，就认为仍在使用
    return true;
  }

  // 桌面端：要求鼠标仍在窗口内部，避免用户把页面留在后台挂时间
  return pointerInside;
}

// ----------------- 收集按钮与社交区设置 -----------------

let coinButtonVisible = false;
let coinButtonTimeoutId = null;

let hideCoinsInSocial = false;
if (hideCoinsToggle) {
  hideCoinsToggle.addEventListener('change', () => {
    hideCoinsInSocial = hideCoinsToggle.checked;
    sendPresence(true);
  });
}

// ----------------- Socket.io -----------------

let socket = null;
let globalSeconds = 0;

// ----------------- 工具函数 -----------------

function getAvailableCoins() {
  return BASE_COINS + (state.coinsClaimed || 0) - (state.coinsSpent || 0);
}

function fmtHMS(s) {
  s = Math.floor(s);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function log(msg) {
  const el = document.createElement('div');
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logBox.prepend(el);
}

function setAuthMessage(msg, isError = true) {
  if (!authMessageEl) return;
  authMessageEl.textContent = msg || '';
  authMessageEl.style.color = isError ? '#ef4444' : '#16a34a';
}

// ----------------- 网络请求 -----------------

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

async function signup(username, password) {
  return postJSON('/auth/signup', { username, password });
}
async function login(username, password) {
  return postJSON('/auth/login', { username, password });
}
async function syncState() {
  if (!loggedIn || !currentUser || !currentPassword) return;
  try {
    await postJSON('/api/state', {
      username: currentUser,
      password: currentPassword,
      state
    });
  } catch (err) {
    console.warn('syncState failed:', err.message);
  }
}

// ----------------- Online Lounge 渲染 -----------------

function renderOnlineUsers(users) {
  if (!onlineUsersList) return;
  onlineUsersList.innerHTML = '';

  if (!users || !users.length) {
    const empty = document.createElement('div');
    empty.className = 'online-user-empty';
    empty.textContent = 'No one is online yet. / 当前暂无在线用户。';
    onlineUsersList.appendChild(empty);
    return;
  }

  users.forEach((u) => {
    const item = document.createElement('div');
    item.className = 'online-user';
    if (u.username === currentUser) item.classList.add('self');

    const mainRow = document.createElement('div');
    mainRow.className = 'online-user-main';

    const nameEl = document.createElement('div');
    nameEl.className = 'online-user-name';
    nameEl.textContent = u.username;

    const coinsEl = document.createElement('div');
    coinsEl.className = 'online-user-coins';
    if (u.hideCoins) {
      coinsEl.textContent =
        u.username === currentUser
          ? 'Coins: hidden (you can still see yours above) / 已在社交区隐藏（你仍能在 Player 区看到自己的硬币）'
          : 'Coins: hidden / 硬币已隐藏';
    } else {
      coinsEl.textContent = `Coins: ${u.coins ?? 0}`;
    }

    mainRow.appendChild(nameEl);
    mainRow.appendChild(coinsEl);
    item.appendChild(mainRow);

    const cardsRow = document.createElement('div');
    cardsRow.className = 'online-user-cards';

    const cards = Array.isArray(u.lastCards) ? u.lastCards : [];
    if (!cards.length) {
      const none = document.createElement('span');
      none.className = 'online-card-pill';
      none.textContent = 'No cards yet / 暂无卡牌';
      cardsRow.appendChild(none);
    } else {
      const label = document.createElement('span');
      label.style.fontSize = '0.75rem';
      label.style.color = '#6b7280';
      label.textContent = 'Recent cards / 最近卡牌:';
      cardsRow.appendChild(label);

      const levels = document.createElement('span');
      levels.style.fontSize = '0.75rem';
      levels.style.marginLeft = '4px';
      levels.textContent = cards.join(', ');
      cardsRow.appendChild(levels);
    }

    item.appendChild(cardsRow);
    onlineUsersList.appendChild(item);
  });
}

// ----------------- 登录 / 注册 -----------------

async function handleAuth(action) {
  const username = authUsername.value.trim();
  const password = authPassword.value.trim();

  if (!username || !password) {
    setAuthMessage('Username and password are required. / 请输入用户名与密码。');
    return;
  }

  signupBtn.disabled = true;
  loginBtn.disabled = true;
  setAuthMessage(
    action === 'signup'
      ? 'Signing up… / 正在注册…'
      : 'Logging in… / 正在登录…',
    false
  );

  try {
    const data =
      action === 'signup'
        ? await signup(username, password)
        : await login(username, password);

    currentUser = data.username;
    currentPassword = password;
    state = data.state || {
      totalSeconds: 0,
      coinsSpent: 0,
      cards: [],
      coinsClaimed: 0,
      coinEventsTriggered: 0
    };
    loggedIn = true;

    authOverlay.style.display = 'none';
    renderInventory();
    renderStats();
    log(
      `Welcome, ${currentUser}! / 欢迎，${currentUser}！你的账号数据已载入。`
    );
    sendPresence(true);
    setAuthMessage(
      action === 'signup'
        ? 'Sign up successful. You are now logged in. / 注册成功，已自动登录。'
        : 'Login successful. / 登录成功。',
      false
    );
  } catch (err) {
    setAuthMessage(
      (err.message || 'Auth failed.') + ' / 登录或注册失败。',
      true
    );
  } finally {
    signupBtn.disabled = false;
    loginBtn.disabled = false;
  }
}

signupBtn.addEventListener('click', () => handleAuth('signup'));
loginBtn.addEventListener('click', () => handleAuth('login'));

// ----------------- Inventory 渲染 -----------------

function renderInventory() {
  invGrid.innerHTML = '';
  if (!state.cards || !state.cards.length) {
    const d = document.createElement('div');
    d.textContent = '— No cards yet / 暂无卡牌 —';
    d.style.opacity = '0.6';
    d.style.gridColumn = '1 / -1';
    invGrid.appendChild(d);
    return;
  }
  state.cards.forEach((c) => {
    const box = document.createElement('div');
    box.className = 'inv-item';

    const img = document.createElement('img');
    img.src = `./assets/cards/${c}.jpg`;

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = c === 'NONE' ? 'No Prize / 未中奖' : `Card ${c}`;

    box.appendChild(img);
    box.appendChild(label);
    invGrid.appendChild(box);
  });
}

// ----------------- Stats 渲染 -----------------

function renderStats() {
  const coins = getAvailableCoins();
  const lifetime = state.totalSeconds || 0;

  if (usernameLabel)     usernameLabel.textContent = currentUser || '—';
  if (usernameLabelSide) usernameLabelSide.textContent = currentUser || '—';
  if (coinLabel)         coinLabel.textContent = coins;
  if (sessionTimerEl)    sessionTimerEl.textContent = fmtHMS(lifetime);

  if (drawBtn) {
    drawBtn.disabled = !(loggedIn && coins >= 3);
  }
}

// ----------------- 收集硬币按钮逻辑 -----------------

function showCoinButton() {
  if (!coinSpawnBtn || coinButtonVisible || !loggedIn) return;

  coinButtonVisible = true;
  coinSpawnBtn.style.display = 'inline-flex';
  coinSpawnBtn.disabled = false;
  coinSpawnBtn.classList.add('coin-claim-visible');

  log(
    'A coin is ready! Click within 3 seconds to claim. / 有一枚硬币可以领取，请在 3 秒内点击按钮。'
  );

  coinButtonTimeoutId = setTimeout(() => {
    if (coinButtonVisible) {
      log(
        'You missed a coin (button expired). / 这次硬币已经消失，没有被领取。'
      );
      hideCoinButton();
    }
  }, COIN_LIFETIME);
}

function hideCoinButton() {
  if (!coinSpawnBtn) return;
  coinButtonVisible = false;
  coinSpawnBtn.disabled = true;
  coinSpawnBtn.classList.remove('coin-claim-visible', 'coin-claim-clicked');
  coinSpawnBtn.style.display = 'none';

  if (coinButtonTimeoutId) {
    clearTimeout(coinButtonTimeoutId);
    coinButtonTimeoutId = null;
  }
}

if (coinSpawnBtn) {
  coinSpawnBtn.addEventListener('click', () => {
    if (!coinButtonVisible || !loggedIn) return;

    coinSpawnBtn.classList.add('coin-claim-clicked');
    state.coinsClaimed = (state.coinsClaimed || 0) + 1;

    renderStats();
    log('You claimed +1 coin! / 你成功领取了 1 枚硬币。');
    syncState();
    sendPresence(true);

    if (coinButtonTimeoutId) {
      clearTimeout(coinButtonTimeoutId);
      coinButtonTimeoutId = null;
    }
    setTimeout(hideCoinButton, 180);
  });
}

function maybeSpawnCoinFromTime() {
  const total = state.totalSeconds || 0;
  const thresholdIndex = Math.floor(total / COIN_INTERVAL);

  if (thresholdIndex > (state.coinEventsTriggered || 0) && !coinButtonVisible) {
    state.coinEventsTriggered = thresholdIndex;
    showCoinButton();
    syncState();
    sendPresence(true);
  }
}

// ----------------- presence：在线状态 -----------------

let presenceTicks = 0;
let secondsSinceLastSync = 0;

function sendPresence(force = false) {
  if (!socket || !loggedIn || !currentUser) return;
  if (!force && presenceTicks < 5) return;

  presenceTicks = 0;
  socket.emit('presence:update', {
    username: currentUser,
    totalSeconds: state.totalSeconds || 0,
    coins: getAvailableCoins(),
    lastCards: (state.cards || []).slice(-3),
    hideCoins: hideCoinsInSocial
  });
}

// ----------------- 主计时 tick -----------------

function tick() {
  if (isActiveForTimer()) {
    state.totalSeconds = (state.totalSeconds || 0) + 1;

    secondsSinceLastSync += 1;
    presenceTicks += 1;

    if (secondsSinceLastSync >= 10) {
      syncState();
      secondsSinceLastSync = 0;
    }

    sendPresence(false);
  }

  renderStats();
  maybeSpawnCoinFromTime();

  setTimeout(tick, 1000);
}
tick();

// ----------------- 抽卡逻辑 -----------------

function drawResult() {
  const r = Math.random();
  if (r < 0.45) return 'NONE';
  else if (r < 0.67) return 'E';
  else if (r < 0.89) return 'F';
  else if (r < 0.92) return 'B';
  else if (r < 0.95) return 'C';
  else if (r < 0.98) return 'D';
  else if (r < 0.998) return 'A';
  return 'S';
}

function flipToCard(result) {
  flipCard.classList.remove('flipped');
  cardFront.src = './assets/cards/back.jpg';

  setTimeout(() => {
    cardBackImg.src = `./assets/cards/${result}.jpg`;
    flipCard.classList.add('flipped');

    setTimeout(() => {
      flipCard.classList.remove('flipped');
      cardFront.src = './assets/cards/back.jpg';
      cardBackImg.src = './assets/cards/back.jpg';
    }, 3000);
  }, 20);
}

drawBtn.addEventListener('click', () => {
  if (!loggedIn) {
    alert('Please log in first. / 请先登录账号。');
    return;
  }

  const coins = getAvailableCoins();
  if (coins < 3) {
    alert('Not enough coins! / 当前硬币不足 3 枚。');
    return;
  }

  state.coinsSpent = (state.coinsSpent || 0) + 3;
  if (!state.cards) state.cards = [];

  const result = drawResult();
  state.cards.push(result);

  renderInventory();
  renderStats();
  flipToCard(result);
  syncState();
  sendPresence(true);

  log(
    `You drew: ${
      result === 'NONE' ? 'No Prize' : 'Card ' + result
    } / 抽到结果：${result === 'NONE' ? '未中奖' : '卡牌 ' + result}。`
  );
});

// ----------------- Reset -----------------

resetBtn.addEventListener('click', () => {
  if (!loggedIn) {
    alert('Please log in first. / 请先登录账号。');
    return;
  }
  if (
    !confirm(
      'Reset all data for this account? / 是否重置当前账号的所有数据？（账号本身不会被删除）'
    )
  ) {
    return;
  }

  hideCoinButton();

  state = {
    totalSeconds: 0,
    coinsSpent: 0,
    cards: [],
    coinsClaimed: 0,
    coinEventsTriggered: 0
  };

  renderInventory();
  renderStats();
  flipCard.classList.remove('flipped');
  cardFront.src = './assets/cards/back.jpg';

  syncState();
  sendPresence(true);
  log('Account data has been reset. / 当前账号的数据已清零。');
});

// ----------------- totalTime + Online Lounge（socket.io） -----------------

if (typeof io !== 'undefined') {
  socket = io();

  socket.on('totalTime', (t) => {
    globalSeconds = Number(t) || 0;
    if (globalTimerDisplay) {
      globalTimerDisplay.textContent = fmtHMS(globalSeconds);
    }
  });

  socket.on('onlineUsers', (users) => {
    renderOnlineUsers(users || []);
  });

  function globalTick() {
    if (globalTimerDisplay && isActiveForTimer()) {
      globalSeconds += 1;
      globalTimerDisplay.textContent = fmtHMS(globalSeconds);
    }
    setTimeout(globalTick, 1000);
  }
  setTimeout(globalTick, 1000);
}

// ----------------- 初始化 -----------------

renderInventory();
renderStats();
if (cardFront) {
  cardFront.src = './assets/cards/back.jpg';
}
