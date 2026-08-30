RUSTAYIOS STORE — INDEX.JS DUY NHAT
====================================

Dưới đây là TOÀN BỘ index.js. Copy nguyên khối này vào file index.js.

DEPENDENCIES:
telegraf
express
better-sqlite3
dotenv

ENV:
BOT_TOKEN=BOT_TOKEN
ADMIN_IDS=TELEGRAM_ID_ADMIN
SHOP_NAME=RUSTAYIOS.STORE
CURRENCY=₫
BANK_NAME=TEN_NGAN_HANG
BANK_ACCOUNT=SO_TAI_KHOAN
BANK_OWNER=TEN_CHU_TAI_KHOAN
PAYMENT_PREFIX=RUSTAY
SEPAY_WEBHOOK_SECRET=SECRET_SEPAY
PORT=3000
ADMIN_USERNAME=USERNAME_ADMIN

SEPAY WEBHOOK:
https://DOMAIN-CUA-BAN/webhook/sepay

NOTE:
GitHub chỉ lưu code; index.js vẫn cần môi trường Node.js để chạy.
Không đưa BOT_TOKEN/SEPAY_WEBHOOK_SECRET lên repository công khai.

============================================================
FULL index.js
============================================================

import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN chưa được cấu hình");

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "").split(",").map(Number).filter(Boolean)
);
const SHOP = process.env.SHOP_NAME || "RUSTAYIOS.STORE";
const CURRENCY = process.env.CURRENCY || "₫";
const PREFIX = (process.env.PAYMENT_PREFIX || "RUSTAY").toUpperCase();
const PORT = Number(process.env.PORT || 3000);

