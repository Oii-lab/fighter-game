/* =========================================================
   game.js — client-side rendering + input
   Server is authoritative; we only send input here.
   ========================================================= */

const socket = io();

// ── DOM refs ──────────────────────────────────────────────────────────────
const lobbyEl          = document.getElementById('lobby');
const gameScreenEl     = document.getElementById('gameScreen');
const roomInput        = document.getElementById('roomInput');
const joinBtn          = document.getElementById('joinBtn');
const lobbyStatus      = document.getElementById('lobbyStatus');
const canvas           = document.getElementById('gameCanvas');
const ctx              = canvas.getContext('2d');
const waitingOverlay   = document.getElementById('waitingOverlay');
const waitingText      = document.getElementById('waitingText');
const resultOverlay    = document.getElementById('resultOverlay');
const resultText       = document.getElementById('resultText');
const restartBtn       = document.getElementById('restartBtn');
const roomLabel        = document.getElementById('roomLabel');

// ── Client state ──────────────────────────────────────────────────────────
let myIndex   = -1;
let platforms = [];
let world     = { width: 1200, height: 700 };
let PLAYER    = {};
let gameState = null;
let inGame    = false;

// ── Input state ───────────────────────────────────────────────────────────
const keys = {};
const inputState = {
  left: false, right: false,
  jump: false, attack: false, dash: false,
};
const prevSent = { ...inputState };

window.addEventListener('keydown', e => { keys[e.code] = true; });
window.addEventListener('keyup',   e => { keys[e.code] = false; });

function readInput() {
  return {
    left:   !!(keys['KeyA']   || keys['ArrowLeft']),
    right:  !!(keys['KeyD']   || keys['ArrowRight']),
    jump:   !!(keys['KeyW']   || keys['ArrowUp'] || keys['Space']),
    attack: !!(keys['KeyJ']   || keys['KeyZ']),
    dash:   !!(keys['KeyK']   || keys['KeyX']),
  };
}

function sendInput() {
  if (!inGame) return;
  const inp = readInput();
  // Only send if changed
  if (
    inp.left   !== prevSent.left  ||
    inp.right  !== prevSent.right ||
    inp.jump   !== prevSent.jump  ||
    inp.attack !== prevSent.attack||
    inp.dash   !== prevSent.dash
  ) {
    socket.emit('input', inp);
    Object.assign(prevSent, inp);
  }
}

setInterval(sendInput, 1000 / 60);

// ── Canvas sizing ─────────────────────────────────────────────────────────
function resizeCanvas() {
  const ww = window.innerWidth;
  const wh = window.innerHeight;
  const scale = Math.min(ww / world.width, wh / world.height) * 0.95;
  canvas.width  = world.width;
  canvas.height = world.height;
  canvas.style.width  = Math.floor(world.width  * scale) + 'px';
  canvas.style.height = Math.floor(world.height * scale) + 'px';
}

window.addEventListener('resize', resizeCanvas);

// ── Polyfill roundRect ────────────────────────────────────────────────────
function roundRect(cx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.lineTo(x + w - r, y);
  cx.arcTo(x + w, y,     x + w, y + r,     r);
  cx.lineTo(x + w, y + h - r);
  cx.arcTo(x + w, y + h, x + w - r, y + h, r);
  cx.lineTo(x + r, y + h);
  cx.arcTo(x,     y + h, x,     y + h - r, r);
  cx.lineTo(x,     y + r);
  cx.arcTo(x,     y,     x + r, y,         r);
  cx.closePath();
}

// ── Render ────────────────────────────────────────────────────────────────
const P_COLORS = ['#4cc9f0', '#f72585'];
const P_DARK   = ['#0d4f66', '#5c0a30'];

let particles = [];

function spawnHitParticles(x, y, color) {
  for (let i = 0; i < 10; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 80 + Math.random() * 200;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.4 + Math.random() * 0.3,
      maxLife: 0.6,
      color,
      size: 3 + Math.random() * 5,
    });
  }
}

let prevHPs = [100, 100];
let lastRenderTime = null;

