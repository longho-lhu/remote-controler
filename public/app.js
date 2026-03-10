/* ──────────────────────────────────────────────────────────────────────────── *
 *  RC Controller – Frontend                                                    *
 *  • Gamepad API: đọc TX RadioMaster (EdgeTX) qua USB / Bluetooth             *
 *  • Video: MJPEG img / HLS video / WebRTC                                     *
 *  • MQTT qua Socket.io                                                        *
 * ──────────────────────────────────────────────────────────────────────────── */

const socket = io();

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  direction: 'stop',
  speed: 50,
  turboActive: false,
  lightActive: false,
  keysDown: new Set(),
  // Gamepad
  gamepadIndex: null,
  gamepadLoopId: null,
  videoUrl: '',
  videoType: 'mjpeg',
};

// ── DOM refs ───────────────────────────────────────────────────────────────────
const mqttDot    = document.getElementById('mqttDot');
const mqttLabel  = document.getElementById('mqttLabel');
const gamepadDot = document.getElementById('gamepadDot');
const gamepadLbl = document.getElementById('gamepadLabel');
const dispDir    = document.getElementById('dispDirection');
const dispSpeed  = document.getElementById('dispSpeed');
const dispBroker = null; // broker shown in HUD now
const speedSlider= document.getElementById('speedSlider');
const speedValue = document.getElementById('speedValue');
const arcFill    = document.getElementById('arcFill');
const arrowChev  = document.getElementById('arrowChevron');
const logList    = document.getElementById('logList');
const keyOverlay = document.getElementById('keyOverlay');
const settingsOverlay = document.getElementById('settingsOverlay');

// Video refs
const imgFeed        = document.getElementById('imgFeed');
const videoFeed      = document.getElementById('videoFeed');
const videoNoSignal  = document.getElementById('videoNoSignal');
const hudDir         = document.getElementById('hudDir');
const hudSpd         = document.getElementById('hudSpd');
const hudMqtt        = document.getElementById('hudMqtt');
const txStatus       = document.getElementById('txStatus');

// Channel value refs
const chRefs = [1,2,3,4,5,6].map(i => document.getElementById(`ch${i}Val`));

// Direction → display config
const DIR_CONFIG = {
  stop:           { label: 'STOP',     arrow: '■',  deg: 0,   leds: ['ledStop']                   },
  forward:        { label: 'FORWARD',  arrow: '▲',  deg: 0,   leds: ['ledForward']                },
  backward:       { label: 'BACKWARD', arrow: '▼',  deg: 180, leds: ['ledBackward']               },
  left:           { label: 'LEFT',     arrow: '◀',  deg: 270, leds: ['ledLeft']                   },
  right:          { label: 'RIGHT',    arrow: '▶',  deg: 90,  leds: ['ledRight']                  },
  'forward-left': { label: 'FWD-L',    arrow: '↖',  deg: 315, leds: ['ledForward','ledLeft']      },
  'forward-right':{ label: 'FWD-R',    arrow: '↗',  deg: 45,  leds: ['ledForward','ledRight']     },
  'backward-left':{ label: 'BWD-L',    arrow: '↙',  deg: 225, leds: ['ledBackward','ledLeft']     },
  'backward-right':{ label: 'BWD-R',   arrow: '↘',  deg: 135, leds: ['ledBackward','ledRight']    },
};

// Key → direction mapping
const KEY_MAP = {
  ArrowUp:    'forward',   KeyW: 'forward',
  ArrowDown:  'backward',  KeyS: 'backward',
  ArrowLeft:  'left',      KeyA: 'left',
  ArrowRight: 'right',     KeyD: 'right',
  // diagonal
  KeyQ: 'forward-left',  KeyE: 'forward-right',
  KeyZ: 'backward-left', KeyC: 'backward-right',
  // stop
  Space: 'stop',
};

// Speed ± keys
const SPEED_UP_KEY   = 'Equal';   // +
const SPEED_DOWN_KEY = 'Minus';   // -

