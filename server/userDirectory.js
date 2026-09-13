// userDirectory.js
// A simple in-memory "who's who" for direct number-to-number calling.
// Not a real accounts system - there's no password or SMS verification,
// just "this phone number currently belongs to this browser session".
//
// IMPORTANT: this lives in server memory only. If the server restarts
// (e.g. a free-tier host spinning down after inactivity), everyone's
// registration and saved push subscription is lost until they open the
// app again - the client re-registers automatically on every reconnect
// to make this resilient in practice.

/** phone -> { phone, name, socketId, pushSubscription } */
const users = new Map();

function sanitizePhone(phone) {
  if (typeof phone !== "string") return "";
  // Keep digits and a single leading "+"; strip everything else
  // (spaces, dashes, parentheses) so the same number always matches.
  const trimmed = phone.trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/\D/g, "");
  return (plus + digits).slice(0, 16);
}

function sanitizeName(name) {
  if (typeof name !== "string") return "";
  return name.trim().slice(0, 20);
}

function register(phone, name, socketId) {
  const cleanPhone = sanitizePhone(phone);
  if (!cleanPhone) return null;
  const existing = users.get(cleanPhone);
  const record = {
    phone: cleanPhone,
    name: sanitizeName(name) || (existing ? existing.name : "Someone"),
    socketId,
    pushSubscription: existing ? existing.pushSubscription : null,
  };
  users.set(cleanPhone, record);
  return record;
}

function getByPhone(phone) {
  return users.get(sanitizePhone(phone)) || null;
}

function getBySocketId(socketId) {
  for (const record of users.values()) {
    if (record.socketId === socketId) return record;
  }
  return null;
}

function savePushSubscription(phone, subscription) {
  const record = getByPhone(phone);
  if (!record) return false;
  record.pushSubscription = subscription || null;
  return true;
}

function clearPushSubscription(phone) {
  const record = getByPhone(phone);
  if (record) record.pushSubscription = null;
}

function markOffline(socketId) {
  const record = getBySocketId(socketId);
  if (record) record.socketId = null; // keep name + push subscription for later calls
}

module.exports = {
  sanitizePhone,
  sanitizeName,
  register,
  getByPhone,
  getBySocketId,
  savePushSubscription,
  clearPushSubscription,
  markOffline,
};
