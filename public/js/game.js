/* game.js — client rendering + input */
const socket = io();

const lobbyEl        = document.getElementById('lobby');
const gameScreenEl   = document.getElementById('gameScreen');
const roomInput      = document.getElementById('roomInput');
const joinBtn        = document.getElementById('joinBtn');
const lobbyStatus    = document.getElementById('lobbyStatus');
const canvas         = document.getElementById('gameCanvas');
const ctx            = canvas.getContext('2d');
const waitingOverlay = document.getElementById('waitingOverlay');
const waitingText    = document.getElementById('waitingText');
const resultOverlay  = document.getElementById('resultOverlay');
const resultText     = document.getElementById('resultText');
const restartBtn     = document.getElementById('restartBtn');
const roomLabel      = document.getElementById('roomLabel');

let myIndex   = -1;
let platforms = [];
let world     = { width: 1200, height: 700 };
let PLAYER    = {};
let gameState = null;
let inGame    = false;

// ── Input ──────────────────────────────────────────────────────────────────
const keys = {};
const prevSent = { left:false, right:false, jump:false, attack:false, dash:false };

window.addEventListener('keydown', e => {
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

function readInput() {
  return {
    left:   !!(keys['KeyA'] || keys['ArrowLeft']),
    right:  !!(keys['KeyD'] || keys['ArrowRight']),
    jump:   !!(keys['KeyW'] || keys['ArrowUp'] || keys['Space']),
    attack: !!(keys['KeyJ'] || keys['KeyZ']),
    dash:   !!(keys['KeyK'] || keys['KeyX']),
  };
}

setInterval(() => {
  if (!inGame) return;
  const inp = readInput();
  if (inp.left !== prevSent.left || inp.right !== prevSent.right ||
      inp.jump !== prevSent.jump || inp.attack !== prevSent.attack ||
      inp.dash !== prevSent.dash) {
    socket.emit('input', inp);
    Object.assign(prevSent, inp);
  }
}, 1000 / 60);

// ── Canvas ────────────────────────────────────────────────────────────────
function resizeCanvas() {
  const scale = Math.min(window.innerWidth / world.width, window.innerHeight / world.height) * 0.95;
  canvas.width  = world.width;
  canvas.height = world.height;
  canvas.style.width  = Math.floor(world.width  * scale) + 'px';
  canvas.style.height = Math.floor(world.height * scale) + 'px';
}
window.addEventListener('resize', resizeCanvas);

// ── Compat roundRect ──────────────────────────────────────────────────────
function roundRect(x, y, w, h, r) {
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.lineTo(x+w-r, y);
  ctx.arcTo(x+w, y,   x+w, y+r,   r);
  ctx.lineTo(x+w, y+h-r);
  ctx.arcTo(x+w, y+h, x+w-r, y+h, r);
  ctx.lineTo(x+r, y+h);
  ctx.arcTo(x,   y+h, x,   y+h-r, r);
  ctx.lineTo(x,   y+r);
  ctx.arcTo(x,   y,   x+r, y,     r);
  ctx.closePath();
}

// ── Particles ─────────────────────────────────────────────────────────────
const P_COLORS = ['#4cc9f0', '#f72585'];
const P_DARK   = ['#0d4f66', '#5c0a30'];

let particles = [];

function spawnHitParticles(x, y, color, count = 14) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 120 + Math.random() * 300;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 100,
      life: 0.5 + Math.random() * 0.4,
      maxLife: 0.9,
      color,
      size: 3 + Math.random() * 6,
    });
  }
}

function spawnMuzzleFlash(x, y, dir, color) {
  for (let i = 0; i < 6; i++) {
    particles.push({
      x, y,
      vx: dir * (200 + Math.random() * 300),
      vy: (Math.random() - 0.5) * 180,
      life: 0.08 + Math.random() * 0.08,
      maxLife: 0.16,
      color,
      size: 4 + Math.random() * 6,
    });
  }
}

// bullet trail storage per id
const bulletTrails = {}; // id → [{x,y}]

// ── Render ────────────────────────────────────────────────────────────────
let prevHPs = [100, 100];
let lastTs = null;
let prevBullets = [];

