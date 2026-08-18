const ADMIN_ID = "7424477198";

function isAdmin(userId) {
  return String(userId) === ADMIN_ID;
}
const PRODUCTS = [
  ["fluorite","Fluorite"],["migui-lite","Migui Lite"],["migui-pro","Migui Pro"],["drip-client","Drip Client"],
  ["esign","Chứng Chỉ Esign"],["8bp-fluorite","8BP_Fluorite"],["proxy-android","Proxy Androi"],["lien-quan","Liên Quân"],
  ["tipa-sudo","Tipa FF Sudo"],["tipa-iosviet","Tipa FF IosViet"],["migui-global","Migui Global"],["fl0rk-ff","Fl0rk FF"],
  ["proxy-ios","Proxy Ios"],["play-together","Play Together VNG"]
];

const DEFAULT_ITEMS = [
  ["1 Giờ",10000,1273],["1 Ngày",65000,1273],["7 Ngày",215000,1273],["31 Ngày",450000,1273]
];

const enc = new TextEncoder();
const money = n => Number(n || 0).toLocaleString("vi-VN") + "đ";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const rid = prefix => prefix + crypto.randomUUID().replace(/-/g,"").slice(0,10).toUpperCase();
const nowISO = () => new Date().toISOString();
const addMin = min => new Date(Date.now()+min*60000).toISOString();

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)
  });
  const j=await r.json();
  if(!j.ok) throw new Error(`Telegram ${method}: ${j.description||r.status}`);
  return j.result;
}

async function ensureSeed(env) {
  const c=await env.DB.prepare("SELECT COUNT(*) c FROM products").first();
  if(c.c) return;
  const stmts=[];
  PRODUCTS.forEach(([id,name],i)=>{
    stmts.push(env.DB.prepare("INSERT INTO products(id,name,sort_order) VALUES(?,?,?)").bind(id,name,i));
    DEFAULT_ITEMS.forEach(([title,price,stock],j)=>{
      stmts.push(env.DB.prepare("INSERT INTO product_items(id,product_id,title,price,stock,sort_order) VALUES(?,?,?,?,?,?)")
        .bind(`${id}-${j+1}`,id,title,price,stock,j));
    });
  });
  for(let i=0;i<stmts.length;i+=40) await env.DB.batch(stmts.slice(i,i+40));
}

async function ensureUser(env, from) {
  await env.DB.prepare(`INSERT INTO users(telegram_id,username,first_name)
    VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name`)
    .bind(String(from.id), from.username||"", from.first_name||"").run();
  return env.DB.prepare("SELECT * FROM users WHERE telegram_id=?").bind(String(from.id)).first();
}

function homeKeyboard(){
  return {inline_keyboard:[
    [{text:"🛍️ Mua Key / Acc FF",callback_data:"buy"},{text:"💳 Nạp Tiền",callback_data:"deposit"}],
    [{text:"💎 Cá Nhân",callback_data:"profile"},{text:"🏆 Top Nạp",callback_data:"top"}],
    [{text:"📜 Lịch Sử Nạp",callback_data:"history"},{text:"🧑‍💻 Hỗ Trợ",callback_data:"support"}]
  ]};
}

function homeText(env, name="bạn"){
  return `🎉 <b>Chào mừng ${esc(name)} đến với ${esc(env.SHOP_NAME)}!</b>\n\nVui lòng chọn chức năng bên dưới để tiếp tục.`;
}

async function sendOrEdit(env, chatId, messageId, text, keyboard) {
  const body={chat_id:chatId,text,parse_mode:"HTML",reply_markup:keyboard};
  if(messageId) {
    try{return await tg(env,"editMessageText",{...body,message_id:messageId});}
    catch(e){ if(!String(e.message).includes("message is not modified")) throw e; return null; }
  }
  return tg(env,"sendMessage",body);
}

async function showHome(env, chatId, messageId, name) {
  return sendOrEdit(env,chatId,messageId,homeText(env,name),homeKeyboard());
}

async function showProducts(env,chatId,messageId) {
  const ps=await env.DB.prepare("SELECT id,name,emoji FROM products WHERE active=1 ORDER BY sort_order").all();
  const rows=[];
  for(let i=0;i<ps.results.length;i+=2) rows.push(ps.results.slice(i,i+2).map(p=>({text:`${p.emoji} ${p.name}`,callback_data:`p:${p.id}`})));
  rows.push([{text:"⬅️ Quay Lại",callback_data:"home"}]);
  return sendOrEdit(env,chatId,messageId,
    `🛍️ <b>DANH SÁCH SẢN PHẨM</b>\n\nChào mừng bạn đến với cửa hàng! Vui lòng chọn danh mục bên dưới để xem chi tiết:`,
    {inline_keyboard:rows});
}

