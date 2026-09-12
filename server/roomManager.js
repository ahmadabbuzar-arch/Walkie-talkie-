// roomManager.js
// Keeps all room state in memory. No database needed for the MVP.
// Automatically cleans up rooms once the last participant leaves.

const MAX_ROOM_SIZE = parseInt(process.env.MAX_ROOM_SIZE || "8", 10);

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion
const CODE_LENGTH = 5;

/** rooms: Map<roomCode, { roomName, createdAt, speakerId, participants: Map<socketId, {id, name}> }> */
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  if (typeof name !== "string") return "";
  return name.trim().slice(0, 20);
}

function sanitizeRoomName(name) {
  if (typeof name !== "string" || !name.trim()) return "Squad";
  return name.trim().slice(0, 30);
}

function createRoom(roomName) {
  const roomCode = generateRoomCode();
  rooms.set(roomCode, {
    roomName: sanitizeRoomName(roomName),
    createdAt: Date.now(),
    speakerId: null,
    participants: new Map(),
  });
  return roomCode;
}

function getRoom(roomCode) {
  return rooms.get(roomCode);
}

function roomExists(roomCode) {
  return rooms.has(roomCode);
}

function isRoomFull(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return false;
  return room.participants.size >= MAX_ROOM_SIZE;
}

function isNameTaken(roomCode, name) {
  const room = rooms.get(roomCode);
  if (!room) return false;
  const lower = name.toLowerCase();
  for (const p of room.participants.values()) {
    if (p.name.toLowerCase() === lower) return true;
  }
  return false;
}

function addParticipant(roomCode, socketId, name) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  const participant = { id: socketId, name };
  room.participants.set(socketId, participant);
  return participant;
}

function removeParticipant(roomCode, socketId) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.participants.delete(socketId);
  if (room.speakerId === socketId) {
    room.speakerId = null;
  }
  if (room.participants.size === 0) {
    rooms.delete(roomCode);
  }
}

function getParticipants(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  return Array.from(room.participants.values());
}

function findRoomBySocket(socketId) {
  for (const [roomCode, room] of rooms.entries()) {
    if (room.participants.has(socketId)) return roomCode;
  }
  return null;
}

function setSpeaker(roomCode, socketId) {
  const room = rooms.get(roomCode);
  if (!room) return false;
  if (room.speakerId && room.speakerId !== socketId) return false; // someone else is already talking
  room.speakerId = socketId;
  return true;
}

function clearSpeaker(roomCode, socketId) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.speakerId === socketId) {
    room.speakerId = null;
  }
}

function getSpeakerName(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.speakerId) return null;
  const speaker = room.participants.get(room.speakerId);
  return speaker ? speaker.name : null;
}

module.exports = {
  MAX_ROOM_SIZE,
  createRoom,
  getRoom,
  roomExists,
  isRoomFull,
  isNameTaken,
  addParticipant,
  removeParticipant,
  getParticipants,
  findRoomBySocket,
  setSpeaker,
  clearSpeaker,
  getSpeakerName,
  sanitizeName,
  sanitizeRoomName,
};