// ── Utility: log ──────────────────────────────────────────────────────────────
function addLog(type, text, extra = '') {
  const li   = document.createElement('li');
  const ts   = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  li.innerHTML = `<span class="log-ts">${ts}</span>
                  <span class="log-${type}">${text}</span>
                  <span class="log-speed">${extra}</span>`;
  logList.prepend(li);
  while (logList.children.length > 60) logList.removeChild(logList.lastChild);
}

// ── Utility: update arc fill (0-100 → stroke-dashoffset) ─────────────────────
// Arc path length ≈ 173 (π × 55), offset = 173 → empty, 0 → full
function updateArc(pct) {
  const total = 173;
  const offset = total - (pct / 100) * total;
  arcFill.style.strokeDashoffset = offset;
  // color: green 0-40, yellow 40-70, red 70-100
  const hue = pct < 40 ? 160 : pct < 70 ? 45 : 0;
  arcFill.style.stroke = `hsl(${hue},100%,55%)`;
}

// ── Utility: update all direction UI ─────────────────────────────────────────
function updateDirectionUI(dir) {
  const cfg = DIR_CONFIG[dir] || DIR_CONFIG.stop;
  dispDir.textContent   = cfg.label;
  if (hudDir) hudDir.textContent = cfg.label;
  arrowChev.textContent = cfg.arrow;
  arrowChev.style.transform = '';
  arrowChev.classList.toggle('active', dir !== 'stop');
  document.querySelectorAll('.led').forEach(l => l.classList.remove('active'));
  cfg.leds.forEach(id => document.getElementById(id)?.classList.add('active'));
  document.querySelectorAll('.dpad-btn').forEach(btn => {
    btn.classList.toggle('pressed', btn.dataset.dir === dir);
  });
}

// ── Utility: update speed UI ──────────────────────────────────────────────────
function updateSpeedUI(spd) {
  speedSlider.value     = spd;
  speedValue.textContent = spd;
  dispSpeed.textContent  = spd + '%';
  if (hudSpd) hudSpd.textContent = spd + '%';
  updateArc(spd);
}

// ── Emit control to server ────────────────────────────────────────────────────
let lastEmitKey = '';
function emitControl(direction, speed) {
  const key = `${direction}:${speed}`;
  if (key === lastEmitKey) return;
  lastEmitKey = key;
  state.direction = direction;
  state.speed     = speed;
  socket.emit('control', { direction, speed });
  updateDirectionUI(direction);
  updateSpeedUI(speed);
}

// ── Resolve active direction from currently pressed keys ─────────────────────
function resolveDirection() {
  // Priority: diagonal, then cardinal, then stop
  const dirs = [...state.keysDown].map(k => KEY_MAP[k]).filter(Boolean);
  if (!dirs.length) return 'stop';

  // Combine forward+left etc.
  const hasFwd  = dirs.includes('forward');
  const hasBwd  = dirs.includes('backward');
  const hasLeft = dirs.includes('left');
  const hasRight= dirs.includes('right');

  if (hasFwd && hasLeft)  return 'forward-left';
  if (hasFwd && hasRight) return 'forward-right';
  if (hasBwd && hasLeft)  return 'backward-left';
  if (hasBwd && hasRight) return 'backward-right';

  // Direct diagonals from Q E Z C
  const diagDirs = dirs.filter(d => d.includes('-'));
  if (diagDirs.length) return diagDirs[diagDirs.length - 1];

  return dirs[dirs.length - 1];
}

