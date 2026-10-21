const socket = io({
  autoConnect: false,
  auth: { token: "" }
});

const $ = id => document.getElementById(id);
const panels = ["auth-panel", "lobby-panel", "room-panel", "game-panel", "finish-panel"];
let token = "";
let me = null;
let saves = [];
let authMode = "login";
let currentRoom = null;
let myRole = null;
let noticeTimer = null;
let countdownTimer = null;
let touchStart = null;
let lastTouchMove = 0;
let heldTouch = false;
let tugReleased = false;

function showPanel(id) {
  panels.forEach(panel => $(panel).classList.toggle("hidden", panel !== id));
}
function notify(message) {
  const el = $("notice");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[ch]);
}
async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.message || "请求失败");
  return data;
}
function updateAuthMode(mode) {
  authMode = mode;
  $("login-tab").classList.toggle("active", mode === "login");
  $("register-tab").classList.toggle("active", mode === "register");
  $("auth-title").textContent = mode === "login" ? "欢迎回来，小可爱 💕" : "创建你的甜蜜账号 💌";
  $("auth-submit").textContent = mode === "login" ? "登录并开始" : "注册并开始";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
}
$("login-tab").addEventListener("click", () => updateAuthMode("login"));
$("register-tab").addEventListener("click", () => updateAuthMode("register"));

$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  const username = $("username").value.trim();
  const password = $("password").value;
  $("auth-submit").disabled = true;
  try {
    const result = await api(`/api/${authMode}`, {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    token = result.token;
    me = result.user;
    saves = result.saves || [];
    socket.auth = { token };
    socket.connect();
    renderProfile();
    showPanel("lobby-panel");
    notify(authMode === "login" ? "登录成功，欢迎回来！💗" : "注册成功，欢迎加入！💗");
  } catch (err) {
    notify(err.message);
  } finally {
    $("auth-submit").disabled = false;
  }
});

function renderProfile() {
  if (!me) return;
  $("profile-name").textContent = me.username;
  $("profile-level").textContent = me.max_level;
  $("profile-hearts").textContent = me.total_hearts;
  const labels = ["双人划船", "双人长按", "双人迷宫", "双人推箱子"];
  $("save-items").innerHTML = labels.map((label, index) => {
    const level = index + 1;
    const save = saves.find(item => Number(item.level_id) === level);
    const status = save?.status || (level === 1 ? "unlocked" : "locked");
    const text = status === "completed" ? "已通关 ✓" : status === "unlocked" ? "已解锁" : "未解锁";
    return `<div class="save-item ${status === "completed" ? "done" : ""}">
      <strong>${level}. ${label}</strong>${text}
    </div>`;
  }).join("");
}
function refreshProfile() {
  return api("/api/me").then(data => {
    me = data.user;
    saves = data.saves || [];
    renderProfile();
  }).catch(err => notify(err.message));
}
$("logout-btn").addEventListener("click", () => {
  token = "";
  me = null;
  saves = [];
  socket.disconnect();
  currentRoom = null;
  showPanel("auth-panel");
  notify("已退出登录");
});

$("pair-btn").addEventListener("click", () => {
  const username = $("partner-name").value.trim();
  if (!username) return notify("先输入另一半的用户名哦");
  socket.emit("pair-username", { username });
});
$("create-room-btn").addEventListener("click", () => socket.emit("create-room"));
$("join-room-btn").addEventListener("click", () => {
  const code = $("room-code-input").value.trim();
  if (!/^\d{6}$/.test(code)) return notify("房间号需要是 6 位数字");
  socket.emit("join-room", { code });
});
$("room-code-input").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
});
$("copy-code-btn").addEventListener("click", async () => {
  const code = $("room-code").textContent;
  try {
    await navigator.clipboard.writeText(code);
    notify("房间号复制成功 💌");
  } catch {
    notify("请手动复制房间号：" + code);
  }
});
$("start-game-btn").addEventListener("click", () => socket.emit("start-game"));
$("back-lobby-btn").addEventListener("click", () => {
  notify("房间会在玩家断开后清理，请刷新页面重新创建或加入");
  socket.disconnect();
  currentRoom = null;
  setTimeout(() => location.reload(), 500);
});
$("finish-lobby-btn").addEventListener("click", () => {
  currentRoom = null;
  showPanel("lobby-panel");
  refreshProfile();
});

