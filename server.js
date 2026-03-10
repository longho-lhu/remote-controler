require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── MQTT Configuration ───────────────────────────────────────────────────────
const MQTT_CONFIG = {
  host: process.env.MQTT_HOST || 'broker.hivemq.com',
  port: process.env.MQTT_PORT || 1883,
  clientId: `rc_controller_${Math.random().toString(16).slice(2, 8)}`,
  username: process.env.MQTT_USER || '',
  password: process.env.MQTT_PASS || '',
};

const TOPICS = {
  control:  'rc/control',
  direction:'rc/direction',
  speed:    'rc/speed',
  status:   'rc/status',
  gamepad:  'rc/gamepad',
};

// ─── Connect MQTT ─────────────────────────────────────────────────────────────
const mqttClient = mqtt.connect(`mqtt://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}`, {
  clientId: MQTT_CONFIG.clientId,
  username: MQTT_CONFIG.username || undefined,
  password: MQTT_CONFIG.password || undefined,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
});

let mqttConnected = false;

mqttClient.on('connect', () => {
  mqttConnected = true;
  console.log(`[MQTT] Connected to ${MQTT_CONFIG.host}:${MQTT_CONFIG.port}`);
  mqttClient.subscribe(TOPICS.status, (err) => {
    if (!err) console.log(`[MQTT] Subscribed to ${TOPICS.status}`);
  });
  io.emit('mqtt_status', { connected: true, broker: `${MQTT_CONFIG.host}:${MQTT_CONFIG.port}` });
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] Reconnecting…');
  io.emit('mqtt_status', { connected: false, broker: `${MQTT_CONFIG.host}:${MQTT_CONFIG.port}` });
});

mqttClient.on('error', (err) => {
  mqttConnected = false;
  console.error('[MQTT] Error:', err.message);
  io.emit('mqtt_status', { connected: false, error: err.message });
});

mqttClient.on('close', () => {
  mqttConnected = false;
  io.emit('mqtt_status', { connected: false });
});

mqttClient.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    io.emit('mqtt_message', { topic, payload });
  } catch {
    io.emit('mqtt_message', { topic, payload: message.toString() });
  }
});

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── REST endpoint to update MQTT broker ─────────────────────────────────────
app.post('/api/config', (req, res) => {
  const { host, port, username, password } = req.body;
  if (host) {
    mqttClient.end(true, () => {
      const newUrl = `mqtt://${host}:${port || 1883}`;
      mqttClient.reconnect();
    });
  }
  res.json({ ok: true });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Send current MQTT status to newly connected client
  socket.emit('mqtt_status', { connected: mqttConnected, broker: `${MQTT_CONFIG.host}:${MQTT_CONFIG.port}` });

  // Handle control commands from browser
  socket.on('control', (data) => {
    const { direction, speed, raw } = data;

    const payload = JSON.stringify({
      direction: direction || 'stop',
      speed: speed !== undefined ? speed : 100,
      timestamp: Date.now(),
    });

    if (mqttConnected) {
      mqttClient.publish(TOPICS.control, payload, { qos: 0 }, (err) => {
        if (err) console.error('[MQTT] Publish error:', err.message);
      });
      mqttClient.publish(TOPICS.direction, direction || 'stop', { qos: 0 });
      mqttClient.publish(TOPICS.speed, String(speed !== undefined ? speed : 100), { qos: 0 });
    }

    // Broadcast to all clients (for multi-tab display)
    io.emit('control_echo', { direction, speed, timestamp: Date.now() });
    console.log(`[RC] ${direction?.toUpperCase() || 'STOP'} | speed: ${speed}%`);
  });

  // Handle raw gamepad / TX channel data
  socket.on('gamepad', (data) => {
    if (mqttConnected) {
      mqttClient.publish(TOPICS.gamepad, JSON.stringify(data), { qos: 0 }, (err) => {
        if (err) console.error('[MQTT] Gamepad publish error:', err.message);
      });
    }
    // broadcast to all tabs for telemetry display
    io.emit('gamepad_echo', data);
  });

  // Handle MQTT broker config change
  socket.on('set_broker', (cfg) => {
    const { host, port, username, password } = cfg;
    console.log(`[MQTT] Switching broker to ${host}:${port}`);
    mqttClient.end(false, {}, () => {
      Object.assign(MQTT_CONFIG, { host, port: Number(port) || 1883, username: username || '', password: password || '' });
      const newClient = mqtt.connect(`mqtt://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}`, {
        clientId: MQTT_CONFIG.clientId,
        username: MQTT_CONFIG.username || undefined,
        password: MQTT_CONFIG.password || undefined,
      });
      // Re-bind events (simplified – a full impl would refactor to a factory)
    });
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 RC Controller server running at http://localhost:${PORT}`);
  console.log(`📡 MQTT Broker: ${MQTT_CONFIG.host}:${MQTT_CONFIG.port}`);
  console.log(`   Topics: ${Object.values(TOPICS).join(', ')}\n`);
});