fs.mkdirSync("data", { recursive: true });
const db = new Database("data/shop.sqlite");
db.pragma("journal_mode=WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY,
 username TEXT,
 first_name TEXT,
 balance INTEGER NOT NULL DEFAULT 0,
 blocked INTEGER NOT NULL DEFAULT 0,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 description TEXT DEFAULT '',
 price INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inventory(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 product_id INTEGER NOT NULL,
 item TEXT NOT NULL,
 sold INTEGER NOT NULL DEFAULT 0,
 sold_to INTEGER,
 sold_at TEXT
);
CREATE TABLE IF NOT EXISTS orders(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 product_id INTEGER NOT NULL,
 price INTEGER NOT NULL,
 delivery TEXT NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 type TEXT NOT NULL,
 amount INTEGER NOT NULL,
 note TEXT DEFAULT '',
 external_id TEXT UNIQUE,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS deposits(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 code TEXT UNIQUE NOT NULL,
 amount INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 sepay_id TEXT UNIQUE,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 paid_at TEXT
);
`);

const q = sql => db.prepare(sql);
const money = n => `${Number(n).toLocaleString("vi-VN")}${CURRENCY}`;
const isAdmin = id => ADMIN_IDS.has(id);

function upsertUser(u) {
  q(`INSERT INTO users(id,username,first_name) VALUES(?,?,?)
     ON CONFLICT(id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name`)
    .run(u.id, u.username || "", u.first_name || "");
}
function user(id) { return q("SELECT * FROM users WHERE id=?").get(id); }
function product(id) {
  return q(`SELECT p.*,COALESCE(
    (SELECT COUNT(*) FROM inventory i WHERE i.product_id=p.id AND i.sold=0),0
  ) stock FROM products p WHERE p.id=?`).get(id);
}
function activeProducts() {
  return q(`SELECT p.*,COALESCE(
    (SELECT COUNT(*) FROM inventory i WHERE i.product_id=p.id AND i.sold=0),0
  ) stock FROM products p WHERE p.active=1 ORDER BY p.id DESC`).all();
}
function allProducts() {
  return q(`SELECT p.*,COALESCE(
    (SELECT COUNT(*) FROM inventory i WHERE i.product_id=p.id AND i.sold=0),0
  ) stock FROM products p ORDER BY p.id DESC`).all();
}
function addProduct(name, desc, price) {
  return q("INSERT INTO products(name,description,price) VALUES(?,?,?)")
    .run(name, desc, price).lastInsertRowid;
}
function addStock(productId, items) {
  const st = q("INSERT INTO inventory(product_id,item) VALUES(?,?)");
  db.transaction(() => items.filter(Boolean).forEach(x => st.run(productId, x.trim())))();
}
function changePrice(id, price) {
  q("UPDATE products SET price=? WHERE id=?").run(price, id);
}
function toggleProduct(id) {
  q("UPDATE products SET active=CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=?").run(id);
}
function setBlocked(id, value) {
  q("UPDATE users SET blocked=? WHERE id=?").run(value ? 1 : 0, id);
}
function credit(id, amount, note="Admin credit", externalId=null) {
  db.transaction(() => {
    q("UPDATE users SET balance=balance+? WHERE id=?").run(amount, id);
    q("INSERT INTO transactions(user_id,type,amount,note,external_id) VALUES(?,?,?,?,?)")
      .run(id, "credit", amount, note, externalId);
  })();
}
function createDeposit(uid, code, amount) {
  q("INSERT INTO deposits(user_id,code,amount) VALUES(?,?,?)").run(uid, code, amount);
}
function payDeposit(code, sepayId, amount) {
  return db.transaction(() => {
    const d = q("SELECT * FROM deposits WHERE code=?").get(code);
    if (!d || d.status !== "pending") return { ok:false };
    if (Number(d.amount) !== Number(amount)) return { ok:false, reason:"amount" };
    if (sepayId && q("SELECT 1 FROM deposits WHERE sepay_id=?").get(String(sepayId)))
      return { ok:false, reason:"duplicate" };

    q("UPDATE deposits SET status='paid',sepay_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(String(sepayId || ""), d.id);
    q("UPDATE users SET balance=balance+? WHERE id=?").run(d.amount, d.user_id);
    q(`INSERT INTO transactions(user_id,type,amount,note,external_id)
       VALUES(?,?,?,?,?)`)
      .run(d.user_id, "credit", d.amount, `SePay ${d.code}`, `sepay:${sepayId}`);

    return { ok:true, userId:d.user_id, amount:d.amount };
  })();
}
function buy(uid, pid) {
  return db.transaction(() => {
    const u = user(uid), p = product(pid);
    if (!u || !p || !p.active) throw Error("NOT_FOUND");
    if (u.blocked) throw Error("BLOCKED");
    if (u.balance < p.price) throw Error("LOW_BALANCE");

    const item = q(`SELECT * FROM inventory
      WHERE product_id=? AND sold=0 ORDER BY id LIMIT 1`).get(pid);
    if (!item) throw Error("OUT");

    q("UPDATE users SET balance=balance-? WHERE id=?").run(p.price, uid);
    q(`UPDATE inventory SET sold=1,sold_to=?,sold_at=CURRENT_TIMESTAMP
       WHERE id=?`).run(uid, item.id);

    const orderId = q(`INSERT INTO orders(user_id,product_id,price,delivery)
      VALUES(?,?,?,?)`).run(uid,pid,p.price,item.item).lastInsertRowid;

    q(`INSERT INTO transactions(user_id,type,amount,note)
      VALUES(?,?,?,?)`).run(uid,"debit",-p.price,`Order #${orderId}`);

    return {
      id:orderId, name:p.name, price:p.price,
      delivery:item.item, remaining:u.balance-p.price
    };
  })();
}

const bot = new Telegraf(BOT_TOKEN);
const pendingDeposit = new Map();

function homeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🛒 MUA HÀNG","shop")],
    [Markup.button.callback("💳 NẠP TIỀN","deposit"),
     Markup.button.callback("📦 ĐƠN HÀNG","history")],
    [Markup.button.callback("👤 TÀI KHOẢN","account")],
    [Markup.button.callback("💬 LIÊN HỆ ADMIN","support")]
  ]);
}

bot.start(ctx => {
  upsertUser(ctx.from);
  return ctx.reply(
    `🤖 ${SHOP}\n\n👤 UID: ${ctx.from.id}\n💰 Số dư: ${money(user(ctx.from.id).balance)}\n\nChọn chức năng:`,
    homeKeyboard()
  );
});

bot.action("home", async ctx => {
  const u=user(ctx.from.id);
  await ctx.editMessageText(
    `🤖 ${SHOP}\n\n👤 UID: ${u.id}\n💰 Số dư: ${money(u.balance)}\n\nChọn chức năng:`,
    homeKeyboard()
  );
});