async function showProduct(env,chatId,messageId,productId) {
  const product=await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(productId).first();
  const items=await env.DB.prepare("SELECT * FROM product_items WHERE product_id=? ORDER BY sort_order").bind(productId).all();
  if(!product) throw new Error("Không tìm thấy sản phẩm");
  const rows=items.results.map(x=>[
    {text:`💎 ${product.name} ${x.title}`,callback_data:`i:${x.id}`},
    {text:`💰 ${money(x.price)}`,callback_data:"noop"},
    {text:`📦 Kho: ${x.stock}`,callback_data:"noop"}
  ]);
  rows.push([{text:"⬅️ Quay Lại",callback_data:"buy"}]);
  return sendOrEdit(env,chatId,messageId,
    `📁 <b>Mục: ${esc(product.name)}</b>\n\nChọn mục muốn mua. Giá và số lượng còn trong kho được hiển thị bên cạnh.`,
    {inline_keyboard:rows});
}

async function showItem(env,chatId,messageId,itemId) {
  const row=await env.DB.prepare(`SELECT i.*,p.name product_name FROM product_items i JOIN products p ON p.id=i.product_id WHERE i.id=?`).bind(itemId).first();
  if(!row) throw new Error("Không tìm thấy mục");
  const text=`📦 <b>THÔNG TIN SẢN PHẨM</b>\n━━━━━━━━━━━━\n\n🏷️ Tên: <b>${esc(row.product_name)} ${esc(row.title)}</b>\n💰 Giá: <b>${money(row.price)}</b>\n📊 Số lượng trong kho: <b>${row.stock}</b>\n\n👇 Chọn nút bên dưới để mua sản phẩm.`;
  return sendOrEdit(env,chatId,messageId,text,{inline_keyboard:[
    [{text:"🛒 MUA NGAY",callback_data:`confirm:${itemId}`}],
    [{text:"⬅️ Quay Lại",callback_data:`p:${row.product_id}`}]
  ]});
}

async function buyItem(env, chatId, messageId, userId, itemId) {
  const result=await env.DB.batch([
    env.DB.prepare("SELECT balance FROM users WHERE telegram_id=?").bind(String(userId)),
    env.DB.prepare(`SELECT i.*,p.name product_name FROM product_items i JOIN products p ON p.id=i.product_id WHERE i.id=?`).bind(itemId)
  ]);
  const user=result[0].results[0], item=result[1].results[0];
  if(!user||!item) throw new Error("Dữ liệu không tồn tại");
  if(item.stock<=0) return sendOrEdit(env,chatId,messageId,`❌ <b>SẢN PHẨM ĐÃ HẾT HÀNG</b>\n\nVui lòng chọn sản phẩm khác.`,{inline_keyboard:[[ {text:"⬅️ Quay Lại",callback_data:`p:${item.product_id}`} ]]});
  if(Number(user.balance)<Number(item.price)) {
    const missing=Number(item.price)-Number(user.balance);
    return sendOrEdit(env,chatId,messageId,
      `❌ <b>SỐ DƯ KHÔNG ĐỦ</b>\n\n💳 Số dư hiện tại: <b>${money(user.balance)}</b>\n💰 Giá sản phẩm: <b>${money(item.price)}</b>\n➖ Vui lòng nạp thêm: <b>${money(missing)}</b>`,
      {inline_keyboard:[[ {text:"💳 Nạp Tiền",callback_data:"deposit"} ],[{text:"⬅️ Quay Lại",callback_data:`i:${itemId}`}]]});
  }

  // Atomic conditional update: prevents negative balance/stock under concurrent clicks.
  const orderId=rid("ORD");
  const out=await env.DB.batch([
    env.DB.prepare("UPDATE users SET balance=balance-?, total_spent=total_spent+? WHERE telegram_id=? AND balance>=?")
      .bind(item.price,item.price,String(userId),item.price),
    env.DB.prepare("UPDATE product_items SET stock=stock-1 WHERE id=? AND stock>0").bind(itemId)
  ]);
  if(out[0].meta.changes!==1 || out[1].meta.changes!==1) {
    // Compensate if only one conditional update succeeded.
    if(out[0].meta.changes===1 && out[1].meta.changes!==1)
      await env.DB.prepare("UPDATE users SET balance=balance+?,total_spent=total_spent-? WHERE telegram_id=?").bind(item.price,item.price,String(userId)).run();
    if(out[1].meta.changes===1 && out[0].meta.changes!==1)
      await env.DB.prepare("UPDATE product_items SET stock=stock+1 WHERE id=?").bind(itemId).run();
    return sendOrEdit(env,chatId,messageId,"⚠️ Số dư hoặc kho vừa thay đổi. Vui lòng thử lại.",{inline_keyboard:[[ {text:"🔄 Xem lại",callback_data:`i:${itemId}`} ]]});
  }
  await env.DB.prepare("INSERT INTO purchases(id,telegram_id,product_item_id,product_name,item_title,price) VALUES(?,?,?,?,?,?)")
    .bind(orderId,String(userId),itemId,item.product_name,item.title,item.price).run();
  return sendOrEdit(env,chatId,messageId,
    `✅ <b>MUA HÀNG THÀNH CÔNG</b>\n\n📦 Sản phẩm: <b>${esc(item.product_name)} ${esc(item.title)}</b>\n💰 Đã thanh toán: <b>${money(item.price)}</b>\n🧾 Mã đơn: <code>${orderId}</code>\n\n📩 <b>Vui lòng ib Admin ${esc(env.ADMIN_USERNAME)} để lấy key.</b>`,
    {inline_keyboard:[[ {text:"🛍️ Mua Thêm",callback_data:"buy"} ],[{text:"🏠 Trang Chủ",callback_data:"home"}]]});
}