// ── Keyboard handlers ─────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Ignore when typing in input
  if (e.target.tagName === 'INPUT') return;

  const code = e.code;

  // Speed up / down
  if (code === SPEED_UP_KEY) {
    e.preventDefault();
    state.speed = Math.min(100, state.speed + 5);
    emitControl(state.direction, state.speed);
    showKeyOverlay('Speed +5%');
    return;
  }
  if (code === SPEED_DOWN_KEY) {
    e.preventDefault();
    state.speed = Math.max(0, state.speed - 5);
    emitControl(state.direction, state.speed);
    showKeyOverlay('Speed -5%');
    return;
  }

  // Turbo hold
  if (code === 'ControlLeft' || code === 'ControlRight') {
    document.getElementById('trigR').classList.add('pressed');
    state.turboActive = true;
    state.speed = 100;
    updateSpeedUI(100);
  }

  // Brake / stop
  if (code === 'ShiftLeft' || code === 'ShiftRight') {
    e.preventDefault();
    document.getElementById('trigL').classList.add('pressed');
    state.keysDown.clear();
    emitControl('stop', state.speed);
    showKeyOverlay('BRAKE');
    return;
  }

  // Horn
  if (code === 'KeyH') { toggleHorn(); return; }
  // Light
  if (code === 'KeyL') { toggleLight(); return; }
  // Turbo toggle
  if (code === 'KeyT') { toggleTurbo(); return; }

  if (!(code in KEY_MAP)) return;
  e.preventDefault();

  state.keysDown.add(code);

  const dir = resolveDirection();
  const spd = state.turboActive ? 100 : state.speed;
  emitControl(dir, spd);
  showKeyOverlay(code.replace('Key','').replace('Arrow',''));
});

document.addEventListener('keyup', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const code = e.code;

  if (code === 'ControlLeft' || code === 'ControlRight') {
    document.getElementById('trigR').classList.remove('pressed');
    state.turboActive = false;
  }
  if (code === 'ShiftLeft' || code === 'ShiftRight') {
    document.getElementById('trigL').classList.remove('pressed');
  }

  state.keysDown.delete(code);
  const dir = resolveDirection();
  const spd = state.turboActive ? 100 : state.speed;
  emitControl(dir, spd);
});

// Key overlay flash
let keyOverlayTimer;
function showKeyOverlay(text) {
  keyOverlay.textContent = `[ ${text} ]`;
  keyOverlay.classList.add('show');
  clearTimeout(keyOverlayTimer);
  keyOverlayTimer = setTimeout(() => keyOverlay.classList.remove('show'), 900);
}

// ── DPad button touch/click ───────────────────────────────────────────────────
document.querySelectorAll('.dpad-btn').forEach(btn => {
  const sendDir = () => {
    const dir = btn.dataset.dir;
    if (dir) emitControl(dir, state.turboActive ? 100 : state.speed);
  };

  btn.addEventListener('mousedown',  sendDir);
  btn.addEventListener('touchstart', e => { e.preventDefault(); sendDir(); }, { passive: false });

  const stopDir = () => {
    // Only stop if no keys are held
    if (state.keysDown.size === 0) emitControl('stop', state.speed);
  };
  btn.addEventListener('mouseup',  stopDir);
  btn.addEventListener('touchend', e => { e.preventDefault(); stopDir(); }, { passive: false });
});

// ── Speed slider ──────────────────────────────────────────────────────────────
speedSlider.addEventListener('input', () => {
  state.speed = parseInt(speedSlider.value, 10);
  updateSpeedUI(state.speed);
  emitControl(state.direction, state.speed);
});

// ── Action buttons ────────────────────────────────────────────────────────────
function toggleHorn() {
  socket.emit('control', { direction: 'horn', speed: state.speed });
  const btn = document.getElementById('btnHorn');
  btn.classList.add('active');
  setTimeout(() => btn.classList.remove('active'), 400);
  addLog('pub', 'HORN', '');
}
function toggleLight() {
  state.lightActive = !state.lightActive;
  document.getElementById('btnLight').classList.toggle('active', state.lightActive);
  socket.emit('control', { direction: state.lightActive ? 'light-on' : 'light-off', speed: 0 });
  addLog('pub', state.lightActive ? 'LIGHT ON' : 'LIGHT OFF', '');
}
function toggleTurbo() {
  state.turboActive = !state.turboActive;
  document.getElementById('btnTurbo').classList.toggle('active', state.turboActive);
  if (state.turboActive) { state.speed = 100; updateSpeedUI(100); }
  addLog('pub', state.turboActive ? 'TURBO ON' : 'TURBO OFF', '');
}

document.getElementById('btnHorn') .addEventListener('click', toggleHorn);
document.getElementById('btnLight').addEventListener('click', toggleLight);
document.getElementById('btnTurbo').addEventListener('click', toggleTurbo);

