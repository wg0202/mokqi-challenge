const socket = io();
const $ = id => document.getElementById(id);
const sections = ['welcome','lobby','waiting','game','over'];
let roomCode = '', roomState = null, myId = '', currentRound = null, answered = false, reactionTimer = null, signalReady = false, reactionStart = 0, myAnswer = null;
const emoji = {quiz:'🧠',rps:'✊',reaction:'⚡',choice:'💭',random:'🎲'};
function show(id){sections.forEach(s=>$(s).classList.toggle('hidden',s!==id));}
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2400);}
function myName(){return $('name').value.trim().slice(0,16)||'玩家';}
function urlFor(code){const u=new URL(location.href);u.searchParams.set('room',code);return u.toString();}
function clearReaction(){if(reactionTimer)clearTimeout(reactionTimer);reactionTimer=null;}
function resetRoundUI(){answered=false;myAnswer=null;signalReady=false;clearReaction();$('options').classList.remove('hidden');$('reactionBox').classList.add('hidden');$('result').classList.add('hidden');$('next').classList.add('hidden');$('answerStatus').textContent='选择答案后等待好友';}
function renderRoom(r){roomState=r;roomCode=r.code;$('codeLabel').textContent=r.code;$('inviteLink').value=urlFor(r.code);$('players').innerHTML='';r.players.forEach((p,i)=>{const el=document.createElement('div');el.className='player-card';el.innerHTML=`<div class="avatar">${i===0?'🐻':'🐰'}</div><div>${escapeHtml(p.name)}<small>${p.id===socket.id?'你':'好友'} · ${p.score} 分</small></div>`;$('players').appendChild(el)});if(r.players.length<2){const el=document.createElement('div');el.className='player-card';el.innerHTML='<div class="avatar">⌛</div><div>等待好友…<small>分享邀请链接</small></div>';$('players').appendChild(el)}$('start').disabled=r.players.length!==2;$('start').textContent=r.players.length===2?'开始挑战！':'等待第二位玩家…';if(!r.started && !currentRound)show('waiting');}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
$('create').onclick=()=>{socket.emit('room:create',{name:myName()},res=>{if(!res.ok)return toast(res.error);roomCode=res.code;show('waiting');toast('房间创建成功！复制链接邀请好友。');});};
$('joinToggle').onclick=()=>$('joinBox').classList.toggle('hidden');
$('join').onclick=()=>joinRoom($('roomCode').value);
function joinRoom(code){socket.emit('room:join',{code,name:myName()},res=>{if(!res.ok)return toast(res.error);roomCode=res.code;show('waiting');toast('加入成功，准备开玩！');});}
$('copyCode').onclick=()=>copyText(roomCode);
$('copyLink').onclick=()=>copyText($('inviteLink').value);
async function copyText(t){try{await navigator.clipboard.writeText(t);toast('已复制！发给好友吧。');}catch(e){const i=document.createElement('textarea');i.value=t;document.body.appendChild(i);i.select();document.execCommand('copy');i.remove();toast('已复制！');}}
$('start').onclick=()=>socket.emit('game:start');
socket.on('connect',()=>{myId=socket.id;const c=new URLSearchParams(location.search).get('room');if(c){$('roomCode').value=c;joinRoom(c);}});
socket.on('room:update',r=>{renderRoom(r);if(r.started && currentRound)show('game');});
socket.on('notice',msg=>{$('notice').textContent=msg;toast(msg);});
socket.on('round:start',r=>{currentRound=r;resetRoundUI();show('game');$('roundPill').textContent=`第 ${r.round} / ${r.total} 轮`;$('progressBar').style.width=(r.round/r.total*100)+'%';$('gameEmoji').textContent=emoji[r.type]||'🎲';$('gameTitle').textContent=r.title;$('prompt').textContent=r.prompt;$('tip').textContent=r.tip;$('options').innerHTML='';if(r.type==='reaction'){$('options').classList.add('hidden');$('reactionBox').classList.remove('hidden');$('reactionText').textContent='准备好了吗？信号出现后马上点击！';$('reactionButton').disabled=true;$('reactionButton').classList.remove('go');$('reactionButton').textContent='等待信号…';const delay=Math.max(500,r.signalAt-Date.now());reactionTimer=setTimeout(()=>{if(!currentRound||answered)return;signalReady=true;reactionStart=performance.now();$('reactionButton').disabled=false;$('reactionButton').classList.add('go');$('reactionButton').textContent='点这里！';$('reactionText').textContent='现在！现在！';},delay);}else{r.options.forEach(opt=>{const b=document.createElement('button');b.className='option';b.textContent=opt;b.onclick=()=>submitAnswer(opt,b);$('options').appendChild(b);});}updateScoreline();});
function submitAnswer(answer,btn){if(answered)return;answered=true;myAnswer=answer;socket.emit('round:answer',{answer});document.querySelectorAll('.option').forEach(b=>{b.disabled=true;if(b===btn)b.classList.add('selected')});$('answerStatus').textContent='已提交！等待好友选择…';}
$('reactionButton').onclick=()=>{if(answered||!signalReady)return;const ms=Math.round(performance.now()-reactionStart);submitAnswer(ms);$('reactionButton').disabled=true;$('reactionButton').textContent=ms+' ms';$('reactionText').textContent='漂亮！等待好友成绩…';};
socket.on('round:progress',d=>{$('answerStatus').textContent=d.count===2?'双方已提交，正在揭晓…':`已有 ${d.count}/2 位玩家提交，等好友一下…`;});
socket.on('round:result',r=>{clearReaction();answered=true;$('options').classList.add('hidden');$('reactionBox').classList.add('hidden');$('result').classList.remove('hidden');$('result').innerHTML=`<div style="font-size:28px">🎉</div><div>${escapeHtml(r.detail)}</div><div class="sub">${r.players.map(p=>`${escapeHtml(p.name)}：${p.score} 分（本轮 +${p.gained}）`).join('　 ·　')}</div>`;$('answerStatus').textContent='本轮完成！';$('next').classList.remove('hidden');$('next').textContent=r.players[0].score===r.players[1].score?'继续下一轮 →':'再来一轮，继续冲分 →';updateScoreline();});
function updateScoreline(){if(roomState)$('scoreline').textContent=roomState.players.map(p=>`${p.name} ${p.score}`).join('　·　');}
$('next').onclick=()=>socket.emit('game:next');
socket.on('game:over',d=>{currentRound=null;show('over');const s=d.standings;$('winnerText').textContent=s[0].score===s[1].score?'平局！你们也太有默契了吧！':`🎉 ${s[0].name} 获胜！不过快乐才是第一名。`;$('finalScores').innerHTML=s.map((p,i)=>`<div class="final-score"><span>${i===0?'🏆':'🌟'} ${escapeHtml(p.name)}</span><span>${p.score} 分</span></div>`).join('');});
$('playAgain').onclick=()=>socket.emit('game:start');
$('backLobby').onclick=()=>{currentRound=null;show('waiting');};
socket.on('disconnect',()=>toast('连接断开，正在尝试重新连接…'));
socket.on('connect_error',()=>toast('暂时无法连接服务器，请刷新页面重试。'));
