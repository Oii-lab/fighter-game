const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '../public')));

// ── Constants ──────────────────────────────────────────────────────────────
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;

const WORLD = { width: 1200, height: 700 };

const PLATFORMS = [
  { x: 0,    y: 620, w: 1200, h: 80  }, // ground
  { x: 200,  y: 460, w: 200,  h: 20  },
  { x: 500,  y: 380, w: 200,  h: 20  },
  { x: 800,  y: 460, w: 200,  h: 20  },
  { x: 350,  y: 280, w: 160,  h: 20  },
  { x: 690,  y: 280, w: 160,  h: 20  },
];

const PLAYER = {
  width: 40,
  height: 60,
  speed: 320,
  jumpForce: -680,
  gravity: 1800,
  maxFallSpeed: 900,
  dashSpeed: 600,
  dashDuration: 0.12,
  dashCooldown: 0.8,
  attackDuration: 0.18,
  attackCooldown: 0.35,
  attackRange: 70,
  attackHeight: 60,
  attackDamage: 8,
  knockbackX: 380,
  knockbackY: -280,
  maxHP: 100,
  coyoteTime: 0.1,
  jumpBuffer: 0.1,
  invincibleDuration: 0.4,
};

const SPAWN = [
  { x: 150,  y: 540 },
  { x: 1010, y: 540 },
];

// ── Room storage ───────────────────────────────────────────────────────────
const rooms = new Map(); // roomId → RoomState

function createPlayer(index) {
  return {
    index,
    x: SPAWN[index].x,
    y: SPAWN[index].y,
    vx: 0,
    vy: 0,
    hp: PLAYER.maxHP,
    facing: index === 0 ? 1 : -1,
    onGround: false,
    jumping: false,
    dashing: false,
    dashTimer: 0,
    dashCooldownTimer: 0,
    attacking: false,
    attackTimer: 0,
    attackCooldownTimer: 0,
    invincibleTimer: 0,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    dead: false,
    input: {
      left: false,
      right: false,
      jump: false,
      attack: false,
      dash: false,
    },
    prevInput: {
      left: false,
      right: false,
      jump: false,
      attack: false,
      dash: false,
    },
  };
}

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],           // array of player state (max 2)
    sockets: [],           // parallel array of socket ids
    started: false,
    winner: null,
    loopInterval: null,
  };
}

// ── Physics helpers ────────────────────────────────────────────────────────
function rectOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function resolvePlayerPlatforms(p) {
  const pw = PLAYER.width;
  const ph = PLAYER.height;

  for (const plat of PLATFORMS) {
    if (!rectOverlap(p.x, p.y, pw, ph, plat.x, plat.y, plat.w, plat.h)) continue;

    const overlapLeft  = (p.x + pw) - plat.x;
    const overlapRight = (plat.x + plat.w) - p.x;
    const overlapTop   = (p.y + ph) - plat.y;
    const overlapBot   = (plat.y + plat.h) - p.y;

    const minX = Math.min(overlapLeft, overlapRight);
    const minY = Math.min(overlapTop,  overlapBot);

    if (minY < minX) {
      if (overlapTop < overlapBot) {
        // landing on top
        p.y = plat.y - ph;
        if (p.vy > 0) p.vy = 0;
        p.onGround = true;
      } else {
        // hitting ceiling
        p.y = plat.y + plat.h;
        if (p.vy < 0) p.vy = 0;
      }
    } else {
      if (overlapLeft < overlapRight) {
        p.x = plat.x - pw;
      } else {
        p.x = plat.x + plat.w;
      }
      p.vx = 0;
    }
  }
}

function spawnPlayer(p) {
  p.x = SPAWN[p.index].x;
  p.y = SPAWN[p.index].y;
  p.vx = 0;
  p.vy = 0;
  p.facing = p.index === 0 ? 1 : -1;
  p.onGround = false;
  p.dashing = false;
  p.dashTimer = 0;
  p.dashCooldownTimer = 0.5;
  p.attacking = false;
  p.attackTimer = 0;
  p.attackCooldownTimer = 0;
  p.invincibleTimer = 1.0; // spawn invincibility
  p.coyoteTimer = 0;
  p.jumpBufferTimer = 0;
  p.dead = false;
}