bot.action("account", async ctx => {
  const u=user(ctx.from.id);
  await ctx.editMessageText(
    `👤 TÀI KHOẢN\n\nUID: ${u.id}\nUsername: @${u.username||"none"}\n💰 Số dư: ${money(u.balance)}`,
    Markup.inlineKeyboard([[Markup.button.callback("🔙 Quay lại","home")]])
  );
});

bot.action("shop", async ctx => {
  const ps=activeProducts();
  const rows=ps.map(p=>[
    Markup.button.callback(`${p.name} • ${money(p.price)} • Kho ${p.stock}`,`p:${p.id}`)
  ]);
  rows.push([Markup.button.callback("🔙 Quay lại","home")]);
  await ctx.editMessageText(
    ps.length ? "🛒 CỬA HÀNG\n\n👇 Chọn sản phẩm:" : "🛒 CỬA HÀNG\n\nChưa có sản phẩm.",
    Markup.inlineKeyboard(rows)
  );
});

bot.action(/^p:(\d+)$/, async ctx => {
  const p=product(Number(ctx.match[1]));
  if(!p) return ctx.answerCbQuery("Không tìm thấy sản phẩm");
  await ctx.editMessageText(
    `📦 ${p.name}\n\n${p.description||"Không có mô tả"}\n\n💰 Giá: ${money(p.price)}\n📦 Kho: ${p.stock}\n🚚 Giao hàng: tự động`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🛒 MUA NGAY",`buy:${p.id}`)],
      [Markup.button.callback("🔙 Quay lại","shop")]
    ])
  );
});