function render(ts) {
  requestAnimationFrame(render);
  const now = ts / 1000;
  const dt  = lastTs ? Math.min(now - lastTs, 0.05) : 0;
  lastTs = now;

  const W = world.width, H = world.height;

  // Background
  ctx.fillStyle = '#06060c';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(42,42,64,0.4)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= W; gx += 80) { ctx.beginPath(); ctx.moveTo(gx,0); ctx.lineTo(gx,H); ctx.stroke(); }
  for (let gy = 0; gy <= H; gy += 80) { ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(W,gy); ctx.stroke(); }

  // Platforms
  for (const p of platforms) {
    const isGround = p.h > 40;
    if (isGround) {
      roundRect(p.x, p.y, p.w, p.h, 0);
      ctx.fillStyle = '#1a1a2e';
      ctx.fill();
      ctx.strokeStyle = '#2a2a50'; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = '#3a3a70'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y+1); ctx.lineTo(p.x+p.w, p.y+1); ctx.stroke();
    } else {
      roundRect(p.x, p.y, p.w, p.h, 6);
      const g = ctx.createLinearGradient(p.x, p.y, p.x, p.y+p.h);
      g.addColorStop(0, '#2d2d50'); g.addColorStop(1, '#1a1a30');
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = '#4a4a90'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x+6, p.y); ctx.lineTo(p.x+p.w-6, p.y); ctx.stroke();
      ctx.fillStyle = '#5a5aaa';
      ctx.fillRect(p.x+8, p.y+7, 4, 4);
      ctx.fillRect(p.x+p.w-12, p.y+7, 4, 4);
    }
  }

  if (!gameState) {
    updateParticles(dt);
    return;
  }

  // ── Bullets ──
  const curBullets = gameState.bullets || [];

  // Detect new bullets for muzzle flash
  const prevIds = new Set(prevBullets.map(b => b.id));
  for (const b of curBullets) {
    if (!prevIds.has(b.id)) {
      const color = P_COLORS[b.ownerIndex];
      spawnMuzzleFlash(b.x, b.y, b.vx > 0 ? 1 : -1, color);
    }
    // Trail
    if (!bulletTrails[b.id]) bulletTrails[b.id] = [];
    bulletTrails[b.id].push({ x: b.x, y: b.y });
    if (bulletTrails[b.id].length > 8) bulletTrails[b.id].shift();
  }

  // Detect destroyed bullets → hit particles
  const curIds = new Set(curBullets.map(b => b.id));
  for (const pb of prevBullets) {
    if (!curIds.has(pb.id)) {
      delete bulletTrails[pb.id];
      // Only spawn hit particles if bullet didn't just leave world (heuristic: was in world)
      if (pb.x > 0 && pb.x < world.width) {
        spawnHitParticles(pb.x, pb.y, P_COLORS[pb.ownerIndex], 18);
      }
    }
  }
  prevBullets = [...curBullets];

  // Draw bullet trails
  for (const b of curBullets) {
    const trail = bulletTrails[b.id] || [];
    const color = P_COLORS[b.ownerIndex];

    // Trail
    for (let t = 0; t < trail.length - 1; t++) {
      const alpha = (t / trail.length) * 0.6;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * (t / trail.length);
      ctx.shadowColor = color;
      ctx.shadowBlur  = 8;
      ctx.beginPath();
      ctx.moveTo(trail[t].x, trail[t].y);
      ctx.lineTo(trail[t+1].x, trail[t+1].y);
      ctx.stroke();
      ctx.restore();
    }

    // Bullet body
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur  = 16;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(b.x, b.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ── Players ──
  for (const ps of gameState.players) {
    const PW = PLAYER.width || 40;
    const PH = PLAYER.height || 60;
    const color = P_COLORS[ps.index];
    const dark  = P_DARK[ps.index];
    if (ps.dead) continue;

    // Damage particles
    if (ps.hp < prevHPs[ps.index]) {
      spawnHitParticles(ps.x + PW/2, ps.y + PH/2, color, 20);
    }
    prevHPs[ps.index] = ps.hp;

    // Dash trail
    if (ps.dashing) {
      for (let t = 1; t <= 5; t++) {
        ctx.save();
        ctx.globalAlpha = (6 - t) / 14;
        roundRect(ps.x - ps.facing * t * 12, ps.y + PH*0.2, PW, PH*0.6, 4);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
      }
    }

    // Invincibility flicker
    if (ps.invincible && Math.floor(now * 14) % 2 === 0) continue;

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur  = 10;

    // Body
    roundRect(ps.x, ps.y + PH*0.3, PW, PH*0.7, 6);
    const bodyG = ctx.createLinearGradient(ps.x, ps.y, ps.x+PW, ps.y+PH);
    bodyG.addColorStop(0, color);
    bodyG.addColorStop(1, dark);
    ctx.fillStyle = bodyG;
    ctx.fill();

    // Head
    const hW = PW * 0.7, hH = PH * 0.35;
    const hX = ps.x + (PW - hW)/2, hY = ps.y;
    roundRect(hX, hY, hW, hH, 8);
    ctx.fillStyle = color;
    ctx.fill();

    // Eye
    const eyeOX = ps.facing > 0 ? hW*0.6 : hW*0.15;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(hX + eyeOX, hY + hH*0.45, 4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(hX + eyeOX + ps.facing*1.5, hY + hH*0.45, 2, 0, Math.PI*2); ctx.fill();

    // Gun barrel
    const gunY = ps.y + PH * 0.38;
    const gunX = ps.facing > 0 ? ps.x + PW - 2 : ps.x + 2;
    ctx.fillStyle = '#aaa';
    ctx.fillRect(
      ps.facing > 0 ? gunX : gunX - 18,
      gunY - 3,
      18, 6
    );

    ctx.restore();

    // Double jump indicator
    if (!ps.onGround && ps.doubleJumped) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(ps.x - 2, ps.y - 2, PW + 4, PH + 4);
      ctx.restore();
    }

    // YOU label
    if (ps.index === myIndex) {
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.shadowColor = color;
      ctx.shadowBlur  = 8;
      ctx.fillText('YOU', ps.x + PW/2, ps.y - 8);
      ctx.restore();
    }
  }

  // HUD update
  for (const ps of gameState.players) {
    const bar = document.getElementById(`hpBar${ps.index}`);
    const num = document.getElementById(`hpNum${ps.index}`);
    const pct = Math.max(0, ps.hp) / (PLAYER.maxHP || 100) * 100;
    if (bar) bar.style.width = pct + '%';
    if (num) num.textContent = Math.max(0, Math.round(ps.hp));
  }

  // Winner check
  if (gameState.winner !== null && resultOverlay.style.display === 'none') {
    inGame = false;
    resultOverlay.style.display = 'flex';
    if (gameState.winner === -1) {
      resultText.textContent = 'DRAW';
      resultText.style.color = '#aaa';
    } else if (gameState.winner === myIndex) {
      resultText.textContent = '🏆 YOU WIN';
      resultText.style.color = P_COLORS[myIndex];
    } else {
      resultText.textContent = 'YOU LOSE';
      resultText.style.color = '#666';
    }
  }

  updateParticles(dt);
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x  += p.vx * dt;
    p.y  += p.vy * dt;
    p.vy += 500 * dt;
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    const alpha = p.life / (p.maxLife || 0.5);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur  = 8;
    ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
    ctx.restore();
  }
}