function render(ts) {
  requestAnimationFrame(render);

  const now = ts / 1000;
  const dt  = lastRenderTime ? Math.min(now - lastRenderTime, 0.05) : 0;
  lastRenderTime = now;

  const W = world.width;
  const H = world.height;

  // ── Background ───────────────────────────────────────────────────────
  ctx.fillStyle = '#06060c';
  ctx.fillRect(0, 0, W, H);

  // Grid lines (subtle)
  ctx.strokeStyle = 'rgba(42,42,64,0.5)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= W; gx += 80) {
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
  }
  for (let gy = 0; gy <= H; gy += 80) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
  }

  // ── Platforms ────────────────────────────────────────────────────────
  for (const p of platforms) {
    const isGround = p.h > 40;

    if (isGround) {
      // Ground — solid slab
      roundRect(ctx, p.x, p.y, p.w, p.h, 0);
      ctx.fillStyle = '#1a1a2e';
      ctx.fill();
      ctx.strokeStyle = '#2a2a50';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Top edge highlight
      ctx.strokeStyle = '#3a3a70';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + 1);
      ctx.lineTo(p.x + p.w, p.y + 1);
      ctx.stroke();
    } else {
      // Floating platform
      roundRect(ctx, p.x, p.y, p.w, p.h, 6);
      const grad = ctx.createLinearGradient(p.x, p.y, p.x, p.y + p.h);
      grad.addColorStop(0, '#2d2d50');
      grad.addColorStop(1, '#1a1a30');
      ctx.fillStyle = grad;
      ctx.fill();

      // glow top edge
      ctx.strokeStyle = '#4a4a90';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x + 6, p.y);
      ctx.lineTo(p.x + p.w - 6, p.y);
      ctx.stroke();

      // side dots
      ctx.fillStyle = '#5a5aaa';
      ctx.fillRect(p.x + 8, p.y + 7, 4, 4);
      ctx.fillRect(p.x + p.w - 12, p.y + 7, 4, 4);
    }
  }

  // ── Players ──────────────────────────────────────────────────────────
  if (gameState) {
    for (const ps of gameState.players) {
      const PW = PLAYER.width  || 40;
      const PH = PLAYER.height || 60;
      const color = P_COLORS[ps.index];
      const dark  = P_DARK[ps.index];

      if (ps.dead) continue;

      // Particles on damage
      if (ps.hp < prevHPs[ps.index]) {
        spawnHitParticles(ps.x + PW / 2, ps.y + PH / 2, color);
      }
      prevHPs[ps.index] = ps.hp;

      // Dash trail
      if (ps.dashing) {
        for (let t = 1; t <= 4; t++) {
          const tx = ps.x - ps.facing * t * 14;
          const alpha = (5 - t) / 10;
          ctx.save();
          ctx.globalAlpha = alpha;
          roundRect(ctx, tx, ps.y + PH * 0.2, PW, PH * 0.6, 4);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.restore();
        }
      }

      // Invincibility flicker
      if (ps.invincible && Math.floor(now * 12) % 2 === 0) continue;

      // Body shadow
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur  = ps.attacking ? 20 : 8;

      // Main body
      roundRect(ctx, ps.x, ps.y + PH * 0.3, PW, PH * 0.7, 6);
      const bodyGrad = ctx.createLinearGradient(ps.x, ps.y, ps.x + PW, ps.y + PH);
      bodyGrad.addColorStop(0, color);
      bodyGrad.addColorStop(1, dark);
      ctx.fillStyle = bodyGrad;
      ctx.fill();

      // Head
      const headW = PW * 0.7;
      const headH = PH * 0.35;
      const headX = ps.x + (PW - headW) / 2;
      const headY = ps.y;
      roundRect(ctx, headX, headY, headW, headH, 8);
      ctx.fillStyle = color;
      ctx.fill();

      // Eye
      const eyeOffX = ps.facing > 0 ? headW * 0.6 : headW * 0.15;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(headX + eyeOffX, headY + headH * 0.45, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(headX + eyeOffX + ps.facing * 1.5, headY + headH * 0.45, 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      // Attack hitbox flash
      if (ps.attacking) {
        const hx = ps.facing > 0 ? ps.x + PW : ps.x - (PLAYER.attackRange || 70);
        const hy = ps.y + (PH - (PLAYER.attackHeight || 60)) / 2;
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = color;
        roundRect(ctx, hx, hy, PLAYER.attackRange || 70, PLAYER.attackHeight || 60, 4);
        ctx.fill();
        ctx.restore();

        // Slash line
        ctx.save();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.8;
        ctx.shadowColor = color;
        ctx.shadowBlur  = 10;
        ctx.beginPath();
        const slashX = ps.facing > 0 ? ps.x + PW + 10 : ps.x - 10;
        ctx.moveTo(slashX, ps.y + PH * 0.2);
        ctx.lineTo(slashX + ps.facing * 45, ps.y + PH * 0.8);
        ctx.stroke();
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
        ctx.fillText('YOU', ps.x + PW / 2, ps.y - 8);
        ctx.restore();
      }
    }

    // Update HUD
    for (const ps of gameState.players) {
      const bar = document.getElementById(`hpBar${ps.index}`);
      const num = document.getElementById(`hpNum${ps.index}`);
      const pct = Math.max(0, ps.hp) / (PLAYER.maxHP || 100) * 100;
      if (bar) bar.style.width = pct + '%';
      if (num) num.textContent = Math.max(0, Math.round(ps.hp));
    }
  }

  // ── Particles ─────────────────────────────────────────────────────────
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 400 * dt;
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    const alpha = p.life / (p.maxLife || 0.5);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur  = 6;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    ctx.restore();
  }
}