// Trigger buttons
document.getElementById('trigL').addEventListener('mousedown', () => {
  document.getElementById('trigL').classList.add('pressed');
  state.keysDown.clear(); emitControl('stop', state.speed);
});
document.getElementById('trigL').addEventListener('mouseup', () => {
  document.getElementById('trigL').classList.remove('pressed');
});
document.getElementById('trigR').addEventListener('mousedown', () => {
  document.getElementById('trigR').classList.add('pressed');
  state.turboActive = true; state.speed = 100; updateSpeedUI(100);
  emitControl(state.direction, 100);
});
document.getElementById('trigR').addEventListener('mouseup', () => {
  document.getElementById('trigR').classList.remove('pressed');
  state.turboActive = false;
});

// Clear log
document.getElementById('btnClear').addEventListener('click', () => { logList.innerHTML = ''; });

// ── Settings panel ────────────────────────────────────────────────────────────
document.getElementById('btnSettings').addEventListener('click', () => {
  settingsOverlay.hidden = false;
});
document.getElementById('btnCancel').addEventListener('click', () => {
  settingsOverlay.hidden = true;
});
document.getElementById('btnApply').addEventListener('click', () => {
  const host = document.getElementById('cfgHost').value.trim() || 'broker.hivemq.com';
  const port = document.getElementById('cfgPort').value.trim() || '1883';
  const user = document.getElementById('cfgUser').value.trim();
  const pass = document.getElementById('cfgPass').value.trim();
  socket.emit('set_broker', { host, port, username: user, password: pass });
  if (hudMqtt) { hudMqtt.textContent = '●'; }
  addLog('pub', `Broker → ${host}:${port}`, '');
  // Video
  const vurl  = document.getElementById('cfgVideoUrl').value.trim();
  const vtype = document.getElementById('cfgVideoType').value;
  if (vurl) applyVideoSource(vurl, vtype);
  settingsOverlay.hidden = true;
});
settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) settingsOverlay.hidden = true;
});

// ── Video source ───────────────────────────────────────────────────────────────
function applyVideoSource(url, type) {
  state.videoUrl  = url;
  state.videoType = type;
  imgFeed.style.display       = 'none';
  videoFeed.style.display     = 'none';
  videoNoSignal.style.display = 'none';
  if (type === 'mjpeg') {
    imgFeed.src = url;
    imgFeed.style.display = 'block';
    imgFeed.onerror = () => showNoSignal();
  } else {
    videoFeed.src = url;
    videoFeed.style.display = 'block';
    videoFeed.play().catch(() => showNoSignal());
    videoFeed.onerror = () => showNoSignal();
  }
  addLog('pub', `Video → ${type.toUpperCase()} ${url}`, '');
}

function showNoSignal() {
  imgFeed.style.display       = 'none';
  videoFeed.style.display     = 'none';
  videoNoSignal.style.display = 'flex';
}

// ── Gamepad API (EdgeTX TX via USB HID) ────────────────────────────────────────
// EdgeTX standard HID: axes[0]=Roll, axes[1]=Pitch, axes[2]=Thr, axes[3]=Yaw
const DEADZONE = 0.05;

