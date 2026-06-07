const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, '../public')));

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const WORLD = { width: 1200, height: 700 };

const PLATFORMS = [
  { x: 0,    y: 620, w: 1200, h: 80 },
  { x: 200,  y: 460, w: 200,  h: 20 },
  { x: 500,  y: 380, w: 200,  h: 20 },
  { x: 800,  y: 460, w: 200,  h: 20 },
  { x: 350,  y: 280, w: 160,  h: 20 },
  { x: 690,  y: 280, w: 160,  h: 20 },
];

const PLAYER = {
  width: 40,
  height: 60,
  speed: 340,
  jumpForce: -820,        // 跳更高
  doubleJumpForce: -700,  // 二段跳
  gravity: 2200,          // 重力加重，落得快
  maxFallSpeed: 1200,
  dashSpeed: 650,
  dashDuration: 0.12,
  dashCooldown: 0.7,
  shootCooldown: 0.25,    // 射擊 CD
  maxHP: 100,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  invincibleDuration: 0.3,
  knockbackX: 700,        // 誇張擊飛
  knockbackY: -500,
};

const BULLET = {
  speed: 950,
  damage: 12,
  radius: 6,
  lifetime: 1.2,
};

const SPAWN = [
  { x: 150,  y: 540 },
  { x: 1010, y: 540 },
];

const rooms = new Map();

function createPlayer(index) {
  return {
    index,
    x: SPAWN[index].x,
    y: SPAWN[index].y,
    vx: 0, vy: 0,
    hp: PLAYER.maxHP,
    facing: index === 0 ? 1 : -1,
    onGround: false,
    jumping: false,
    doubleJumped: false,
    dashing: false,
    dashTimer: 0,
    dashCooldownTimer: 0,
    shootCooldownTimer: 0,
    invincibleTimer: 0,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    dead: false,
    input: { left:false, right:false, jump:false, attack:false, dash:false },
    prevInput: { left:false, right:false, jump:false, attack:false, dash:false },
  };
}

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],
    sockets: [],
    bullets: [],
    started: false,
    winner: null,
    loopInterval: null,
    bulletIdCounter: 0,
  };
}

function rectOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx+bw && ax+aw > bx && ay < by+bh && ay+ah > by;
}

function resolvePlayerPlatforms(p) {
  const pw = PLAYER.width, ph = PLAYER.height;
  for (const plat of PLATFORMS) {
    if (!rectOverlap(p.x, p.y, pw, ph, plat.x, plat.y, plat.w, plat.h)) continue;
    const oL = (p.x+pw) - plat.x;
    const oR = (plat.x+plat.w) - p.x;
    const oT = (p.y+ph) - plat.y;
    const oB = (plat.y+plat.h) - p.y;
    const minX = Math.min(oL, oR);
    const minY = Math.min(oT, oB);
    if (minY < minX) {
      if (oT < oB) {
        p.y = plat.y - ph;
        if (p.vy > 0) p.vy = 0;
        p.onGround = true;
      } else {
        p.y = plat.y + plat.h;
        if (p.vy < 0) p.vy = 0;
      }
    } else {
      p.x = oL < oR ? plat.x - pw : plat.x + plat.w;
      p.vx = 0;
    }
  }
}

function spawnPlayer(p) {
  p.x = SPAWN[p.index].x;
  p.y = SPAWN[p.index].y;
  p.vx = 0; p.vy = 0;
  p.facing = p.index === 0 ? 1 : -1;
  p.onGround = false;
  p.jumping = false;
  p.doubleJumped = false;
  p.dashing = false;
  p.dashTimer = 0;
  p.dashCooldownTimer = 0.5;
  p.shootCooldownTimer = 0;
  p.invincibleTimer = 1.0;
  p.coyoteTimer = 0;
  p.jumpBufferTimer = 0;
  p.dead = false;
}