bot.action(/^buy:(\d+)$/, async ctx => {
  try {
    const r=buy(ctx.from.id,Number(ctx.match[1]));
    await ctx.editMessageText(
      `✅ THANH TOÁN THÀNH CÔNG\n\n📦 ${r.name}\n💰 Giá: ${money(r.price)}\n💰 Số dư: ${money(r.remaining)}\n\n🔑 SẢN PHẨM:\n${r.delivery}\n\n🧾 Đơn #${r.id}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🛒 Tiếp tục mua","shop")],
        [Markup.button.callback("📦 Đơn hàng","history")],
        [Markup.button.callback("🏠 Trang chủ","home")]
      ])
    );
  } catch(e) {
    const msg={
      LOW_BALANCE:"❌ Số dư không đủ. Hãy nạp tiền.",
      OUT:"❌ Sản phẩm đã hết kho.",
      BLOCKED:"⛔ Tài khoản bị khóa.",
      NOT_FOUND:"❌ Không tìm thấy sản phẩm."
    }[e.message] || "❌ Giao dịch thất bại.";
    await ctx.answerCbQuery(msg,{show_alert:true});
  }
});

bot.action("history", async ctx => {
  const os=q(`SELECT o.*,p.name FROM orders o JOIN products p ON p.id=o.product_id
              WHERE o.user_id=? ORDER BY o.id DESC LIMIT 20`).all(ctx.from.id);
  let t="📦 LỊCH SỬ ĐƠN HÀNG\n\n";
  if(!os.length) t+="Chưa có đơn hàng.";
  else for(const o of os) t+=`#${o.id} • ${o.name} • ${money(o.price)}\n${o.created_at}\n\n`;
  await ctx.editMessageText(t,Markup.inlineKeyboard([[Markup.button.callback("🔙 Quay lại","home")]]));
});

bot.action("deposit", async ctx => {
  pendingDeposit.set(ctx.from.id,true);
  await ctx.editMessageText(
    "💳 NẠP TIỀN\n\nNhập số tiền muốn nạp bằng VNĐ.\nVí dụ: 150000\n\nGiới hạn: 1.000₫ → 50.000.000₫",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Hủy","home")]])
  );
});

bot.on("text", async ctx => {
  if(!pendingDeposit.get(ctx.from.id)) return;

  const raw=ctx.message.text.replace(/[.,₫\s]/g,"");
  const amount=Number(raw);

  if(!Number.isInteger(amount)||amount<1000||amount>50000000)
    return ctx.reply("❌ Số tiền không hợp lệ. Nhập từ 1.000 đến 50.000.000.");

  pendingDeposit.delete(ctx.from.id);

  const code=`${PREFIX}${ctx.from.id}${Date.now().toString().slice(-6)}`;
  createDeposit(ctx.from.id,code,amount);

  const bank=process.env.BANK_NAME||"";
  const acc=process.env.BANK_ACCOUNT||"";
  const owner=process.env.BANK_OWNER||"";

  // VietQR public URL; if your provider changes, replace this URL builder.
  const qr=`https://img.vietqr.io/image/${encodeURIComponent(bank)}-${encodeURIComponent(acc)}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(code)}&accountName=${encodeURIComponent(owner)}`;

  const caption=
`💳 NẠP ${money(amount)}

🏦 Ngân hàng: ${bank}
💳 STK: ${acc}
👤 Chủ TK: ${owner}
💰 Số tiền: ${money(amount)}
📝 Nội dung: ${code}

Chuyển đúng số tiền và đúng nội dung.
SePay sẽ tự xác nhận và cộng số dư.`;

  await ctx.replyWithPhoto(qr,{
    caption,
    reply_markup:Markup.inlineKeyboard([[Markup.button.callback("🏠 Trang chủ","home")]])
  });
});

bot.action("support", async ctx => {
  await ctx.editMessageText(
    `💬 LIÊN HỆ ADMIN\n\nAdmin: @${process.env.ADMIN_USERNAME||"your_admin"}`,
    Markup.inlineKeyboard([[Markup.button.callback("🔙 Quay lại","home")]])
  );
});

// ADMIN
bot.command("admin", async ctx => {
  if(!isAdmin(ctx.from.id)) return ctx.reply("⛔ Không có quyền.");
  await ctx.reply("👑 ADMIN PANEL",Markup.inlineKeyboard([
    [Markup.button.callback("📊 THỐNG KÊ","a:stats")],
    [Markup.button.callback("📦 SẢN PHẨM / KHO","a:products")],
    [Markup.button.callback("👥 NGƯỜI DÙNG","a:users")],
    [Markup.button.callback("💳 GIAO DỊCH","a:tx")]
  ]));
});

bot.action("a:stats",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  const s={
    users:q("SELECT COUNT(*) c FROM users").get().c,
    products:q("SELECT COUNT(*) c FROM products").get().c,
    orders:q("SELECT COUNT(*) c FROM orders").get().c,
    revenue:q("SELECT COALESCE(SUM(price),0) s FROM orders").get().s
  };
  return ctx.reply(`📊 THỐNG KÊ\n\n👥 Users: ${s.users}\n📦 Products: ${s.products}\n🧾 Orders: ${s.orders}\n💰 Doanh thu: ${money(s.revenue)}`);
});

bot.action("a:products",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  let t="📦 SẢN PHẨM / KHO\n\n";
  for(const p of allProducts())
    t+=`#${p.id} ${p.name} | ${money(p.price)} | kho ${p.stock} | ${p.active?"ON":"OFF"}\n`;
  return ctx.reply(t+
`\nLỆNH:
 /addproduct Tên | Mô tả | Giá
 /stock ID | ITEM1 | ITEM2
 /setprice ID GIÁ
 /toggle ID`);
});

bot.action("a:users",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  let t="👥 NGƯỜI DÙNG\n\n";
  for(const u of q("SELECT id,username,balance,blocked FROM users ORDER BY id DESC LIMIT 50").all())
    t+=`${u.id} @${u.username||"-"} • ${money(u.balance)} • ${u.blocked?"BLOCK":"OK"}\n`;
  return ctx.reply(t+"\n/credit USER_ID AMOUNT\n/block USER_ID\n/unblock USER_ID");
});

bot.action("a:tx",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  let t="💳 GIAO DỊCH\n\n";
  for(const x of q("SELECT * FROM transactions ORDER BY id DESC LIMIT 50").all())
    t+=`#${x.id} • ${x.user_id} • ${x.type} • ${money(x.amount)} • ${x.note}\n`;
  return ctx.reply(t);
});