function startGamepadLoop() {
  if (state.gamepadLoopId) cancelAnimationFrame(state.gamepadLoopId);
  let lastPayloadStr = '';

  function loop() {
    const gamepads = navigator.getGamepads();
    const gp = gamepads[state.gamepadIndex];
    if (!gp) { stopGamepadLoop(); return; }

    const axes    = Array.from(gp.axes).slice(0, 6).map(v => parseFloat(v.toFixed(4)));
    const buttons = Array.from(gp.buttons).slice(0, 12).map(b => (b.pressed ? 1 : 0));
    // Map -1..1 → 1000..2000 (PWM range)
    const channels = axes.map(v => Math.round(((v + 1) / 2) * 1000 + 1000));

    // Update channel strip
    axes.forEach((v, i) => { if (chRefs[i]) chRefs[i].textContent = channels[i]; });

    // Derive direction from Roll(0) and Pitch(1)
    const roll  = axes[0] ?? 0;
    const pitch = axes[1] ?? 0; // -1 = stick forward on TX
    const fwd = pitch < -DEADZONE, bwd = pitch > DEADZONE;
    const lft = roll  < -DEADZONE, rgt = roll  > DEADZONE;
    let dir = 'stop';
    if      (fwd && lft) dir = 'forward-left';
    else if (fwd && rgt) dir = 'forward-right';
    else if (bwd && lft) dir = 'backward-left';
    else if (bwd && rgt) dir = 'backward-right';
    else if (fwd)        dir = 'forward';
    else if (bwd)        dir = 'backward';
    else if (lft)        dir = 'left';
    else if (rgt)        dir = 'right';

    // Throttle from axes[2]: -1..1 → 0..100
    const thr = axes[2] !== undefined
      ? Math.round(((axes[2] + 1) / 2) * 100)
      : state.speed;

    emitControl(dir, thr);

    // Publish to MQTT (only on change)
    const payloadStr = JSON.stringify({ channels, buttons, dir, thr });
    if (payloadStr !== lastPayloadStr) {
      socket.emit('gamepad', { channels, buttons, axes, dir, thr, ts: Date.now() });
      lastPayloadStr = payloadStr;
    }

    state.gamepadLoopId = requestAnimationFrame(loop);
  }
  state.gamepadLoopId = requestAnimationFrame(loop);
}

function stopGamepadLoop() {
  if (state.gamepadLoopId) { cancelAnimationFrame(state.gamepadLoopId); state.gamepadLoopId = null; }
  state.gamepadIndex = null;
  gamepadDot.classList.remove('online');
  gamepadLbl.textContent = 'TX: –';
  if (txStatus) { txStatus.textContent = 'NOT CONNECTED'; txStatus.classList.remove('tx-ok'); }
  addLog('err', 'TX Disconnected', '');
}

window.addEventListener('gamepadconnected', (e) => {
  state.gamepadIndex = e.gamepad.index;
  gamepadDot.classList.add('online');
  gamepadLbl.textContent = `TX: ${e.gamepad.id.substring(0, 22)}`;
  if (txStatus) { txStatus.textContent = 'CONNECTED'; txStatus.classList.add('tx-ok'); }
  addLog('pub', `TX Connected: ${e.gamepad.id}`,
         `axes:${e.gamepad.axes.length} btns:${e.gamepad.buttons.length}`);
  startGamepadLoop();
});

window.addEventListener('gamepaddisconnected', (e) => {
  if (e.gamepad.index === state.gamepadIndex) stopGamepadLoop();
});

// ── Socket.io events ──────────────────────────────────────────────────────────
socket.on('mqtt_status', ({ connected, broker, error }) => {
  mqttDot.classList.toggle('online', connected);
  mqttLabel.textContent = connected
    ? `Connected – ${broker}`
    : error ? `Error: ${error}` : 'Disconnected';
  if (hudMqtt) {
    hudMqtt.textContent = connected ? '●' : '○';
    hudMqtt.style.color = connected ? '#00e676' : '#ff3d71';
  }
  addLog(connected ? 'pub' : 'err',
         connected ? `MQTT OK – ${broker}` : `MQTT DISC`,
         error || '');
});

socket.on('control_echo', ({ direction, speed, timestamp }) => {
  addLog('dir',
    `→ ${(direction || 'stop').toUpperCase()}`,
    `spd=${speed}%  ts=${timestamp}`
  );
});

socket.on('mqtt_message', ({ topic, payload }) => {
  let txt = typeof payload === 'object' ? JSON.stringify(payload) : payload;
  addLog('pub', `[${topic}]`, txt);
});

// ── Init ──────────────────────────────────────────────────────────────────────
updateDirectionUI('stop');
updateSpeedUI(50);
updateArc(50);

// Prevent default scroll on arrow / space
window.addEventListener('keydown', e => {
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
    e.preventDefault();
  }
}, { passive: false });
