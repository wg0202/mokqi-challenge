<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>情侣默契大冒险</title>
  <link rel="stylesheet" href="/style.css">
  <script src="/socket.io/socket.io.js"></script>
</head>
<body>
  <div class="app">
    <header class="brand">
      <div class="brand-heart">💖</div>
      <h1>情侣默契大冒险</h1>
    </header>

    <!-- 登录注册界面 -->
    <div id="auth-screen" class="card">
      <input type="text" id="username" placeholder="昵称">
      <input type="password" id="password" placeholder="密码(至少6位)">
      <button id="btn-register" class="btn secondary">注册</button>
      <button id="btn-login" class="btn primary">登录</button>
    </div>

    <!-- 房间大厅 (含选关) -->
    <div id="lobby-screen" class="card hidden">
      <h2>欢迎, <span id="my-name"></span>!</h2>
      
      <div id="room-actions">
        <button id="create-room-btn" class="btn primary">创建房间</button>
        <div style="margin-top: 10px; display: flex; gap: 8px;">
          <input type="text" id="room-code-input" placeholder="输入6位房间号">
          <button id="join-room-btn" class="btn secondary">加入</button>
        </div>
      </div>

      <!-- 选关面板（默认隐藏，两人到齐后显示） -->
      <div id="level-select-panel" class="hidden" style="margin-top: 20px;">
        <h3 style="text-align: center; color: #ed6799;">🎮 选择关卡开始挑战</h3>
        <button class="btn secondary level-btn" data-level="1">第 1 关：双人划船 🚣</button>
        <button class="btn secondary level-btn" data-level="2">第 2 关：双人拔河 🪢</button>
        <button class="btn secondary level-btn" data-level="3">第 3 关：双人迷宫 🏁</button>
        <button class="btn secondary level-btn" data-level="4">第 4 关：双人推箱子 🎁</button>
      </div>
    </div>

    <!-- 游戏界面 -->
    <div id="game-screen" class="card hidden">
      <h2 id="game-title">游戏加载中...</h2>
    </div>
  </div>

  <div id="notice" class="notice"></div>
  <script src="/client.js"></script>
</body>
</html>
