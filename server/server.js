// server.js
// Woki signaling server: handles room create/join and relays WebRTC
// offers/answers/ICE candidates between peers. No audio ever passes
// through this server - it only exchanges the small text messages
// needed to set up a direct peer-to-peer WebRTC connection.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const roomManager = require("./roomManager");

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS.length ? CLIENT_ORIGINS : "*" }));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "woki-signaling-server" });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime() });
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

io.on("connection", (socket) => {
  // ----- CREATE ROOM -----
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

  // ----- JOIN ROOM -----
  socket.on("join-room", ({ roomCode, userName }, callback) => {
    try {
      const code = (roomCode || "").trim().toUpperCase();
      const name = roomManager.sanitizeName(userName);

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

  // ----- PUSH TO TALK -----
  socket.on("talk-start", (_, callback) => {
    const roomCode = socket.data.roomCode;
    const cb = typeof callback === "function" ? callback : () => {};
    if (!roomCode) return cb({ ok: false });

    const granted = roomManager.setSpeaker(roomCode, socket.id);
    if (!granted) {
      const speakerName = roomManager.getSpeakerName(roomCode);
      return cb({ ok: false, error: speakerName ? `${speakerName} is talking` : "Someone else is talking" });
    }
    cb({ ok: true });
    socket.to(roomCode).emit("speaker-start", { id: socket.id, name: socket.data.userName });
  });

  socket.on("talk-stop", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    roomManager.clearSpeaker(roomCode, socket.id);
    socket.to(roomCode).emit("speaker-stop", { id: socket.id });
  });

  // ----- DISCONNECT -----
  socket.on("disconnect", () => {
    handleLeave(socket);
  });

  function handleLeave(socket) {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    roomManager.clearSpeaker(roomCode, socket.id);
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

server.listen(PORT, () => {
  console.log(`Woki signaling server running on port ${PORT}`);
});
