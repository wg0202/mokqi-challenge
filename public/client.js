const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);

let isRegisterMode = false;
let currentToken = "";

// 提示弹窗
function toast(msg) {
  const el = $("notice");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

// 切换登录/注册
$("tab-login").onclick = () => {
  isRegisterMode = false;
  $("tab-login").classList.add("active");
  $("tab-register").classList.remove("active");
  $("auth-submit").textContent = "登录";
};
$("tab-register").onclick = () => {
  isRegisterMode = true;
  $("tab-register").classList.add("active");
  $("tab-login").classList.remove("active");
  $("auth-submit").textContent = "注册";
};

// 提交账号
$("auth-submit").onclick = async () => {
  const username = $("username").value.trim();
  const password = $("password").value.trim();
  if (!username || !password) return toast("请输入账号密码");

  const url = isRegisterMode ? "/api/register" : "/api/login";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message);

    currentToken = data.token;
    $("auth-screen").classList.add("hidden");
    $("lobby-screen").classList.remove("hidden");
    $("my-name").textContent = data.user.username;

    socket.auth = { token: currentToken };
    socket.connect();
  } catch (err) {
    toast(err.message);
  }
};

// 创建房间
$("create-room-btn").onclick = () => {
  socket.emit("create-room");
};

// 加入房间
$("join-room-btn").onclick = () => {
  const code = $("room-code-input").value.trim();
  if (code) socket.emit("join-room", { code });
};

// 选关按钮点击事件
document.querySelectorAll(".level-btn").forEach(btn => {
  btn.onclick = () => {
    const level = Number(btn.dataset.level);
    socket.emit("start-game", { level });
  };
});

// Socket 连接成功
socket.on("connect", () => {
  toast("已连接到服务器");
});

socket.on("connect_error", (err) => {
  toast(err.message || "连接失败");
});

// 房间状态更新
socket.on("room-state", (room) => {
  // 如果房间有两个人了，显示选关面板
  if (room.players.length === 2) {
    $("room-actions").classList.add("hidden");
    $("level-select-panel").classList.remove("hidden");
  } else {
    $("room-actions").classList.remove("hidden");
    $("level-select-panel").classList.add("hidden");
  }
});

// 游戏开始
socket.on("game-started", (data) => {
  $("lobby-screen").classList.add("hidden");
  $("game-screen").classList.remove("hidden");
  $("game-title").textContent = `正在挑战第 ${data.level} 关`;
  
  // 这里可以根据 data.level 渲染不同的游戏 DOM，比如：
  if (data.level === 4) {
    $("game-board").innerHTML = `<div class="swipe-area"><strong>推箱子模式</strong><span>等待服务端下发坐标...</span></div>`;
  } else {
    $("game-board").innerHTML = `<div class="swipe-area"><strong>第 ${data.level} 关</strong><span>操作区</span></div>`;
  }
});

socket.on("action-success", (msg) => toast(msg));
socket.on("action-error", (msg) => toast(msg));