socket.on("connect", () => {});
socket.on("connect_error", err => notify(err.message || "连接服务器失败"));
socket.on("action-error", message => notify(message));
socket.on("action-success", message => notify(message));
socket.on("my-role", data => {
  myRole = data.role;
  $("role-note").textContent = myRole === "A"
    ? "你是 A 玩家：负责【上 / 下】方向"
    : "你是 B 玩家：负责【左 / 右】方向";
});
socket.on("room-created", data => {
  $("room-code").textContent = data.code;
  notify("房间创建成功，邀请另一半加入吧！");
});
socket.on("room-state", room => {
  currentRoom = room;
  if (room.phase === "finished") {
    showPanel("finish-panel");
    $("finish-hearts").textContent = room.hearts;
    refreshProfile();
    return;
  }
  if (!room.started || room.phase === "lobby") {
    showPanel("room-panel");
    $("room-code").textContent = room.code;
    $("room-message").textContent = room.message;
    $("players").innerHTML = room.players.map((player, index) => `
      <div class="player">
        <div class="player-emoji">${index === 0 ? "🐰" : "🐻"}</div>
        <strong>${escapeHtml(player.username)}</strong>
        <small>${player.connected ? "🟢 已连接" : "🔴 已断开"} · 玩家 ${player.role}</small>
      </div>
    `).join("");
    if (room.players.length < 2) {
      $("players").innerHTML += `<div class="player"><div class="player-emoji">💌</div><strong>等待另一半</strong><small>分享房间号</small></div>`;
    }
    $("start-game-btn").disabled = room.players.length !== 2 || room.players.some(p => !p.connected);
    return;
  }
  showPanel("game-panel");
  renderGame(room);
});
socket.on("disconnect", () => {
  if (token) notify("实时连接已断开，请检查网络并重新登录");
});

function renderGame(room) {
  $("level-label").textContent = `第 ${room.level} / 4 关`;
  $("hearts-value").textContent = room.hearts;
  $("hearts-bar").style.width = Math.min(100, room.hearts / 70 * 100) + "%";
  $("game-message").textContent = room.message;
  const titles = ["", "双人划船 🚣", "双人长按 · 拔河 🪢", "双人迷宫 🕳️", "双人推箱子 🎁"];
  $("game-title").textContent = titles[room.level] || "合作闯关";
  const board = $("game-board");
  if (room.phase === "result" || room.phase === "saving" || room.phase === "error") {
    board.innerHTML = `<div class="swipe-area"><div><strong>💗</strong><span>${escapeHtml(room.message)}</span></div></div>`;
  } else if (room.level === 1) {
    renderSwipeBoard(board, room);
  } else if (room.level === 2) {
    renderTugBoard(board, room);
  } else if (room.level === 3) {
    renderMazeBoard(board, room);
  } else if (room.level === 4) {
    renderBoxBoard(board, room);
  }
  updateCountdown(room);
}

function renderSwipeBoard(board, room) {
  board.innerHTML = `
    <div class="swipe-area" id="swipe-area">
      <div><strong>🚣 💞 🚣</strong><span>在这里向任意方向滑动<br>两人要在 0.5 秒内同方向滑动</span></div>
    </div>
    <div class="tiny" style="text-align:center">服务器目标方向：${escapeHtml(room.targetDirection || "同步方向")}</div>`;
  const area = $("swipe-area");
  area.addEventListener("touchstart", event => {
    const t = event.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY, at: Date.now() };
  }, { passive: true });
  area.addEventListener("touchend", event => {
    if (!touchStart) return;
    const t = event.changedTouches[0];
    const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 25) return;
    const direction = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? "right" : "left")
      : (dy > 0 ? "down" : "up");
    socket.emit("row-swipe", { direction });
    area.innerHTML = `<div><strong>💗</strong><span>已发送滑动方向：${direction}<br>等待另一半同步……</span></div>`;
  }, { passive: true });
}

