# Woki 🔊

**Talk. Release. Done.**

Woki is a simple internet walkie-talkie website. Create a room, share a 5-character code, and hold a button to talk — just like a real walkie-talkie, but over the internet on any phone browser.

No app store. No login. No accounts. Just open the site and talk.

---

## How it works

```
CREATE ROOM → GET CODE → SHARE CODE → JOIN ROOM → HOLD TALK → REAL-TIME VOICE → RELEASE → VOICE STOPS
```

- **Frontend** (`client/`) — a single self-contained `index.html` (all CSS and JS inlined), installable as a PWA.
- **Signaling server** (`server/`) — Node.js + Express + Socket.IO. It only exchanges the small WebRTC handshake messages (offer/answer/ICE candidates) and room membership. **It never sees or stores your voice.**
- **Voice** — real peer-to-peer audio using WebRTC (`getUserMedia` + `RTCPeerConnection`), so voice travels directly between phones once connected.

---

## Project structure

```
woki/
├── client/                   # Static frontend — deploy anywhere that serves static files
│   ├── index.html            # Everything: all screens + CSS + JS in one file
│   │                          #   (config, UI helpers, WebRTC logic, app state — all inlined)
│   │                          #   ⚠️ search for SIGNAL_SERVER_URL inside index.html to set your server
│   ├── manifest.json          # PWA manifest (must stay a separate file)
│   ├── sw.js                  # Service worker (must stay a separate file — browser requirement)
│   └── icons/                  # PWA icons
│
├── server/                   # Signaling server — deploy to any Node host
│   ├── server.js              # Express + Socket.IO event handlers
│   ├── roomManager.js         # In-memory room/participant state
│   ├── package.json
│   └── .env.example
│
├── package.json               # Convenience scripts for local dev
└── README.md
```

---

## 1. Local setup

### Requirements
- Node.js 18+
- Two phones (or a phone + laptop) on the same or different networks, each with a browser (Chrome, Safari, Firefox)

### Install & run the signaling server

```bash
cd server
cp .env.example .env
npm install
npm start
```

You should see: `Woki signaling server running on port 3001`

### Serve the frontend

In a second terminal, from the project root:

```bash
npx serve client -l 5500
```

(Any static file server works — `serve`, `live-server`, Python's `http.server`, etc.)

### Point the frontend at the server

Open `client/index.html` and find the `WOKI_CONFIG` block near the top of the inline `<script>`. For local testing the default already works:

```js
SIGNAL_SERVER_URL: "http://localhost:3001"   // auto-selected when hostname is localhost
```

Open `http://localhost:5500` in your browser. The status pill on the home screen should say **"Internet connected"**.

---

## 2. Testing with two phones

WebRTC needs a real network path between two devices, so `localhost` alone won't let two separate phones talk to each other — you need the server reachable from both phones. Two easy options:

**Option A — same Wi-Fi network (fastest for local testing)**
1. Find your computer's local IP (e.g. `192.168.1.20`).
2. In `server/.env`, set `CLIENT_ORIGIN=http://192.168.1.20:5500`, restart the server.
3. In `client/index.html`'s `WOKI_CONFIG`, temporarily point `SIGNAL_SERVER_URL` to `http://192.168.1.20:3001`.
4. On both phones, open `http://192.168.1.20:5500` (same Wi-Fi network).

**Option B — deploy it (recommended, works on any network)**
Follow the deployment steps below, then just open your deployed URL on both phones — this also covers users on *different* networks/carriers, which is the real-world case.

### The actual test

**Phone 1**
1. Open Woki → enter name → **Create Room**
2. Type a room name → **Create Room**
3. Tap **Copy Code** (or **Share Room**)
4. Tap **Enter Room**

**Phone 2**
1. Open Woki → enter name → **Join Room**
2. Paste/enter the room code → **Join Room**

**Now test the walkie-talkie:**
- Phone 1 presses and holds **TALK**, says something, and releases → Phone 2 should hear it and see "Phone 1's name is speaking" with a waveform animation.
- Repeat from Phone 2 → Phone 1 should hear it.
- Try both releasing quickly — audio should cut off immediately, not linger.
- Background one phone's browser tab mid-transmission — transmission should stop automatically (no stuck mic).

---

## 3. Environment variables

### `server/.env`

| Variable | Description | Example |
|---|---|---|
| `PORT` | Port the signaling server listens on | `3001` |
| `CLIENT_ORIGIN` | Comma-separated list of allowed frontend origins (CORS) | `https://woki.vercel.app,http://localhost:5500` |
| `MAX_ROOM_SIZE` | Max participants per room | `8` |

### `client/config.js`

Not an env file (it's a static site), but it has one setting you must edit before deploying:

```js
SIGNAL_SERVER_URL: "https://your-signaling-server.onrender.com"
```

No API keys or secrets are ever needed in the frontend — the only third-party services used (STUN servers) are public and keyless.

---

## 4. Deployment

### Backend (signaling server) — Render, Railway, Fly.io, or any Node host

Using **Render** as an example:
1. Push this repo to GitHub.
2. Create a new **Web Service** on Render, point it at the repo, set the root directory to `server/`.
3. Build command: `npm install` · Start command: `npm start`
4. Add environment variables from the table above (set `CLIENT_ORIGIN` to your deployed frontend URL — you'll fill this in after step 5).
5. Deploy. Note the resulting URL, e.g. `https://woki-server.onrender.com`.

### Frontend — Vercel, Netlify, or any static host

Using **Vercel** as an example:
1. Before deploying, edit the `WOKI_CONFIG` block inside `client/index.html` and replace `"https://YOUR-SIGNALING-SERVER-URL"` with your real backend URL from step 5 above.
2. Import the repo into Vercel, set the root directory to `client/`.
3. Framework preset: **Other** (it's static HTML/CSS/JS — no build step needed).
4. Deploy. Note the resulting URL, e.g. `https://woki.vercel.app`.
5. Go back to your backend host and set `CLIENT_ORIGIN=https://woki.vercel.app`, then redeploy the backend so CORS allows it.

### Important
The signaling server is a **long-running WebSocket process** — it must stay online continuously (not a serverless function), since Socket.IO connections are persistent. Render/Railway/Fly.io all support this; typical serverless platforms (plain Vercel/Netlify functions) do not.

---

## 5. Adding a TURN server later (for stricter networks)

STUN alone (already configured) works for most users. Some networks — strict corporate Wi-Fi, some mobile carriers with symmetric NAT — need a TURN relay to connect. To add one later, just extend the `ICE_SERVERS` list inside `WOKI_CONFIG` in `client/index.html`:

```js
ICE_SERVERS: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:your-turn-server.com:3478", username: "user", credential: "pass" },
]
```

No other code changes are needed — `webrtc.js` already reads `ICE_SERVERS` from config.

---

## 6. What Woki intentionally does NOT do

- No accounts, login, or profiles
- No chat, no voice recordings, no history
- No data stored beyond the current session (rooms live in server memory and disappear when empty)
- No tracking, no ads, no payments

---

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Connection lost" never clears | Signaling server isn't reachable — check `SIGNAL_SERVER_URL` and that the server is running |
| Mic permission prompt never appears | Site must be served over `https://` (or `localhost`) — browsers block mic access on plain `http://` for anything else |
| Two phones connect but can't hear each other | Likely a strict NAT — add a TURN server (see above) |
| "Room not found" | Room codes are case-insensitive but must match exactly, and rooms disappear once everyone leaves |