async function promptDeposit(env,chatId,messageId,userId) {
  await env.DB.prepare("DELETE FROM deposits WHERE telegram_id=? AND status='INPUT'").bind(String(userId)).run();
  await env.DB.prepare("INSERT INTO deposits(id,telegram_id,amount,content,status,expires_at) VALUES(?,?,?,?,?,?)")
    .bind(rid("INPUT"),String(userId),0,"INPUT","INPUT",addMin(5)).run();
  return sendOrEdit(env,chatId,messageId,
    `💳 <b>NẠP TIỀN</b>\n\nNhập số tiền bạn muốn nạp.\n💰 Tối thiểu: <b>${money(env.MIN_DEPOSIT||10000)}</b>\n\nVí dụ: <code>50000</code>`,
    {inline_keyboard:[[ {text:"⬅️ Hủy",callback_data:"home"} ]]});
}

async function createDeposit(env, message) {
  const amount=Number(String(message.text||"").replace(/[^\d]/g,""));
  const min=Number(env.MIN_DEPOSIT||10000);
  if(!Number.isSafeInteger(amount)||amount<min) {
    return tg(env,"sendMessage",{chat_id:message.chat.id,text:`❌ Số tiền không hợp lệ. Số tiền nạp tối thiểu là <b>${money(min)}</b>.`,parse_mode:"HTML"});
  }
  const uid=String(message.from.id);
  const input=await env.DB.prepare("SELECT * FROM deposits WHERE telegram_id=? AND status='INPUT' ORDER BY created_at DESC LIMIT 1").bind(uid).first();
  if(!input) return false;
  const id=rid("NAP"), content=`NAP${crypto.randomUUID().replace(/-/g,"").slice(0,8).toUpperCase()}`;
  await env.DB.prepare("UPDATE deposits SET id=?,amount=?,content=?,status='PENDING',expires_at=? WHERE id=?")
    .bind(id,amount,content,addMin(Number(env.PAYMENT_EXPIRE_MINUTES||15)),input.id).run();

  const qr=`https://img.vietqr.io/image/MB-${encodeURIComponent(env.MB_BANK_ACCOUNT)}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(content)}&accountName=${encodeURIComponent(env.BANK_ACCOUNT_NAME||"")}`;
  await tg(env,"sendPhoto",{
    chat_id:message.chat.id,photo:qr,
    caption:`💳 <b>HÓA ĐƠN NẠP TIỀN</b>\n━━━━━━━━━━━━\n\n🏦 Ngân hàng: <b>${esc(env.BANK_NAME)}</b>\n💳 STK: <code>${esc(env.MB_BANK_ACCOUNT)}</code>\n👤 Chủ TK: <b>${esc(env.BANK_ACCOUNT_NAME)}</b>\n💰 Số tiền: <b>${money(amount)}</b>\n📝 Nội dung: <code>${content}</code>\n\n⚠️ <b>Chuyển đúng số tiền và nội dung.</b>\n📩 <i>Nếu Sau 15P Tiền Không Vào Ib Admin Nhé</i>`,
    parse_mode:"HTML",
    reply_markup:{inline_keyboard:[[ {text:"🔄 Kiểm Tra Thanh Toán",callback_data:`check:${id}`} ],[{text:"⬅️ Trang Chủ",callback_data:"home"}]]}
  });
  return true;
}