function tickRoom(room) {
  if (!room.started || room.winner !== null) return;
  const [p0, p1] = room.players;
  const others = [p1, p0];

  // ── Players ──
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (p.dead) continue;
    const inp = p.input, prev = p.prevInput;

    // Timers
    p.dashTimer           = Math.max(0, p.dashTimer - DT);
    p.dashCooldownTimer   = Math.max(0, p.dashCooldownTimer - DT);
    p.shootCooldownTimer  = Math.max(0, p.shootCooldownTimer - DT);
    p.invincibleTimer     = Math.max(0, p.invincibleTimer - DT);
    p.coyoteTimer         = Math.max(0, p.coyoteTimer - DT);
    p.jumpBufferTimer     = Math.max(0, p.jumpBufferTimer - DT);

    // Jump buffer
    if (inp.jump && !prev.jump) p.jumpBufferTimer = PLAYER.jumpBuffer;

    // Shoot
    if (inp.attack && !prev.attack && p.shootCooldownTimer <= 0) {
      p.shootCooldownTimer = PLAYER.shootCooldown;
      room.bullets.push({
        id: room.bulletIdCounter++,
        ownerIndex: p.index,
        x: p.x + (p.facing > 0 ? PLAYER.width + 4 : -BULLET.radius * 2),
        y: p.y + PLAYER.height * 0.4,
        vx: p.facing * BULLET.speed,
        vy: 0,
        life: BULLET.lifetime,
        hit: false,
      });
    }

    // Dash
    if (!p.dashing && (inp.dash && !prev.dash) && p.dashCooldownTimer <= 0) {
      p.dashing = true;
      p.dashTimer = PLAYER.dashDuration;
      p.dashCooldownTimer = PLAYER.dashCooldown;
      p.vx = p.facing * PLAYER.dashSpeed;
      p.vy = 0;
      p.invincibleTimer = Math.max(p.invincibleTimer, PLAYER.dashDuration);
    }

    if (p.dashing) {
      p.vx = p.facing * PLAYER.dashSpeed;
      if (p.dashTimer <= 0) { p.dashing = false; p.vx = p.facing * PLAYER.speed * 0.3; }
    }

    // Movement
    if (!p.dashing) {
      let targetVx = 0;
      if (inp.left)  { targetVx = -PLAYER.speed; p.facing = -1; }
      if (inp.right) { targetVx =  PLAYER.speed;  p.facing =  1; }
      const accel = p.onGround ? 22 : 12;
      p.vx += (targetVx - p.vx) * Math.min(1, accel * DT);
    }

    // Gravity
    p.vy += PLAYER.gravity * DT;
    if (p.vy > PLAYER.maxFallSpeed) p.vy = PLAYER.maxFallSpeed;

    const wasOnGround = p.onGround;
    p.onGround = false;

    p.x += p.vx * DT;
    p.y += p.vy * DT;
    resolvePlayerPlatforms(p);

    if (!wasOnGround && p.onGround) {
      p.jumping = false;
      p.doubleJumped = false;
    }
    if (wasOnGround && !p.onGround) {
      p.coyoteTimer = PLAYER.coyoteTime;
    }

    // Jump / double jump
    if (p.jumpBufferTimer > 0) {
      const canFirst = p.onGround || p.coyoteTimer > 0;
      if (canFirst && !p.jumping) {
        p.vy = PLAYER.jumpForce;
        p.jumping = true;
        p.onGround = false;
        p.coyoteTimer = 0;
        p.jumpBufferTimer = 0;
      } else if (p.jumping && !p.doubleJumped) {
        // 二段跳：必須是按下瞬間才觸發
        if (inp.jump && !prev.jump) {
          p.vy = PLAYER.doubleJumpForce;
          p.doubleJumped = true;
          p.jumpBufferTimer = 0;
        }
      }
    }

    // Out of bounds
    if (p.x < -150 || p.x > WORLD.width + 150 || p.y > WORLD.height + 120) {
      p.dead = true; p.hp = 0;
    }

    p.prevInput = { ...inp };
  }

  // ── Bullets ──
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.life -= DT;

    // Out of world
    if (b.life <= 0 || b.x < -50 || b.x > WORLD.width + 50) {
      room.bullets.splice(i, 1); continue;
    }

    // Hit platform
    let hitPlat = false;
    for (const plat of PLATFORMS) {
      if (b.x > plat.x && b.x < plat.x + plat.w &&
          b.y > plat.y && b.y < plat.y + plat.h) {
        hitPlat = true; break;
      }
    }
    if (hitPlat) { room.bullets.splice(i, 1); continue; }

    // Hit player
    const target = room.players[1 - b.ownerIndex];
    if (!target.dead && target.invincibleTimer <= 0) {
      const tx = target.x, ty = target.y;
      const pw = PLAYER.width, ph = PLAYER.height;
      if (b.x > tx && b.x < tx+pw && b.y > ty && b.y < ty+ph) {
        target.hp -= BULLET.damage;
        // 擊飛方向：子彈飛行方向
        const dir = b.vx > 0 ? 1 : -1;
        target.vx = dir * PLAYER.knockbackX;
        target.vy = PLAYER.knockbackY;
        target.invincibleTimer = PLAYER.invincibleDuration;
        target.onGround = false;
        if (target.hp <= 0) { target.hp = 0; target.dead = true; }
        room.bullets.splice(i, 1); continue;
      }
    }
  }

  // Check winner
  const p0dead = room.players[0].dead;
  const p1dead = room.players[1].dead;
  if (p0dead || p1dead) {
    room.winner = (p0dead && p1dead) ? -1 : (p0dead ? 1 : 0);
  }

  const state = {
    players: room.players.map(p => ({
      index: p.index,
      x: p.x, y: p.y,
      vx: p.vx, vy: p.vy,
      hp: p.hp,
      facing: p.facing,
      onGround: p.onGround,
      dashing: p.dashing,
      doubleJumped: p.doubleJumped,
      invincible: p.invincibleTimer > 0,
      dead: p.dead,
    })),
    bullets: room.bullets.map(b => ({ id: b.id, x: b.x, y: b.y, ownerIndex: b.ownerIndex })),
    winner: room.winner,
  };

  io.to(room.id).emit('gameState', state);

  if (room.winner !== null) {
    clearInterval(room.loopInterval);
    room.loopInterval = null;
  }
}