requestAnimationFrame(render);

// ── Lobby ─────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const rid = roomInput.value.trim().toUpperCase() || randomRoomId();
  roomInput.value = rid;
  lobbyStatus.textContent = 'Connecting…';
  socket.emit('joinRoom', { roomId: rid });
});
roomInput.addEventListener('keydown', e => { if (e.code === 'Enter') joinBtn.click(); });

function randomRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// ── Socket events ─────────────────────────────────────────────────────────
socket.on('joined', ({ index, roomId }) => {
  myIndex = index;
  lobbyEl.style.display = 'none';
  gameScreenEl.style.display = 'flex';
  roomLabel.textContent = roomId;
  document.getElementById('youLabel0').textContent = index === 0 ? '(YOU)' : '';
  document.getElementById('youLabel1').textContent = index === 1 ? '(YOU)' : '';
  waitingOverlay.style.display = 'flex';
  waitingText.textContent = `你是 P${index+1}。等待對手加入…`;
  resizeCanvas();
});

socket.on('roomFull', () => { lobbyStatus.textContent = '❌ 房間已滿'; });

socket.on('gameStart', ({ platforms: plat, world: w, playerConst }) => {
  platforms = plat; world = w; PLAYER = playerConst;
  inGame = true;
  prevHPs = [PLAYER.maxHP, PLAYER.maxHP];
  waitingOverlay.style.display = 'none';
  resultOverlay.style.display  = 'none';
  resizeCanvas();
});

socket.on('gameRestart', () => {
  resultOverlay.style.display = 'none';
  prevHPs = [PLAYER.maxHP, PLAYER.maxHP];
  particles = [];
  prevBullets = [];
  inGame = true;
  // 清掉舊的 gameState，避免 render loop 因 winner !== null 又把 overlay 顯示回來
  if (gameState) gameState.winner = null;
});

socket.on('gameState', (state) => { gameState = state; });

socket.on('playerLeft', () => {
  inGame = false;
  resultOverlay.style.display = 'flex';
  resultText.textContent = 'OPPONENT LEFT';
  resultText.style.color = '#888';
});

restartBtn.addEventListener('click', () => { socket.emit('requestRestart'); });