async function showProfile(env,chatId,messageId,user) {
  const ref=`https://t.me/${env.BOT_USERNAME||"YOUR_BOT"}?start=ref_${user.telegram_id}`;
  const text=`💎 <b>THÔNG TIN CÁ NHÂN</b>\n━━━━━━━━━━━━\n\n🆔 ID: <code>${user.telegram_id}</code>\n👤 Tên: <b>${esc(user.first_name||user.username||"Không rõ")}</b>\n💳 Số dư: <b>${money(user.balance)}</b>\n💰 Tổng tiền nạp: <b>${money(user.total_deposit)}</b>\n📊 <b>Thống kê</b>\n💸 Tổng chi tiêu: <b>${money(user.total_spent)}</b>\n🔗 Link giới thiệu: <code>${esc(ref)}</code>`;
  return sendOrEdit(env,chatId,messageId,text,{inline_keyboard:[[ {text:"⬅️ Trang Chủ",callback_data:"home"} ]]});
}

async function showTop(env,chatId,messageId,userId) {
  const top=await env.DB.prepare("SELECT telegram_id,username,first_name,total_deposit FROM users WHERE total_deposit>0 ORDER BY total_deposit DESC LIMIT 10").all();
  const rank=await env.DB.prepare("SELECT COUNT(*)+1 rank FROM users WHERE total_deposit>(SELECT total_deposit FROM users WHERE telegram_id=?)").bind(String(userId)).first();
  let lines=`🏆 <b>TOP NẠP</b>\n━━━━━━━━━━━━\n\n1️⃣ <b>Tổng tiền nạp</b>\n\n`;
  if(!top.results.length) lines+="Chưa có dữ liệu nạp tiền.\n";
  else top.results.forEach((u,i)=>lines+=`<b>Top ${i+1}</b> — ${esc(u.first_name||u.username||u.telegram_id)}: <b>${money(u.total_deposit)}</b>\n`);
  lines+=`\n3️⃣ <b>Xếp hạng của bạn:</b> Top ${rank?.rank||"Chưa xếp hạng"}`;
  return sendOrEdit(env,chatId,messageId,lines,{inline_keyboard:[[ {text:"⬅️ Trang Chủ",callback_data:"home"} ]]});
}

async function showHistory(env,chatId,messageId,userId) {
  const ds=await env.DB.prepare("SELECT * FROM deposits WHERE telegram_id=? AND status='PAID' ORDER BY paid_at DESC LIMIT 10").bind(String(userId)).all();
  let text=`📜 <b>LỊCH SỬ NẠP</b>\n━━━━━━━━━━━━\n\n`;
  if(!ds.results.length) text+="Chưa có giao dịch nạp thành công.";
  else ds.results.forEach(d=>{
    const time=new Date(d.paid_at||d.created_at).toLocaleString("vi-VN",{timeZone:"Asia/Ho_Chi_Minh"});
    text+=`💰 Đã cộng: <b>${money(d.amount)}</b>\n📝 Nội dung: <code>${esc(d.content)}</code>\n🔖 Mã giao dịch: <code>${esc(d.bank_transaction_id||d.id)}</code>\n🕒 Thời gian: ${esc(time)}\n\n`;
  });
  return sendOrEdit(env,chatId,messageId,text,{inline_keyboard:[[ {text:"⬅️ Trang Chủ",callback_data:"home"} ]]});
}

async function showSupport(env,chatId,messageId) {
  return sendOrEdit(env,chatId,messageId,
    `🔐 <b>HỖ TRỢ</b>\n━━━━━━━━━━━━\n\n📌 Hướng dẫn:\n1. Chọn chức năng cần dùng.\n2. Khi nạp tiền, chuyển đúng số tiền và nội dung.\n3. Sau khi giao dịch thành công hệ thống sẽ tự cộng số dư.\n4. Nếu Sau 15P Tiền Không Vào Ib Admin Nhé.\n\n👤 Admin: ${esc(env.ADMIN_USERNAME)}\n${esc(env.SUPPORT_TEXT||"")}`,
    {inline_keyboard:[[ {text:"💬 Liên Hệ Admin",url:`https://t.me/${String(env.ADMIN_USERNAME||"").replace("@","")}`} ],[{text:"⬅️ Trang Chủ",callback_data:"home"}]]});
}