// ── Game tick ──────────────────────────────────────────────────────────────
function tickRoom(room) {
  if (!room.started || room.winner !== null) return;

  const [p0, p1] = room.players;
  const others = [p1, p0];

  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    const other = others[i];
    if (p.dead) continue;

    const inp = p.input;
    const prev = p.prevInput;

    // Timers
    p.dashTimer         = Math.max(0, p.dashTimer - DT);
    p.dashCooldownTimer = Math.max(0, p.dashCooldownTimer - DT);
    p.attackTimer       = Math.max(0, p.attackTimer - DT);
    p.attackCooldownTimer = Math.max(0, p.attackCooldownTimer - DT);
    p.invincibleTimer   = Math.max(0, p.invincibleTimer - DT);
    p.coyoteTimer       = Math.max(0, p.coyoteTimer - DT);
    p.jumpBufferTimer   = Math.max(0, p.jumpBufferTimer - DT);

    // Jump buffer
    if (inp.jump && !prev.jump) p.jumpBufferTimer = PLAYER.jumpBuffer;

    // Dash
    if (!p.dashing) {
      if ((inp.dash && !prev.dash) && p.dashCooldownTimer <= 0) {
        p.dashing = true;
        p.dashTimer = PLAYER.dashDuration;
        p.dashCooldownTimer = PLAYER.dashCooldown;
        p.vx = p.facing * PLAYER.dashSpeed;
        p.vy = 0;
        p.invincibleTimer = Math.max(p.invincibleTimer, PLAYER.dashDuration);
      }
    }

    if (p.dashing) {
      p.vx = p.facing * PLAYER.dashSpeed;
      if (p.dashTimer <= 0) {
        p.dashing = false;
        p.vx = p.facing * PLAYER.speed * 0.3;
      }
    }

    // Attack
    if (!p.attacking && !p.dashing) {
      if ((inp.attack && !prev.attack) && p.attackCooldownTimer <= 0) {
        p.attacking = true;
        p.attackTimer = PLAYER.attackDuration;
        p.attackCooldownTimer = PLAYER.attackCooldown;
      }
    }
    if (p.attackTimer <= 0) p.attacking = false;

    // Hit detection
    if (p.attacking && p.attackTimer > PLAYER.attackDuration * 0.6) {
      // hitbox in front
      const hx = p.facing > 0 ? p.x + PLAYER.width : p.x - PLAYER.attackRange;
      const hy = p.y + (PLAYER.height - PLAYER.attackHeight) / 2;
      const hw = PLAYER.attackRange;
      const hh = PLAYER.attackHeight;

      if (!other.dead && other.invincibleTimer <= 0) {
        if (rectOverlap(hx, hy, hw, hh, other.x, other.y, PLAYER.width, PLAYER.height)) {
          other.hp -= PLAYER.attackDamage;
          other.vx  = p.facing * PLAYER.knockbackX;
          other.vy  = PLAYER.knockbackY;
          other.invincibleTimer = PLAYER.invincibleDuration;
          other.onGround = false;
          if (other.hp <= 0) {
            other.hp = 0;
            other.dead = true;
          }
        }
      }
    }

    // Movement (skip if dashing)
    if (!p.dashing) {
      let targetVx = 0;
      if (inp.left)  { targetVx = -PLAYER.speed; p.facing = -1; }
      if (inp.right) { targetVx =  PLAYER.speed;  p.facing =  1; }

      // Smooth horizontal movement
      const accel = p.onGround ? 20 : 10;
      p.vx += (targetVx - p.vx) * Math.min(1, accel * DT);
    }

    // Gravity
    p.vy += PLAYER.gravity * DT;
    if (p.vy > PLAYER.maxFallSpeed) p.vy = PLAYER.maxFallSpeed;

    // Coyote time
    const wasOnGround = p.onGround;
    p.onGround = false;

    // Integrate
    p.x += p.vx * DT;
    p.y += p.vy * DT;

    resolvePlayerPlatforms(p);

    if (!wasOnGround && p.onGround) {
      p.jumping = false;
    }
    if (wasOnGround && !p.onGround) {
      p.coyoteTimer = PLAYER.coyoteTime;
    }

    // Jump
    const canJump = p.onGround || p.coyoteTimer > 0;
    if (p.jumpBufferTimer > 0 && canJump && !p.jumping) {
      p.vy = PLAYER.jumpForce;
      p.jumping = true;
      p.onGround = false;
      p.coyoteTimer = 0;
      p.jumpBufferTimer = 0;
    }

    // World bounds - horizontal wrap or death
    if (p.x < -100 || p.x > WORLD.width + 100 || p.y > WORLD.height + 100) {
      p.dead = true;
      p.hp = 0;
    }

    p.prevInput = { ...inp };
  }

  // Check winner
  const p0dead = room.players[0].dead;
  const p1dead = room.players[1].dead;

  if (p0dead || p1dead) {
    if (p0dead && p1dead) room.winner = -1; // draw
    else if (p0dead) room.winner = 1;
    else room.winner = 0;
  }

  // Broadcast state
  const state = {
    players: room.players.map(p => ({
      index: p.index,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      hp: p.hp,
      facing: p.facing,
      onGround: p.onGround,
      dashing: p.dashing,
      attacking: p.attacking,
      invincible: p.invincibleTimer > 0,
      dead: p.dead,
    })),
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
  room.players.forEach(spawnPlayer);

  if (room.loopInterval) clearInterval(room.loopInterval);
  room.loopInterval = setInterval(() => tickRoom(room), 1000 / TICK_RATE);

  io.to(room.id).emit('gameStart', {
    playerIndex: room.players.map(p => p.index),
    platforms: PLATFORMS,
    world: WORLD,
    playerConst: PLAYER,
  });
}

