
const socket = io();

const $ = id => document.getElementById(id);

const screens = [
  "home-screen",
  "waiting-screen",
  "game-screen",
  "finish-screen"
];

let currentState = null;
let selectedAnswer = null;
let toastTimer = null;
let timerInterval = null;
let myName = "";
let hasSubmitted = false;
let hasClickedHeart = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function showScreen(screenId) {
  screens.forEach(id => $(id).classList.toggle("hidden", id !== screenId));
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function setBusy(busy) {
  $("create-btn").disabled = busy;
  $("join-btn").disabled = busy;
}

function playerName() {
  return ($("player-name").value.trim() || "小可爱").slice(0, 12);
}

function createRoom() {
  myName = playerName();
  setBusy(true);

  socket.emit("create-room", { name: myName }, result => {
    setBusy(false);

    if (!result || !result.ok) {
      toast(result?.message || "创建失败，请重试");
      return;
    }

    toast("房间创建成功！快邀请另一半吧 💕");
  });
}

function joinRoom() {
  myName = playerName();
  const code = $("room-code").value.trim().toUpperCase();

  if (!code) {
    toast("请先输入房间号哦 💌");
    return;
  }

  setBusy(true);

  socket.emit("join-room", { code, name: myName }, result => {
    setBusy(false);

    if (!result || !result.ok) {
      toast(result?.message || "加入失败，请重试");
      return;
    }

    toast("成功加入甜蜜房间！💕");
  });
}

function renderWaiting(state) {
  showScreen("waiting-screen");

  $("room-code-display").textContent = state.code || "------";

  const avatars = ["🐰", "🐻"];

  $("player-list").innerHTML = state.players.map((player, index) => `
    <div class="player-card">
      <div class="avatar">${avatars[index]}</div>
      <strong>${escapeHtml(player.name)}</strong>
      <small>${player.connected ? "💚 已连接" : "💔 已断开"}</small>
    </div>
  `).join("");

  if (state.players.length < 2) {
    $("player-list").innerHTML += `
      <div class="player-card">
        <div class="avatar">💌</div>
        <strong>等待另一半</strong>
        <small>分享房间号即可加入</small>
      </div>
    `;
  }

  const ready = state.players.length === 2 &&
    state.players.every(player => player.connected);

  $("start-btn").disabled = !ready;
  $("waiting-message").textContent = ready
    ? "两位小可爱已经到齐，可以开始啦！💗"
    : state.message || "正在等待另一半加入……";
}

function renderSteps(level) {
  for (let i = 1; i <= 3; i++) {
    const step = $("step-" + i);
    step.classList.toggle("active", i === level);
    step.classList.toggle("done", i < level);
  }
}

function renderGame(state) {
  showScreen("game-screen");

  $("level-badge").textContent = `第 ${state.level} / 3 关`;
  $("heart-score").textContent = state.hearts;
  $("heart-progress").style.width =
    Math.min(100, state.hearts / 45 * 100) + "%";

  renderSteps(state.level);

  const content = $("game-content");

  if (state.phase === "result") {
    content.innerHTML = `
      <div class="section-icon">💞</div>
      <h2>默契挑战</h2>
      <p class="game-message">${escapeHtml(state.message)}</p>
      <p class="muted">请稍等，马上继续冒险……</p>
    `;
    $("team-status-title").textContent = "双人合作中";
    $("team-status-text").textContent = "下一次一定会更默契！";
    return;
  }

  if (state.phase === "answering" && state.level === 1) {
    content.innerHTML = `
      <div class="level-title">💞 第一关 · 心有灵犀</div>
      <h2 class="level-question">${escapeHtml(state.question)}</h2>
      <div class="option-grid">
        ${state.options.map((option, index) => `
          <button class="option-btn ${
            selectedAnswer === String(index) ? "selected" : ""
          }" data-answer="${index}"
            ${hasSubmitted ? "disabled" : ""}>
            ${escapeHtml(option)}
          </button>
        `).join("")}
      </div>
      <p class="game-message">${escapeHtml(state.message)}</p>
    `;
  } else if (state.phase === "answering" && state.level === 2) {
    const target = state.directions.find(
      item => item.id === state.targetDirection
    );

    content.innerHTML = `
      <div class="level-title">🧩 第二关 · 默契方向</div>
      <h2 class="level-question">跟着指令一起选择！</h2>
      <div class="target-hint">
        目标方向：${target ? target.emoji + " " + target.label : ""}
      </div>
      <div class="direction-grid">
        ${state.directions.map(item => `
          <button class="direction-btn ${
            selectedAnswer === item.id ? "selected" : ""
          }" data-answer="${item.id}"
            ${hasSubmitted ? "disabled" : ""}>
            ${item.emoji}<span>${item.label}</span>
          </button>
        `).join("")}
      </div>
      <p class="game-message">${escapeHtml(state.message)}</p>
    `;
  } else if (state.level === 3) {
    const active = state.phase === "heart-active";

    content.innerHTML = `
      <div class="level-title">💓 第三关 · 同频点击</div>
      <h2 class="level-question">
        ${active ? "现在！和另一半一起点击！" : "集中注意力，等待爱心亮起！"}
      </h2>
      <div class="big-heart-wrap">
        <button id="big-heart" class="big-heart ${
          active ? "active" : ""
        } ${hasClickedHeart ? "pressed" : ""}"
          ${!active || hasClickedHeart ? "disabled" : ""}
          aria-label="点击爱心">
          ${active ? "❤️" : "🤍"}
        </button>
      </div>
      <p class="game-message">${escapeHtml(state.message)}</p>
      <p class="muted">两次有效点击间隔需不超过 500 毫秒</p>
    `;
  }

  $("team-status-title").textContent = "双人合作中 💗";
  $("team-status-text").textContent =
    hasSubmitted || hasClickedHeart
      ? "你已行动，等待另一半！"
      : "两个人一起努力！";
}