// --- MB AUTH: based on the uploaded MB documentation screenshot ---
let tokenCache={value:null,expires:0};
async function getMbAccessToken(env) {
  if(tokenCache.value && tokenCache.expires>Date.now()+60000) return tokenCache.value;
  if(!env.MB_TOKEN_URL||!env.MB_CLIENT_ID||!env.MB_CLIENT_SECRET) throw new Error("Thiếu cấu hình MB token");
  const basic=btoa(`${env.MB_CLIENT_ID}:${env.MB_CLIENT_SECRET}`);
  const body=new URLSearchParams({grant_type:"client_credentials"});
  const r=await fetch(env.MB_TOKEN_URL,{method:"POST",headers:{
    "Authorization":`Basic ${basic}`,
    "Content-Type":"application/x-www-form-urlencoded",
    "Accept":"application/json"
  },body:body.toString()});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.access_token) throw new Error(`Không lấy được MB access token: ${j.message||j.error||r.status}`);
  tokenCache={value:j.access_token,expires:Date.now()+Math.max(60,(Number(j.expires_in)||300))*1000};
  return tokenCache.value;
}

/*
 IMPORTANT:
 MB_TRANSACTION_URL must be the exact transaction/history API endpoint that your MB
 application is authorized to use. The Authorization Token screenshot alone does not
 reveal this endpoint or its response schema.
*/
async function getMbTransactions(env) {
  if(!env.MB_TRANSACTION_URL) throw new Error("MB_TRANSACTION_URL chưa được cấu hình");
  const token=await getMbAccessToken(env);
  const method=env.MB_TRANSACTION_METHOD||"GET";
  const r=await fetch(env.MB_TRANSACTION_URL,{
    method,
    headers:{"Authorization":`Bearer ${token}`,"Accept":"application/json","Content-Type":"application/json"},
    body:method==="GET"?undefined:JSON.stringify({})
  });
  const text=await r.text();
  if(!r.ok) throw new Error(`MB transaction API ${r.status}: ${text.slice(0,300)}`);
  try{return JSON.parse(text);}catch{throw new Error("MB transaction API không trả JSON");}
}

function flattenTransactions(data){
  if(Array.isArray(data)) return data;
  const paths=[data?.data?.transactions,data?.data?.transactionList,data?.data?.items,data?.data,data?.transactions,data?.items,data?.result];
  return paths.find(Array.isArray)||[];
}
function txAmount(tx){ return Number(tx.amount??tx.transactionAmount??tx.creditAmount??tx.value??0); }
function txContent(tx){ return String(tx.description??tx.content??tx.remark??tx.transactionDescription??tx.addInfo??"").toUpperCase(); }
function txId(tx){ return String(tx.transactionId??tx.transaction_id??tx.id??tx.refNo??tx.referenceNo??""); }

async function checkDeposit(env, depositId) {
  const d=await env.DB.prepare("SELECT * FROM deposits WHERE id=?").bind(depositId).first();
  if(!d||d.status!=="PENDING") return d;
  if(Date.parse(d.expires_at)<Date.now()) {
    await env.DB.prepare("UPDATE deposits SET status='EXPIRED' WHERE id=?").bind(d.id).run();
    return {...d,status:"EXPIRED"};
  }
  const data=await getMbTransactions(env);
  const match=flattenTransactions(data).find(tx=>txAmount(tx)===Number(d.amount)&&txContent(tx).includes(String(d.content).toUpperCase()));
  if(!match) return d;

  const transactionId=txId(match)||rid("MB");
  const claim=await env.DB.prepare("UPDATE deposits SET status='PAID',bank_transaction_id=?,bank_raw=?,paid_at=? WHERE id=? AND status='PENDING'")
    .bind(transactionId,JSON.stringify(match).slice(0,20000),nowISO(),d.id).run();
  if(claim.meta.changes!==1) return await env.DB.prepare("SELECT * FROM deposits WHERE id=?").bind(d.id).first();

  await env.DB.batch([
    env.DB.prepare("UPDATE users SET balance=balance+?,total_deposit=total_deposit+? WHERE telegram_id=?").bind(d.amount,d.amount,d.telegram_id)
  ]);
  return await env.DB.prepare("SELECT * FROM deposits WHERE id=?").bind(d.id).first();
}

