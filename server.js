// BE/server.js  — SmartInventoryX Cloud (DB tùy chọn)
// - Local: KHÔNG cần DATABASE_URL → dùng bộ nhớ tạm (in-memory)
// - Render: có DATABASE_URL → tự dùng PostgreSQL

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";

// PG là tùy chọn (chỉ khởi tạo khi có DATABASE_URL)
import pkg from "pg";

dotenv.config();

const {
  PORT = 5000,
  DATABASE_URL,
  DEVICE_KEY = "CHANGE_ME_DEVICE_KEY",
  WEB_ORIGIN = "*",
} = process.env;

const USE_DB = !!DATABASE_URL; // ← có DB thì true

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: WEB_ORIGIN, credentials: true },
});

app.use(cors({ origin: WEB_ORIGIN }));
app.options("*", cors());
app.use(express.json());

// ====== DB setup (optional) ======
let pool = null;
if (USE_DB) {
  const { Pool } = pkg;
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl:
      DATABASE_URL?.startsWith("postgres://") ||
      DATABASE_URL?.startsWith("postgresql://")
        ? { rejectUnauthorized: false }
        : false,
  });
  console.log("🗄️  DATABASE_URL detected → PostgreSQL mode");
} else {
  console.log("⚠️  No DATABASE_URL → using in-memory mode (data reset on restart)");
}

// ====== Health ======
app.get("/api/hello", (req, res) => res.json({ message: "Backend OK ✅" }));

// ====== Login demo ======
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === "admin" && password === "123456") {
    return res.json({ success: true, user: { username, role: "admin" } });
  }
  res.json({ success: false, message: "Sai tài khoản hoặc mật khẩu" });
});

// ====== In-memory fallbacks ======
const memory = {
  lots: new Map(),       // kho demo
  hwLogs: [],            // logs phần cứng demo
  nextId: 1,
};

// ====== RFID kho: nhập / xuất / xem ======
app.post("/api/add", (req, res) => {
  const { uid, ma_lo, ten, so_luong, nguoi } = req.body || {};
  if (!uid || !ma_lo || !ten || !so_luong) {
    return res.status(400).json({ ok: false, message: "Thiếu dữ liệu" });
  }
  const now = new Date().toISOString();
  memory.lots.set(uid, {
    uid,
    ma_lo,
    ten,
    so_luong_con_lai: Number(so_luong),
    ngay_nhap: now,
    trang_thai: "tồn kho",
    nguoi_nhap: nguoi || "unknown",
  });
  console.log("📥 Nhập kho:", memory.lots.get(uid));
  res.json({ ok: true });
});

app.post("/api/out", (req, res) => {
  const { uid, qty, nguoi } = req.body || {};
  if (!uid || !qty) return res.status(400).json({ ok: false, message: "Thiếu dữ liệu" });

  const cur = memory.lots.get(uid);
  if (!cur) return res.status(404).json({ ok: false, message: "Không tìm thấy UID" });

  cur.so_luong_con_lai = Math.max(0, Number(cur.so_luong_con_lai) - Number(qty));
  cur.trang_thai = cur.so_luong_con_lai === 0 ? "đã xuất hết" : "tồn kho";
  cur.nguoi_xuat_cuoi = nguoi || "unknown";
  memory.lots.set(uid, cur);

  console.log("📤 Xuất kho:", { uid, qty, remain: cur.so_luong_con_lai });
  res.json({ ok: true, remain: cur.so_luong_con_lai });
});

app.get("/api/stock", (req, res) => {
  res.json({ ok: true, data: Array.from(memory.lots.values()) });
});

// ====== Hardware logs: ESP32 gửi & web đọc ======
// POST: ESP32 gửi log (yêu cầu x-api-key)
app.post("/api/hardware/logs", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== DEVICE_KEY) {
      return res.status(401).json({ ok: false, message: "API key invalid" });
    }
    const { uid, value } = req.body || {};
    if (!uid || typeof value === "undefined") {
      return res.status(400).json({ ok: false, message: "uid & value required" });
    }

    if (USE_DB) {
      const q = `INSERT INTO hardware_logs(uid, value) VALUES ($1, $2) RETURNING id, uid, value, created_at`;
      const { rows } = await pool.query(q, [uid, value]);
      io.emit("hw_log", rows[0]); // realtime
      return res.json({ ok: true, data: rows[0] });
    } else {
      const row = {
        id: memory.nextId++,
        uid,
        value: Number(value),
        created_at: new Date().toISOString(),
      };
      memory.hwLogs.unshift(row);
      io.emit("hw_log", row);
      return res.json({ ok: true, data: row });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "server error" });
  }
});

// GET: web lấy lịch sử
app.get("/api/hardware/logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);
    if (USE_DB) {
      const { rows } = await pool.query(
        `SELECT id, uid, value, created_at FROM hardware_logs ORDER BY id DESC LIMIT $1`,
        [limit]
      );
      return res.json(rows);
    } else {
      return res.json(memory.hwLogs.slice(0, limit));
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// ====== Socket.IO ======
io.on("connection", (socket) => {
  console.log("🔌 Web client connected", socket.id);
  socket.on("disconnect", () => console.log("🔌 Web client disconnected", socket.id));
});

// ====== Start ======
httpServer.listen(PORT, async () => {
  console.log(`🚀 API: http://localhost:${PORT}`);

  // Nếu có DB: tạo bảng nếu chưa có
  if (USE_DB) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS hardware_logs (
          id SERIAL PRIMARY KEY,
          uid TEXT NOT NULL,
          value DOUBLE PRECISION,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      console.log("📦 DB ready");
    } catch (e) {
      console.error("❌ DB init error:", e.message);
    }
  } else {
    console.log("ℹ️ Running without DB (in-memory). Set DATABASE_URL to enable PostgreSQL.");
  }
});