function updateTimer() {
  const el = $("timer");

  if (!currentState || !currentState.deadline) {
    el.textContent = "-- 秒";
    el.classList.remove("urgent");
    return;
  }

  const remaining = Math.max(
    0,
    Math.ceil((currentState.deadline - Date.now()) / 1000)
  );

  el.textContent = remaining + " 秒";
  el.classList.toggle("urgent", remaining <= 8);
}

function renderState(state) {
  const previousLevel = currentState?.level;
  const previousPhase = currentState?.phase;

  currentState = state;

  if (previousLevel !== state.level || previousPhase !== state.phase) {
    selectedAnswer = null;
    hasSubmitted = false;
    hasClickedHeart = false;
  }

  if (state.phase === "waiting" || !state.started) {
    renderWaiting(state);
  } else if (state.phase === "finished") {
    showScreen("finish-screen");
    $("heart-score").textContent = state.hearts;
  } else {
    renderGame(state);
  }

  updateTimer();
}

socket.on("connect", () => {
  toast("连接成功！欢迎来到甜蜜冒险 💕");
});

socket.on("disconnect", () => {
  toast("连接中断，请检查网络并刷新页面");
});

socket.on("connect_error", () => {
  toast("连接服务器失败，请稍后重试");
});

socket.on("game-state", state => {
  renderState(state);
});

$("create-btn").addEventListener("click", createRoom);
$("join-btn").addEventListener("click", joinRoom);

$("room-code").addEventListener("input", event => {
  event.target.value = event.target.value
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 6);
});

$("start-btn").addEventListener("click", () => {
  socket.emit("start-game");
});

$("copy-btn").addEventListener("click", async () => {
  const code = $("room-code-display").textContent;

  try {
    await navigator.clipboard.writeText(code);
    toast("房间号复制成功！快发给另一半 💌");
  } catch {
    toast("请手动复制房间号：" + code);
  }
});

$("leave-btn").addEventListener("click", () => {
  location.reload();
});

$("home-btn").addEventListener("click", () => {
  location.reload();
});

$("play-again-btn").addEventListener("click", () => {
  toast("请先在服务端开启再玩一次功能，或创建新房间。");
});

$("game-content").addEventListener("click", event => {
  const answerButton = event.target.closest("[data-answer]");

  if (answerButton && currentState?.phase === "answering") {
    if (hasSubmitted) return;

    selectedAnswer = answerButton.dataset.answer;
    hasSubmitted = true;

    socket.emit("submit-answer", {
      answer: selectedAnswer
    });

    renderGame(currentState);
    return;
  }

  if (event.target.closest("#big-heart")) {
    if (
      currentState?.phase !== "heart-active" ||
      hasClickedHeart
    ) return;

    hasClickedHeart = true;
    socket.emit("heart-click");
    renderGame(currentState);
  }
});

timerInterval = setInterval(updateTimer, 200);

window.addEventListener("beforeunload", () => {
  clearInterval(timerInterval);
});