requestAnimationFrame(render);

// ── Socket events ─────────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const rid = roomInput.value.trim().toUpperCase() || randomRoomId();
  roomInput.value = rid;
  lobbyStatus.textContent = 'Connecting…';
  socket.emit('joinRoom', { roomId: rid });
});

roomInput.addEventListener('keydown', e => {
  if (e.code === 'Enter') joinBtn.click();
});

function randomRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

socket.on('joined', ({ index, roomId }) => {
  myIndex = index;
  lobbyEl.style.display = 'none';
  gameScreenEl.style.display = 'flex';
  roomLabel.textContent = roomId;

  // Mark YOU labels
  const y0 = document.getElementById('youLabel0');
  const y1 = document.getElementById('youLabel1');
  if (y0) y0.textContent = index === 0 ? '(YOU)' : '';
  if (y1) y1.textContent = index === 1 ? '(YOU)' : '';

  waitingOverlay.style.display = 'flex';
  waitingText.textContent = `你是 P${index + 1}。等待對手加入…`;
  resizeCanvas();
});

socket.on('roomFull', () => {
  lobbyStatus.textContent = '❌ 房間已滿';
});

socket.on('playerCount', ({ count }) => {
  if (count < 2) waitingText.textContent = `你是 P${myIndex + 1}。等待對手加入…`;
});

socket.on('gameStart', ({ platforms: plat, world: w, playerConst }) => {
  platforms = plat;
  world     = w;
  PLAYER    = playerConst;
  inGame    = true;
  waitingOverlay.style.display = 'none';
  resultOverlay.style.display  = 'none';
  prevHPs = [PLAYER.maxHP, PLAYER.maxHP];
  resizeCanvas();
});

socket.on('gameRestart', () => {
  resultOverlay.style.display = 'none';
  prevHPs = [PLAYER.maxHP, PLAYER.maxHP];
  particles = [];
  inGame = true;
});

socket.on('gameState', (state) => {
  gameState = state;

  if (state.winner !== null && resultOverlay.style.display === 'none') {
    inGame = false;
    resultOverlay.style.display = 'flex';
    if (state.winner === -1) {
      resultText.textContent = 'DRAW';
      resultText.style.color = '#aaa';
    } else if (state.winner === myIndex) {
      resultText.textContent = '🏆 YOU WIN';
      resultText.style.color = P_COLORS[myIndex];
    } else {
      resultText.textContent = 'YOU LOSE';
      resultText.style.color = '#666';
    }
  }
});

socket.on('playerLeft', () => {
  inGame = false;
  resultOverlay.style.display = 'flex';
  resultText.textContent = 'OPPONENT LEFT';
  resultText.style.color = '#888';
});

restartBtn.addEventListener('click', () => {
  socket.emit('requestRestart');
});