function startRoom(room) {
  room.started = true;
  room.winner = null;
  room.bullets = [];
  room.players.forEach(spawnPlayer);
  if (room.loopInterval) clearInterval(room.loopInterval);
  room.loopInterval = setInterval(() => tickRoom(room), 1000 / TICK_RATE);
  io.to(room.id).emit('gameStart', {
    platforms: PLATFORMS, world: WORLD, playerConst: PLAYER,
  });
}

function restartRoom(room) {
  room.players.forEach(p => { p.hp = PLAYER.maxHP; p.dead = false; });
  room.winner = null;
  room.bullets = [];
  room.players.forEach(spawnPlayer);
  if (room.loopInterval) clearInterval(room.loopInterval);
  room.loopInterval = setInterval(() => tickRoom(room), 1000 / TICK_RATE);
  io.to(room.id).emit('gameRestart', {});
}

io.on('connection', (socket) => {
  let myRoom = null, myIndex = -1;

  socket.on('joinRoom', ({ roomId }) => {
    if (!roomId || typeof roomId !== 'string') return;
    roomId = roomId.trim().toUpperCase().slice(0, 12);
    if (!roomId) return;
    if (!rooms.has(roomId)) rooms.set(roomId, createRoom(roomId));
    const room = rooms.get(roomId);
    if (room.sockets.length >= 2) { socket.emit('roomFull'); return; }
    const idx = room.players.length;
    room.players.push(createPlayer(idx));
    room.sockets.push(socket.id);
    myRoom = room; myIndex = idx;
    socket.join(roomId);
    socket.emit('joined', { index: idx, roomId });
    io.to(roomId).emit('playerCount', { count: room.players.length });
    if (room.players.length === 2) setTimeout(() => startRoom(room), 500);
  });

  socket.on('input', (inp) => {
    if (!myRoom || myIndex < 0) return;
    const p = myRoom.players[myIndex];
    if (!p) return;
    p.input = {
      left: !!inp.left, right: !!inp.right,
      jump: !!inp.jump, attack: !!inp.attack, dash: !!inp.dash,
    };
  });

  socket.on('requestRestart', () => {
    if (!myRoom || myRoom.winner === null) return;
    restartRoom(myRoom);
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    io.to(myRoom.id).emit('playerLeft');
    if (myRoom.loopInterval) clearInterval(myRoom.loopInterval);
    rooms.delete(myRoom.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