function restartRoom(room) {
  room.players.forEach(p => {
    p.hp = PLAYER.maxHP;
    p.dead = false;
  });
  room.winner = null;
  room.players.forEach(spawnPlayer);

  if (room.loopInterval) clearInterval(room.loopInterval);
  room.loopInterval = setInterval(() => tickRoom(room), 1000 / TICK_RATE);

  io.to(room.id).emit('gameRestart', {});
}

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let myRoom = null;
  let myIndex = -1;

  socket.on('joinRoom', ({ roomId }) => {
    if (!roomId || typeof roomId !== 'string') return;
    roomId = roomId.trim().toUpperCase().slice(0, 12);
    if (!roomId) return;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, createRoom(roomId));
    }
    const room = rooms.get(roomId);

    if (room.sockets.length >= 2) {
      socket.emit('roomFull');
      return;
    }

    const idx = room.players.length;
    room.players.push(createPlayer(idx));
    room.sockets.push(socket.id);
    myRoom = room;
    myIndex = idx;

    socket.join(roomId);
    socket.emit('joined', { index: idx, roomId });
    io.to(roomId).emit('playerCount', { count: room.players.length });

    if (room.players.length === 2) {
      setTimeout(() => startRoom(room), 500);
    }
  });

  socket.on('input', (inp) => {
    if (!myRoom || myIndex < 0) return;
    const p = myRoom.players[myIndex];
    if (!p) return;
    p.input = {
      left:   !!inp.left,
      right:  !!inp.right,
      jump:   !!inp.jump,
      attack: !!inp.attack,
      dash:   !!inp.dash,
    };
  });

  socket.on('requestRestart', () => {
    if (!myRoom) return;
    if (myRoom.winner === null) return;
    restartRoom(myRoom);
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    io.to(myRoom.id).emit('playerLeft');
    if (myRoom.loopInterval) {
      clearInterval(myRoom.loopInterval);
      myRoom.loopInterval = null;
    }
    rooms.delete(myRoom.id);
  });
});

// ── Start server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
