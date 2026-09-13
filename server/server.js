// server.js
// Woki signaling server. Handles two ways to get into a call:
//   1) Room code (create/join) - unchanged group-call flow.
//   2) Direct number-to-number calling with real ringing, including
//      push notifications so the callee's phone can ring even if the
//      Woki tab/app isn't open.
//
// No audio ever passes through this server - it only exchanges the
// small text messages needed to set up a direct peer-to-peer WebRTC
// connection, plus the tiny "someone is calling you" signal.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const webpush = require("web-push");
const { Server } = require("socket.io");
const roomManager = require("./roomManager");
const userDirectory = require("./userDirectory");

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const RING_TIMEOUT_MS = 30000; // how long a call rings before "no answer"
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ---------------- Web Push setup ----------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@example.com";
const pushEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn(
    "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set - calls will only ring while the callee's app is open (no background push). See README for setup."
  );
}

// ---------------- OneSignal setup (real background ringing for the APK) ----------------
// Plain Web Push (above) can't wake a fully-closed AppMint-built APK -
// that needs OneSignal + Firebase Cloud Messaging, which AppMint bridges
// natively into the app shell. This is entirely optional; the app still
// works (with in-app-only ringing) if these aren't set.
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || "";
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY || "";
const oneSignalEnabled = Boolean(ONESIGNAL_APP_ID && ONESIGNAL_REST_API_KEY);
// The origin OneSignal should open when the notification is tapped -
// this reuses the same "?join=CODE&autoAnswer=1" deep link our own Web
// Push notifications already use, so the same client-side logic answers it.
const APP_ORIGIN = CLIENT_ORIGINS[0] || "";

if (!oneSignalEnabled) {
  console.warn(
    "ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY not set - the AppMint APK will only ring while it's actually open. See README for setup."
  );
}