bot.command("addproduct",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  const [name,desc,price]=ctx.message.text.replace("/addproduct","").trim().split("|").map(x=>x.trim());
  if(!name||!price) return ctx.reply("Dùng: /addproduct Tên | Mô tả | Giá");
  const p=Number(price);
  if(!Number.isInteger(p)||p<0) return ctx.reply("Giá không hợp lệ.");
  return ctx.reply(`✅ Đã tạo sản phẩm #${addProduct(name,desc||"",p)}`);
});

bot.command("stock",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  const a=ctx.message.text.replace("/stock","").trim().split("|").map(x=>x.trim());
  const id=Number(a.shift());
  if(!id||!a.length) return ctx.reply("Dùng: /stock ID | ITEM1 | ITEM2");
  if(!product(id)) return ctx.reply("Không tồn tại sản phẩm.");
  addStock(id,a);
  return ctx.reply(`✅ Đã nhập ${a.length} item.`);
});

bot.command("setprice",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  const [,id,price]=ctx.message.text.trim().split(/\s+/);
  if(!id||!price) return ctx.reply("Dùng: /setprice ID GIÁ");
  changePrice(Number(id),Number(price));
  return ctx.reply("✅ Đã đổi giá.");
});

bot.command("toggle",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  const [,id]=ctx.message.text.trim().split(/\s+/);
  toggleProduct(Number(id));
  return ctx.reply("✅ Đã đổi trạng thái.");
});

bot.command("credit",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  const [,id,amount]=ctx.message.text.trim().split(/\s+/);
  if(!id||!amount) return ctx.reply("Dùng: /credit USER_ID AMOUNT");
  credit(Number(id),Number(amount));
  return ctx.reply("✅ Đã cộng tiền.");
});

bot.command("block",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  const [,id]=ctx.message.text.trim().split(/\s+/);
  setBlocked(Number(id),true);
  return ctx.reply("✅ Đã khóa.");
});

bot.command("unblock",ctx=>{
  if(!isAdmin(ctx.from.id)) return;
  const [,id]=ctx.message.text.trim().split(/\s+/);
  setBlocked(Number(id),false);
  return ctx.reply("✅ Đã mở khóa.");
});

// SePay webhook
const app=express();
app.get("/",(_,res)=>res.json({ok:true,shop:SHOP}));

app.post("/webhook/sepay",express.raw({type:"application/json"}),(req,res)=>{
  try{
    const secret=process.env.SEPAY_WEBHOOK_SECRET;
    if(!secret) return res.status(500).json({success:false});

    const signature=req.get("X-SePay-Signature")||"";
    const timestamp=req.get("X-SePay-Timestamp")||"";
    const age=Math.abs(Math.floor(Date.now()/1000)-Number(timestamp));
    if(!timestamp||!Number.isFinite(Number(timestamp))||age>300)
      return res.status(401).json({success:false,message:"expired"});

    const expected="sha256="+crypto
      .createHmac("sha256",secret)
      .update(`${timestamp}.${req.body.toString("utf8")}`)
      .digest("hex");

    if(signature.length!==expected.length ||
       !crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))
      return res.status(401).json({success:false,message:"invalid signature"});

    const p=JSON.parse(req.body.toString("utf8"));
    if(String(p.transferType||"").toLowerCase()!=="in")
      return res.json({success:true});

    const content=String(p.content||"").toUpperCase();
    const codeField=String(p.code||"").toUpperCase();
    const match=(codeField.match(new RegExp(`\\b${PREFIX}[A-Z0-9]+\\b`))||
                 content.match(new RegExp(`\\b${PREFIX}[A-Z0-9]+\\b`)));

    if(!match) return res.json({success:true});

    const result=payDeposit(match[0],p.id,p.transferAmount);
    if(result.ok){
      const u=user(result.userId);
      bot.telegram.sendMessage(
        result.userId,
        `✅ NẠP TIỀN THÀNH CÔNG\n\n💰 +${money(result.amount)}\n💰 Số dư mới: ${money(u.balance)}`
      ).catch(()=>{});
    }
    return res.json({success:true});
  }catch(e){
    console.error(e);
    return res.status(400).json({success:false});
  }
});

app.listen(PORT,()=>console.log(`HTTP server listening on ${PORT}`));
bot.launch().then(()=>console.log(`${SHOP} bot online`));
process.once("SIGINT",()=>bot.stop("SIGINT"));
process.once("SIGTERM",()=>bot.stop("SIGTERM"));