async function notifyPaid(env,d) {
  const user=await env.DB.prepare("SELECT * FROM users WHERE telegram_id=?").bind(d.telegram_id).first();
  await tg(env,"sendMessage",{chat_id:d.telegram_id,parse_mode:"HTML",
    text:`✅ <b>NẠP TIỀN THÀNH CÔNG</b>\n\n💰 Đã cộng: <b>${money(d.amount)}</b>\n📝 Nội dung: <code>${esc(d.content)}</code>\n🔖 Mã giao dịch: <code>${esc(d.bank_transaction_id)}</code>\n💳 Số dư mới: <b>${money(user.balance)}</b>`
  });
}

async function handleUpdate(env,update) {
  await ensureSeed(env);
  if(update.message?.from) {
    await ensureUser(env,update.message.from);
    const m=update.message;
    if(m.text==="/start") return showHome(env,m.chat.id,null,m.from.first_name||m.from.username||"bạn");
    if(m.text) {
      const created=await createDeposit(env,m);
      if(created) return;
    }
  }

  if(!update.callback_query) return;
  const q=update.callback_query, chatId=q.message.chat.id, msgId=q.message.message_id, userId=q.from.id;
  const user=await ensureUser(env,q.from);
  const data=q.data||"";
  if(data==="noop") return tg(env,"answerCallbackQuery",{callback_query_id:q.id});
  await tg(env,"answerCallbackQuery",{callback_query_id:q.id}).catch(()=>{});

  if(data==="home") return showHome(env,chatId,msgId,q.from.first_name||q.from.username||"bạn");
  if(data==="buy") return showProducts(env,chatId,msgId);
  if(data==="deposit") return promptDeposit(env,chatId,msgId,userId);
  if(data==="profile") return showProfile(env,chatId,msgId,user);
  if(data==="top") return showTop(env,chatId,msgId,userId);
  if(data==="history") return showHistory(env,chatId,msgId,userId);
  if(data==="support") return showSupport(env,chatId,msgId);
  if(data.startsWith("p:")) return showProduct(env,chatId,msgId,data.slice(2));
  if(data.startsWith("i:")) return showItem(env,chatId,msgId,data.slice(2));
  if(data.startsWith("confirm:")) return buyItem(env,chatId,msgId,userId,data.slice(8));
  if(data.startsWith("check:")) {
    try {
      const d=await checkDeposit(env,data.slice(6));
      if(d?.status==="PAID") {
        await notifyPaid(env,d);
        return tg(env,"answerCallbackQuery",{callback_query_id:q.id,text:"Đã xác nhận và cộng tiền!",show_alert:true});
      }
      if(d?.status==="EXPIRED") return tg(env,"answerCallbackQuery",{callback_query_id:q.id,text:"Đơn nạp đã hết hạn.",show_alert:true});
      return tg(env,"answerCallbackQuery",{callback_query_id:q.id,text:"Chưa tìm thấy giao dịch phù hợp.",show_alert:true});
    } catch(e) {
      console.error(e);
      return tg(env,"answerCallbackQuery",{callback_query_id:q.id,text:"Chưa thể kiểm tra giao dịch. Thử lại sau.",show_alert:true});
    }
  }
}

export default {
  async fetch(request,env) {
    const u=new URL(request.url);
    if(request.method==="GET"&&u.pathname==="/") return new Response("MB Shop Bot OK");
    if(request.method==="POST"&&u.pathname==="/webhook") {
      try{await handleUpdate(env,await request.json());}
      catch(e){console.error(e);}
      return new Response("ok");
    }
    return new Response("Not found",{status:404});
  },
  async scheduled(event,env,ctx) {
    ctx.waitUntil((async()=>{
      await ensureSeed(env);
      const pending=await env.DB.prepare("SELECT id FROM deposits WHERE status='PENDING' AND expires_at>? ORDER BY created_at LIMIT 50").bind(nowISO()).all();
      for(const x of pending.results) {
        try {
          const d=await checkDeposit(env,x.id);
          if(d?.status==="PAID") await notifyPaid(env,d);
        } catch(e) { console.error("deposit poll",x.id,e.message); }
      }
      await env.DB.prepare("UPDATE deposits SET status='EXPIRED' WHERE status='PENDING' AND expires_at<=?").bind(nowISO()).run();
    })());
  }
};