async function sendOneSignalPush(targetRecord, { roomCode, callerName }) {
  const joinUrl = `${APP_ORIGIN}/?join=${encodeURIComponent(roomCode)}&autoAnswer=1`;

  // Target by External ID (the phone number, set client-side via
  // OneSignal.login()) first - this is the robust path inside a
  // WebView-wrapped APK. Fall back to a raw subscription id if we
  // happened to capture one and no external id match is expected to work.
  const body = {
    app_id: ONESIGNAL_APP_ID,
    headings: { en: `${callerName || "Someone"} is calling` },
    contents: { en: "Tap to answer on Woki" },
    url: joinUrl,
    android_visibility: 1,
    priority: 10,
    ttl: 30,
  };
  if (targetRecord.oneSignalId) {
    body.include_subscription_ids = [targetRecord.oneSignalId];
  } else {
    body.include_aliases = { external_id: [targetRecord.phone] };
    body.target_channel = "push";
  }

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OneSignal push failed: ${res.status} ${text}`);
  }
  return res.json();
}

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS.length ? CLIENT_ORIGINS : "*" }));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "woki-signaling-server" });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime() });
});

// Lets the client fetch the VAPID public key without hardcoding it,
// so the server's .env is the single source of truth for it.
app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGINS.length ? CLIENT_ORIGINS : "*",
    methods: ["GET", "POST"],
  },
});

function broadcastParticipants(roomCode) {
  io.to(roomCode).emit("room-update", {
    participants: roomManager.getParticipants(roomCode),
  });
}

/** roomCode -> { callerSocketId, callerPhone, callerName, targetPhone, timeout } */
const pendingCalls = new Map();

function getSocketById(socketId) {
  return socketId ? io.sockets.sockets.get(socketId) : null;
}

async function ringTarget(targetRecord, payload) {
  // Prefer waking them up in-app if they're currently connected.
  const targetSocket = getSocketById(targetRecord.socketId);
  if (targetSocket) {
    targetSocket.emit("incoming-call", payload);
    return "socket";
  }

  // Otherwise, try OneSignal first - this is the one that can wake a
  // fully-closed AppMint APK via Firebase Cloud Messaging. Targeting by
  // External ID (phone number) doesn't require us to have captured any
  // subscription id at all.
  if (oneSignalEnabled) {
    try {
      await sendOneSignalPush(targetRecord, payload);
      return "onesignal";
    } catch (err) {
      // Fall through and try plain Web Push instead.
    }
  }

  // Plain Web Push - works while a browser tab/PWA is open in the
  // background, but generally can't wake a fully-closed native APK.
  if (pushEnabled && targetRecord.pushSubscription) {
    try {
      await webpush.sendNotification(
        targetRecord.pushSubscription,
        JSON.stringify({ type: "incoming-call", ...payload, respondUrl: `${PUBLIC_URL}/api/call-response` })
      );
      return "push";
    } catch (err) {
      // Subscription is likely stale/expired - drop it so we don't keep
      // failing on every future call to this number.
      userDirectory.clearPushSubscription(targetRecord.phone);
    }
  }

  return "unreachable";
}

function endPendingCall(roomCode) {
  const pending = pendingCalls.get(roomCode);
  if (!pending) return null;
  clearTimeout(pending.timeout);
  pendingCalls.delete(roomCode);
  return pending;
}

/** Shared by the Socket.IO 'call-response' event and the HTTP fallback
 * used by the service worker's "Decline" notification action (which can
 * fire with no page/socket open at all). */
function handleCallResponse(roomCode, accepted) {
  const pending = endPendingCall(roomCode);
  if (!pending) return;

  if (!accepted) {
    const callerSocket = getSocketById(pending.callerSocketId);
    if (callerSocket) callerSocket.emit("call-rejected", { roomCode });
  }
  // If accepted, the callee joins normally via "join-room" - see there.
}

io.on("connection", (socket) => {
  // ----- REGISTER (simple phone-number "login", no OTP) -----
  socket.on("register", ({ phone, name }, callback) => {
    const cb = typeof callback === "function" ? callback : () => {};
    const cleanName = userDirectory.sanitizeName(name);
    const cleanPhone = userDirectory.sanitizePhone(phone);
    if (!cleanPhone) return cb({ ok: false, error: "Enter a valid phone number." });
    if (!cleanName) return cb({ ok: false, error: "Enter your name to continue." });

    userDirectory.register(cleanPhone, cleanName, socket.id);
    socket.data.phone = cleanPhone;
    socket.data.userName = cleanName;
    cb({ ok: true, phone: cleanPhone, name: cleanName });
  });

  // ----- SAVE PUSH SUBSCRIPTION (so this number can be called while the app is closed) -----
  socket.on("save-push-subscription", ({ phone, subscription }) => {
    try {
      userDirectory.savePushSubscription(phone, subscription);
    } catch (err) {
      // Non-critical - in-app ringing still works without this.
    }
  });

  // ----- SAVE ONESIGNAL ID (real background ringing for the AppMint APK) -----
  socket.on("save-onesignal-id", ({ phone, oneSignalId }) => {
    try {
      userDirectory.saveOneSignalId(phone, oneSignalId);
    } catch (err) {
      // Non-critical - in-app ringing still works without this.
    }
  });

  // ----- CALL A PHONE NUMBER DIRECTLY -----
  socket.on("call-user", ({ toPhone }, callback) => {
    const cb = typeof callback === "function" ? callback : () => {};
    const callerPhone = socket.data.phone;
    const callerName = socket.data.userName;

    if (!callerPhone) return cb({ ok: false, error: "Log in with your number first." });

    const cleanTarget = userDirectory.sanitizePhone(toPhone);
    if (!cleanTarget) return cb({ ok: false, error: "Enter a valid phone number." });
    if (cleanTarget === callerPhone) return cb({ ok: false, error: "You can't call yourself." });

    const targetRecord = userDirectory.getByPhone(cleanTarget);
    if (!targetRecord) {
      return cb({ ok: false, error: "That number hasn't used Woki yet." });
    }

    const roomCode = roomManager.createRoom(`${callerName}'s call`);
    roomManager.addParticipant(roomCode, socket.id, callerName);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    const timeout = setTimeout(() => {
      const pending = endPendingCall(roomCode);
      if (!pending) return;
      const callerSocket = getSocketById(pending.callerSocketId);
      if (callerSocket) callerSocket.emit("call-no-answer", { roomCode });
      const targetSocket = getSocketById(targetRecord.socketId);
      if (targetSocket) targetSocket.emit("call-cancelled", { roomCode });
    }, RING_TIMEOUT_MS);

    pendingCalls.set(roomCode, {
      callerSocketId: socket.id,
      callerPhone,
      callerName,
      targetPhone: cleanTarget,
      timeout,
    });

    ringTarget(targetRecord, { roomCode, callerName, callerPhone }).then((how) => {
      if (how === "unreachable") {
        endPendingCall(roomCode);
        cb({ ok: false, error: "That number can't be reached right now." });
      } else {
        cb({ ok: true, roomCode, ringingVia: how });
      }
    });
  });

  // ----- ACCEPT / DECLINE (decline while the app is open; accept = join-room) -----
  socket.on("call-response", ({ roomCode, accepted }) => {
    handleCallResponse(roomCode, accepted);
  });

  // ----- CANCEL AN OUTGOING CALL BEFORE IT'S ANSWERED -----
  socket.on("cancel-call", ({ roomCode }) => {
    const pending = endPendingCall(roomCode);
    if (!pending || pending.callerSocketId !== socket.id) return;
    const targetRecord = userDirectory.getByPhone(pending.targetPhone);
    const targetSocket = targetRecord && getSocketById(targetRecord.socketId);
    if (targetSocket) targetSocket.emit("call-cancelled", { roomCode });
  });

  // ----- CREATE ROOM (group calls via room code) -----
  socket.on("create-room", ({ roomName, userName }, callback) => {
    try {
      const name = roomManager.sanitizeName(userName);
      if (!name) {
        return callback({ ok: false, error: "Enter your name to continue." });
      }
      const roomCode = roomManager.createRoom(roomName);
      roomManager.addParticipant(roomCode, socket.id, name);

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.userName = name;

      const room = roomManager.getRoom(roomCode);
      callback({
        ok: true,
        roomCode,
        roomName: room.roomName,
        participants: roomManager.getParticipants(roomCode),
      });
    } catch (err) {
      callback({ ok: false, error: "Couldn't create the room. Try again." });
    }
  });

  // ----- JOIN ROOM (also how an accepted direct call is "picked up") -----
  socket.on("join-room", ({ roomCode, userName }, callback) => {
    try {
      const code = (roomCode || "").trim().toUpperCase();
      const name = roomManager.sanitizeName(userName) || socket.data.userName;

      if (!name) {
        return callback({ ok: false, error: "Enter your name to continue." });
      }
      if (!code) {
        return callback({ ok: false, error: "Enter a room code to join." });
      }
      if (!roomManager.roomExists(code)) {
        return callback({ ok: false, error: "Room not found. Check the code and try again." });
      }
      if (roomManager.isRoomFull(code)) {
        return callback({ ok: false, error: "This room is full." });
      }
      if (roomManager.isNameTaken(code, name)) {
        return callback({ ok: false, error: "That name is already taken in this room." });
      }

      const existingParticipants = roomManager.getParticipants(code);
      roomManager.addParticipant(code, socket.id, name);

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.userName = name;

      const room = roomManager.getRoom(code);

      callback({
        ok: true,
        roomCode: code,
        roomName: room.roomName,
        participants: roomManager.getParticipants(code),
        // the new joiner will initiate WebRTC offers to everyone already here
        existingParticipants,
      });

      // tell everyone already in the room that a new peer has arrived
      socket.to(code).emit("peer-joined", { id: socket.id, name });
      broadcastParticipants(code);

      // If this join was actually someone answering a direct call, let the
      // caller know their "ringing..." screen can turn into a live call.
      const pending = endPendingCall(code);
      if (pending) {
        const callerSocket = getSocketById(pending.callerSocketId);
        if (callerSocket) callerSocket.emit("call-accepted", { roomCode: code });
      }
    } catch (err) {
      callback({ ok: false, error: "Couldn't join the room. Try again." });
    }
  });

  // ----- LEAVE ROOM (explicit) -----
  socket.on("leave-room", () => {
    handleLeave(socket);
  });

  // ----- WEBRTC SIGNAL RELAY (offer / answer / ice-candidate) -----
  socket.on("signal", ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  // ----- SPEAKING INDICATOR (UI hint only, not exclusive) -----
  socket.on("speaking-start", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(roomCode).emit("speaker-start", { id: socket.id, name: socket.data.userName });
  });

  socket.on("speaking-stop", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(roomCode).emit("speaker-stop", { id: socket.id });
  });

  // ----- MUTE / UNMUTE (for participant list UI only) -----
  socket.on("mute-changed", ({ muted }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(roomCode).emit("peer-mute-changed", { id: socket.id, muted: !!muted });
  });

  // ----- DISCONNECT -----
  socket.on("disconnect", () => {
    // Cancel any call this socket was ringing out that never got answered.
    for (const [roomCode, pending] of pendingCalls.entries()) {
      if (pending.callerSocketId === socket.id) {
        endPendingCall(roomCode);
        const targetRecord = userDirectory.getByPhone(pending.targetPhone);
        const targetSocket = targetRecord && getSocketById(targetRecord.socketId);
        if (targetSocket) targetSocket.emit("call-cancelled", { roomCode });
      }
    }
    userDirectory.markOffline(socket.id);
    handleLeave(socket);
  });

  function handleLeave(socket) {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    roomManager.removeParticipant(roomCode, socket.id);

    socket.to(roomCode).emit("peer-left", { id: socket.id });
    socket.to(roomCode).emit("speaker-stop", { id: socket.id });

    if (roomManager.roomExists(roomCode)) {
      broadcastParticipants(roomCode);
    }

    socket.leave(roomCode);
    socket.data.roomCode = null;
  }
});

// HTTP fallback for the "Decline" action on a background push notification,
// where there may be no open page/socket to send a Decline through at all.
app.post("/api/call-response", (req, res) => {
  const { roomCode, accepted } = req.body || {};
  if (!roomCode) return res.status(400).json({ ok: false, error: "roomCode required" });
  handleCallResponse(roomCode, Boolean(accepted));
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Woki signaling server running on port ${PORT}`);
  if (!pushEnabled) {
    console.log("Push notifications are OFF. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to enable ringing while the app is closed.");
  }
});