function renderTugBoard(board, room) {
  const phase = room.tug?.phase || "countdown";
  let label = "3 · 2 · 1";
  if (phase === "release") label = "松手！";
  board.innerHTML = `
    <button id="tug-pad" class="tug-pad" type="button">
      <div><strong>${label}</strong><span>${phase === "release" ? "现在松开屏幕！" : "按住屏幕，等待口令"}</span></div>
    </button>
    <p class="tiny" style="text-align:center">两人先按住；听到“松手”后同时松开</p>`;
  const pad = $("tug-pad");
  const down = event => {
    event.preventDefault();
    if (phase !== "countdown" || heldTouch) return;
    heldTouch = true;
    try { pad.setPointerCapture(event.pointerId); } catch {}
    socket.emit("tug-hold", { held: true });
    pad.querySelector("strong").textContent = "按住！";
  };
  const up = event => {
    if (!heldTouch) return;
    heldTouch = false;
    if (phase === "release" && !tugReleased) {
      tugReleased = true;
      socket.emit("tug-release");
      pad.querySelector("strong").textContent = "已松手";
    } else {
      socket.emit("tug-hold", { held: false });
    }
  };
  pad.addEventListener("pointerdown", down);
  pad.addEventListener("pointerup", up);
  pad.addEventListener("pointercancel", up);
  pad.addEventListener("lostpointercapture", up);
  if (phase === "release") {
    pad.querySelector("strong").textContent = "松手！";
    pad.querySelector("span").textContent = "现在松开屏幕！";
  }
  if (room.phase === "playing" && phase === "countdown") tugReleased = false;
}

function makeGrid(size, renderCell) {
  let html = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) html += renderCell(x, y);
  }
  return html;
}
function renderMazeBoard(board, room) {
  const maze = room.maze;
  if (!maze) return;
  const traps = new Set(maze.traps);
  board.innerHTML = `
    <div class="grid-board" style="grid-template-columns:repeat(9,1fr)">
      ${makeGrid(9, (x, y) => {
        let icon = "";
        if (x === maze.x && y === maze.y) icon = "🐣";
        else if (x === maze.goal.x && y === maze.goal.y) icon = "🏁";
        else if (traps.has(`${x},${y}`)) icon = "🕳️";
        return `<div class="cell ${traps.has(`${x},${y}`) ? "trap" : ""}">${icon}</div>`;
      })}
    </div>
    ${renderDirectionalPad(3, room.level)}
  `;
  bindDirectionButtons(board, "maze-move");
}
function renderBoxBoard(board, room) {
  const box = room.box;
  if (!box) return;
  const walls = new Set(box.walls);
  board.innerHTML = `
    <div class="grid-board" style="grid-template-columns:repeat(7,1fr)">
      ${makeGrid(7, (x, y) => {
        let icon = "";
        const wall = walls.has(`${x},${y}`);
        if (x === box.player.x && y === box.player.y) icon = "🐣";
        else if (x === box.crate.x && y === box.crate.y) icon = "🎁";
        else if (x === box.goal.x && y === box.goal.y) icon = "❤️";
        else if (wall) icon = "🧱";
        return `<div class="cell ${wall ? "wall" : ""}">${icon}</div>`;
      })}
    </div>
    ${renderDirectionalPad(3, room.level)}
  `;
  bindDirectionButtons(board, "box-move");
}
function renderDirectionalPad(size, level) {
  const directions = myRole === "A"
    ? [{ d:"up", icon:"⬆️" }, { d:"down", icon:"⬇️" }]
    : [{ d:"left", icon:"⬅️" }, { d:"right", icon:"➡️" }];
  return `<div class="touch-pad">
    <button class="touch-btn blank" tabindex="-1" aria-hidden="true"></button>
    ${directions.map(item => `<button class="touch-btn" data-dir="${item.d}">${item.icon}</button>`).join("")}
    <button class="touch-btn blank" tabindex="-1" aria-hidden="true"></button>
  </div>
  <p class="tiny" style="text-align:center">${myRole === "A" ? "你控制上下方向" : "你控制左右方向"} · 每次点击移动一步</p>`;
}
function bindDirectionButtons(board, eventName) {
  board.querySelectorAll("[data-dir]").forEach(button => {
    button.addEventListener("click", () => socket.emit(eventName, { direction: button.dataset.dir }));
  });
}
function updateCountdown(room) {
  clearInterval(countdownTimer);
  const tick = () => {
    if (!currentRoom || !currentRoom.deadline) {
      $("countdown").textContent = "-- 秒";
      $("countdown").classList.remove("urgent");
      return;
    }
    const seconds = Math.max(0, Math.ceil((currentRoom.deadline - Date.now()) / 1000));
    $("countdown").textContent = `${seconds} 秒`;
    $("countdown").classList.toggle("urgent", seconds <= 8);
  };
  tick();
  countdownTimer = setInterval(tick, 200);
}
window.addEventListener("beforeunload", () => clearInterval(countdownTimer));
