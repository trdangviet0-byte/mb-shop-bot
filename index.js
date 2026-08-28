const ADMIN_ID = "7424477198";

// SePay: đặt số tài khoản nhận tiền để webhook chỉ xử lý đúng STK này.
// Nếu để trống, bot vẫn kiểm tra chữ ký + số tiền + mã đơn.
const SEPAY_BANK_ACCOUNT_ENV = "SEPAY_BANK_ACCOUNT";

/* =========================================================
   CONFIG
========================================================= */

const PRODUCTS = [
  ["fluorite", "Fluorite"],
  ["migui-lite", "Migui Lite"],
  ["migui-pro", "Migui Pro"],
  ["drip-client", "Drip Client"],
  ["esign", "Chứng Chỉ Esign"],
  ["8bp-fluorite", "8BP_Fluorite"],
  ["proxy-android", "Proxy Android"],
  ["lien-quan", "Liên Quân"],
  ["tipa-sudo", "Tipa FF Sudo"],
  ["tipa-iosviet", "Tipa FF IosViet"],
  ["migui-global", "Migui Global"],
  ["fl0rk-ff", "Fl0rk FF"],
  ["proxy-ios", "Proxy Ios"],
  ["play-together", "Play Together VNG"]
];

const DEFAULT_ITEMS = [
  ["1 Giờ", 10000, 1273],
  ["1 Ngày", 65000, 1273],
  ["7 Ngày", 215000, 1273],
  ["31 Ngày", 450000, 1273]
];


/* =========================================================
   CACHE
========================================================= */

let seedPromise = null;

let tokenCache = {
  value: null,
  expires: 0
};


/* =========================================================
   HELPERS
========================================================= */

function isAdmin(userId) {
  return String(userId) === ADMIN_ID;
}

const money = n =>
  Number(n || 0).toLocaleString("vi-VN") + "đ";

const esc = s =>
  String(s ?? "").replace(
    /[&<>"]/g,
    c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;"
    }[c])
  );

const rid = prefix =>
  prefix +
  crypto.randomUUID()
    .replace(/-/g, "")
    .slice(0, 12)
    .toUpperCase();

const nowISO = () =>
  new Date().toISOString();

const addMin = min =>
  new Date(
    Date.now() + Number(min || 0) * 60000
  ).toISOString();

function parseMoney(text) {
  const n = Number(
    String(text || "")
      .replace(/[^\d]/g, "")
  );

  return Number.isSafeInteger(n)
    ? n
    : NaN;
}

function slugify(text) {
  const base = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return base || "product";
}


/* =========================================================
   TELEGRAM API
========================================================= */

async function tg(env, method, body) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    20000
  );

  try {
    const r = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    const text = await r.text();

    let j = {};

    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(
        `Telegram ${method}: invalid JSON`
      );
    }

    if (!j.ok) {
      throw new Error(
        `Telegram ${method}: ${
          j.description || r.status
        }`
      );
    }

    return j.result;

  } finally {
    clearTimeout(timeout);
  }
}


/* =========================================================
   DATABASE SETUP
========================================================= */

async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS admin_states (
        telegram_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        payload TEXT DEFAULT '{}',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS bot_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `)
  ]);

  /*
    DEPOSITS SCHEMA MIGRATION
    Một số DB cũ có bảng deposits nhưng thiếu created_at.
    createDeposit() dùng created_at để lấy INPUT mới nhất.
  */
  try {
    await env.DB.prepare(`
      ALTER TABLE deposits
      ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP
    `).run();
  } catch {}

  try {
    await env.DB.prepare(`
      ALTER TABLE deposits
      ADD COLUMN notified_at TEXT
    `).run();
  } catch {}

  try {
    await env.DB.prepare(`
      ALTER TABLE deposits
      ADD COLUMN admin_pending_notified_at TEXT
    `).run();
  } catch {}

  try {
    await env.DB.prepare(`
      ALTER TABLE deposits
      ADD COLUMN admin_paid_notified_at TEXT
    `).run();
  } catch {}

  try {
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_deposits_bank_transaction
      ON deposits(bank_transaction_id)
    `).run();
  } catch {}

  try {
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_users_telegram
      ON users(telegram_id)
    `).run();
  } catch {}

  try {
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_deposits_status
      ON deposits(status)
    `).run();
  } catch {}

  try {
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_product_items_product
      ON product_items(product_id)
    `).run();
  } catch {}
}


async function ensureSeed(env) {
  if (seedPromise) {
    return seedPromise;
  }

  seedPromise = (async () => {
    await ensureSchema(env);

    const c = await env.DB
      .prepare(
        "SELECT COUNT(*) c FROM products"
      )
      .first();

    if (Number(c?.c || 0) > 0) {
      return;
    }

    const stmts = [];

    PRODUCTS.forEach(
      ([id, name], i) => {
        stmts.push(
          env.DB
            .prepare(`
              INSERT OR IGNORE INTO products(
                id,
                name,
                sort_order,
                active
              )
              VALUES(?,?,?,1)
            `)
            .bind(
              id,
              name,
              i
            )
        );

        DEFAULT_ITEMS.forEach(
          ([title, price, stock], j) => {
            stmts.push(
              env.DB
                .prepare(`
                  INSERT OR IGNORE INTO product_items(
                    id,
                    product_id,
                    title,
                    price,
                    stock,
                    sort_order
                  )
                  VALUES(?,?,?,?,?,?)
                `)
                .bind(
                  `${id}-${j + 1}`,
                  id,
                  title,
                  price,
                  stock,
                  j
                )
            );
          }
        );
      }
    );

    for (
      let i = 0;
      i < stmts.length;
      i += 50
    ) {
      await env.DB.batch(
        stmts.slice(i, i + 50)
      );
    }
  })().catch(err => {
    seedPromise = null;
    throw err;
  });

  return seedPromise;
}


/* =========================================================
   ADMIN STATE
========================================================= */

async function setAdminState(
  env,
  userId,
  action,
  payload = {}
) {
  await env.DB
    .prepare(`
      INSERT INTO admin_states(
        telegram_id,
        action,
        payload,
        updated_at
      )
      VALUES(?,?,?,?)
      ON CONFLICT(telegram_id)
      DO UPDATE SET
        action=excluded.action,
        payload=excluded.payload,
        updated_at=excluded.updated_at
    `)
    .bind(
      String(userId),
      action,
      JSON.stringify(payload),
      nowISO()
    )
    .run();
}


async function getAdminState(
  env,
  userId
) {
  const state = await env.DB
    .prepare(`
      SELECT *
      FROM admin_states
      WHERE telegram_id=?
    `)
    .bind(String(userId))
    .first();

  if (!state) {
    return null;
  }

  let payload = {};

  try {
    payload = JSON.parse(
      state.payload || "{}"
    );
  } catch {}

  return {
    ...state,
    payload
  };
}


async function clearAdminState(
  env,
  userId
) {
  await env.DB
    .prepare(`
      DELETE FROM admin_states
      WHERE telegram_id=?
    `)
    .bind(String(userId))
    .run();
}


/* =========================================================
   USER
========================================================= */

async function ensureUser(
  env,
  from
) {
  await env.DB
    .prepare(`
      INSERT INTO users(
        telegram_id,
        username,
        first_name
      )
      VALUES(?,?,?)
      ON CONFLICT(telegram_id)
      DO UPDATE SET
        username=excluded.username,
        first_name=excluded.first_name
    `)
    .bind(
      String(from.id),
      from.username || "",
      from.first_name || ""
    )
    .run();

  return env.DB
    .prepare(`
      SELECT *
      FROM users
      WHERE telegram_id=?
    `)
    .bind(String(from.id))
    .first();
}


/* =========================================================
   SEND / EDIT
========================================================= */

async function sendOrEdit(
  env,
  chatId,
  messageId,
  text,
  keyboard
) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard,
    disable_web_page_preview: true
  };

  if (!messageId) {
    return tg(
      env,
      "sendMessage",
      body
    );
  }

  try {
    return await tg(
      env,
      "editMessageText",
      {
        ...body,
        message_id: messageId
      }
    );

  } catch (e) {
    const error = String(
      e.message || e
    );

    if (
      error.includes(
        "message is not modified"
      )
    ) {
      return null;
    }

    if (
      error.includes(
        "message can't be edited"
      ) ||
      error.includes(
        "MESSAGE_ID_INVALID"
      )
    ) {
      return tg(
        env,
        "sendMessage",
        body
      );
    }

    throw e;
  }
}


/* =========================================================
   HOME
========================================================= */

function homeKeyboard(
  userId = null
) {
  const rows = [
    [
      {
        text: "🛍️ Mua Key / Acc FF",
        callback_data: "buy"
      },
      {
        text: "💳 Nạp Tiền",
        callback_data: "deposit"
      }
    ],
    [
      {
        text: "💎 Cá Nhân",
        callback_data: "profile"
      },
      {
        text: "🏆 Top Nạp",
        callback_data: "top"
      }
    ],
    [
      {
        text: "📜 Lịch Sử Nạp",
        callback_data: "history"
      },
      {
        text: "🧑‍💻 Hỗ Trợ",
        callback_data: "support"
      }
    ]
  ];

  if (isAdmin(userId)) {
    rows.push([
      {
        text: "⚙️ ADMIN PANEL",
        callback_data: "admin"
      }
    ]);
  }

  return {
    inline_keyboard: rows
  };
}


function homeText(
  env,
  name = "bạn"
) {
  return (
    `🎉 <b>Chào mừng ${esc(
      name
    )} đến với ${esc(
      env.SHOP_NAME ||
      "RUS TAY IOS STORE"
    )}!</b>\n\n` +

    `Vui lòng chọn chức năng bên dưới để tiếp tục.`
  );
}


async function showHome(
  env,
  chatId,
  messageId,
  name = "bạn",
  userId = null
) {
  if (userId) {
    await clearAdminState(
      env,
      userId
    );
  }

  return sendOrEdit(
    env,
    chatId,
    messageId,
    homeText(
      env,
      name
    ),
    homeKeyboard(userId)
  );
}


/* =========================================================
   ADMIN PANEL
========================================================= */

async function showAdminPanel(
  env,
  chatId,
  messageId
) {
  const result = await env.DB.batch([
    env.DB.prepare(`
      SELECT COUNT(*) AS c
      FROM users
    `),

    env.DB.prepare(`
      SELECT COUNT(*) AS c
      FROM deposits
      WHERE status='PENDING'
    `),

    env.DB.prepare(`
      SELECT COUNT(*) AS c
      FROM deposits
      WHERE status='PAID'
    `),

    env.DB.prepare(`
      SELECT
        COALESCE(
          SUM(balance),
          0
        ) AS total
      FROM users
    `),

    env.DB.prepare(`
      SELECT COUNT(*) AS c
      FROM products
    `),

    env.DB.prepare(`
      SELECT COUNT(*) AS c
      FROM product_items
    `)
  ]);

  const users =
    result[0].results[0];

  const pending =
    result[1].results[0];

  const paid =
    result[2].results[0];

  const balance =
    result[3].results[0];

  const products =
    result[4].results[0];

  const items =
    result[5].results[0];

  const text =
    `⚙️ <b>ADMIN PANEL</b>\n` +
    `━━━━━━━━━━━━\n\n` +

    `👥 Tổng tài khoản: <b>${users.c}</b>\n` +
    `📦 Danh mục: <b>${products.c}</b>\n` +
    `🛍️ Gói sản phẩm: <b>${items.c}</b>\n` +
    `⏳ Đơn nạp chờ: <b>${pending.c}</b>\n` +
    `✅ Đơn đã duyệt: <b>${paid.c}</b>\n` +
    `💰 Tổng số dư user: <b>${money(
      balance.total
    )}</b>\n\n` +

    `<b>Chọn chức năng:</b>`;

  return sendOrEdit(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "📦 Quản Lý Sản Phẩm",
            callback_data: "admin_products"
          }
        ],
        [
          {
            text: "➕ Thêm Sản Phẩm",
            callback_data: "admin_add_product"
          },
          {
            text: "👁️ Xem Sản Phẩm",
            callback_data: "admin_products"
          }
        ],
        [
          {
            text: "💰 Cộng Tiền User",
            callback_data: "admin_add_money"
          },
          {
            text: "🔎 Tìm User",
            callback_data: "admin_find_user"
          }
        ],
        [
          {
            text: "⏳ Duyệt Đơn Nạp",
            callback_data: "admin_deposits"
          },
          {
            text: "👥 Danh Sách User",
            callback_data: "admin_users"
          }
        ],
        [
          {
            text: "⬅️ Trang Chủ",
            callback_data: "home"
          }
        ]
      ]
    }
  );
}


/* =========================================================
   ADMIN PRODUCTS
========================================================= */

async function showAdminProducts(
  env,
  chatId,
  messageId
) {
  const result = await env.DB
    .prepare(`
      SELECT
        p.*,
        COUNT(i.id) AS item_count
      FROM products p
      LEFT JOIN product_items i
        ON i.product_id=p.id
      GROUP BY p.id
      ORDER BY p.sort_order,p.name
      LIMIT 100
    `)
    .all();

  let text =
    `📦 <b>QUẢN LÝ SẢN PHẨM</b>\n` +
    `━━━━━━━━━━━━\n\n`;

  if (!result.results.length) {
    text +=
      `Chưa có sản phẩm.`;
  } else {
    text +=
      `Chọn sản phẩm để quản lý:\n`;
  }

  const rows = result.results.map(
    p => [
      {
        text:
          `${p.active ? "🟢" : "🔴"} ` +
          `${p.name} (${p.item_count})`,
        callback_data:
          `ap:${p.id}`
      }
    ]
  );

  rows.push([
    {
      text: "➕ Thêm Sản Phẩm",
      callback_data: "admin_add_product"
    }
  ]);

  rows.push([
    {
      text: "⬅️ Admin Panel",
      callback_data: "admin"
    }
  ]);

  return sendOrEdit(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: rows
    }
  );
}


async function showAdminProduct(
  env,
  chatId,
  messageId,
  productId
) {
  const product = await env.DB
    .prepare(`
      SELECT *
      FROM products
      WHERE id=?
    `)
    .bind(productId)
    .first();

  if (!product) {
    return showAdminProducts(
      env,
      chatId,
      messageId
    );
  }

  const items = await env.DB
    .prepare(`
      SELECT *
      FROM product_items
      WHERE product_id=?
      ORDER BY sort_order
    `)
    .bind(productId)
    .all();

  let text =
    `📦 <b>${esc(
      product.name
    )}</b>\n` +
    `━━━━━━━━━━━━\n\n` +

    `🆔 ID: <code>${esc(
      product.id
    )}</code>\n` +

    `📊 Trạng thái: ${
      product.active
        ? "🟢 Đang bán"
        : "🔴 Đang ẩn"
    }\n\n` +

    `<b>Danh sách gói:</b>\n`;

  if (!items.results.length) {
    text +=
      `Chưa có gói nào.\n`;
  }

  const rows = [];

  for (const item of items.results) {
    text +=
      `• ${esc(item.title)} — ` +
      `<b>${money(item.price)}</b> — ` +
      `Kho: <b>${item.stock}</b>\n`;

    rows.push([
      {
        text:
          `⚙️ ${item.title} | ` +
          `${money(item.price)}`,
        callback_data:
          `ai:${item.id}`
      }
    ]);
  }

  rows.push([
    {
      text: "➕ Thêm Gói",
      callback_data:
        `admin_add_item:${product.id}`
    }
  ]);

  rows.push([
    {
      text: "✏️ Sửa Tên Sản Phẩm",
      callback_data:
        `admin_edit_product:${product.id}`
    },
    {
      text: product.active
        ? "🔴 Ẩn"
        : "🟢 Hiện",
      callback_data:
        `admin_toggle_product:${product.id}`
    }
  ]);

  rows.push([
    {
      text: "🗑️ Xóa Sản Phẩm",
      callback_data:
        `admin_delete_product:${product.id}`
    }
  ]);

  rows.push([
    {
      text: "⬅️ Danh Sách",
      callback_data: "admin_products"
    }
  ]);

  return sendOrEdit(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: rows
    }
  );
}


/* =========================================================
   ADMIN ITEM
========================================================= */

async function showAdminItem(
  env,
  chatId,
  messageId,
  itemId
) {
  const item = await env.DB
    .prepare(`
      SELECT
        i.*,
        p.name product_name
      FROM product_items i
      JOIN products p
        ON p.id=i.product_id
      WHERE i.id=?
    `)
    .bind(itemId)
    .first();

  if (!item) {
    return showAdminProducts(
      env,
      chatId,
      messageId
    );
  }

  const text =
    `⚙️ <b>QUẢN LÝ GÓI</b>\n` +
    `━━━━━━━━━━━━\n\n` +

    `📦 Sản phẩm: <b>${esc(
      item.product_name
    )}</b>\n` +

    `🏷️ Gói: <b>${esc(
      item.title
    )}</b>\n` +

    `💰 Giá: <b>${money(
      item.price
    )}</b>\n` +

    `📊 Kho: <b>${item.stock}</b>\n` +

    `🆔 ID: <code>${esc(
      item.id
    )}</code>`;

  return sendOrEdit(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "✏️ Sửa Tên Gói",
            callback_data:
              `admin_edit_item_title:${item.id}`
          }
        ],
        [
          {
            text: "💰 Sửa Giá",
            callback_data:
              `admin_edit_item_price:${item.id}`
          },
          {
            text: "📦 Sửa Kho",
            callback_data:
              `admin_edit_item_stock:${item.id}`
          }
        ],
        [
          {
            text: "🗑️ Xóa Gói",
            callback_data:
              `admin_delete_item:${item.id}`
          }
        ],
        [
          {
            text: "⬅️ Quay Lại",
            callback_data:
              `ap:${item.product_id}`
          }
        ]
      ]
    }
  );
}


/* =========================================================
   ADMIN DEPOSITS
========================================================= */

async function showAdminDeposits(
  env,
  chatId,
  messageId
) {
  const result = await env.DB
    .prepare(`
      SELECT *
      FROM deposits
      WHERE status='PENDING'
      ORDER BY created_at DESC
      LIMIT 20
    `)
    .all();

  let text =
    `⏳ <b>ĐƠN NẠP CHỜ</b>\n` +
    `━━━━━━━━━━━━\n\n`;

  if (!result.results.length) {
    text +=
      `Không có đơn nào đang chờ.`;
  } else {
    result.results.forEach(
      (d, i) => {
        text +=
          `${i + 1}. 💰 <b>${money(
            d.amount
          )}</b>\n` +

          `👤 User: <code>${esc(
            d.telegram_id
          )}</code>\n` +

          `📝 Nội dung: <code>${esc(
            d.content
          )}</code>\n` +

          `🆔 Đơn: <code>${esc(
            d.id
          )}</code>\n\n`;
      }
    );
  }

  return sendOrEdit(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "🔄 Làm Mới",
            callback_data:
              "admin_deposits"
          }
        ],
        [
          {
            text: "⬅️ Admin Panel",
            callback_data:
              "admin"
          }
        ]
      ]
    }
  );
}


/* =========================================================
   ADMIN USERS
========================================================= */

async function showAdminUsers(
  env,
  chatId,
  messageId
) {
  const result = await env.DB
    .prepare(`
      SELECT *
      FROM users
      ORDER BY total_deposit DESC
      LIMIT 20
    `)
    .all();

  let text =
    `👥 <b>DANH SÁCH USER</b>\n` +
    `━━━━━━━━━━━━\n\n`;

  if (!result.results.length) {
    text +=
      `Chưa có user.`;
  } else {
    result.results.forEach(
      (u, i) => {
        text +=
          `${i + 1}. 👤 <b>${esc(
            u.first_name ||
            u.username ||
            "Không rõ"
          )}</b>\n` +

          `🆔 <code>${u.telegram_id}</code>\n` +

          `💳 Số dư: <b>${money(
            u.balance
          )}</b>\n` +

          `💰 Đã nạp: <b>${money(
            u.total_deposit
          )}</b>\n\n`;
      }
    );
  }

  return sendOrEdit(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "💰 Cộng Tiền User",
            callback_data:
              "admin_add_money"
          }
        ],
        [
          {
            text: "🔄 Làm Mới",
            callback_data:
              "admin_users"
          }
        ],
        [
          {
            text: "⬅️ Admin Panel",
            callback_data:
              "admin"
          }
        ]
      ]
    }
  );
}


/* =========================================================
   PRODUCTS USER
========================================================= */

async function showProducts(
  env,
  chatId,
  messageId
) {
  const ps = await env.DB
    .prepare(`
      SELECT id,name,emoji
      FROM products
      WHERE active=1
      ORDER BY sort_order,name
    `)
    .all();

  const rows = [];

  for (
    let i = 0;
    i < ps.results.length;
    i += 2
  ) {
    rows.push(
      ps.results
        .slice(i, i + 2)
        .map(
          p => ({
            text:
              `${p.emoji || "📦"} ` +
              p.name,
            callback_data:
              `p:${p.id}`
          })
        )
    );
  }

  rows.push([
    {
      text: "⬅️ Quay Lại",
      callback_data: "home"
    }
  ]);

  return sendOrEdit(
    env,
    chatId,
    messageId,
    `🛍️ <b>DANH SÁCH SẢN PHẨM</b>\n\n` +
    `Chọn danh mục bên dưới để xem chi tiết:`,
    {
      inline_keyboard: rows
    }
  );
}


async function showProduct(
  env,
  chatId,
  messageId,
  productId
) {
  const product = await env.DB
    .prepare(`
      SELECT *
      FROM products
      WHERE id=?
        AND active=1
    `)
    .bind(productId)
    .first();

  if (!product) {
    return showProducts(
      env,
      chatId,
      messageId
    );
  }

  const items = await env.DB
    .prepare(`
      SELECT *
      FROM product_items
      WHERE product_id=?
      ORDER BY sort_order
    `)
    .bind(productId)
    .all();

  const rows =
    items.results.map(
      x => [
        {
          text:
            `💎 ${x.title}`,
          callback_data:
            `i:${x.id}`
        },
        {
          text:
            `💰 ${money(
              x.price
            )}`,
          callback_data:
            "noop"
        },
        {
          text:
            `📦 ${x.stock}`,
          callback_data:
            "noop"
        }
      ]
    );

  rows.push([
    {
      text: "⬅️ Quay Lại",
      callback_data: "buy"
    }
  ]);

  return sendOrEdit(
    env,
    chatId,
    messageId,
    `📁 <b>${esc(
      product.name
    )}</b>\n\n` +

    `Chọn gói muốn mua.`,
    {
      inline_keyboard: rows
    }
  );
}


async function showItem(
  env,
  chatId,
  messageId,
  itemId
) {
  const row = await env.DB
    .prepare(`
      SELECT
        i.*,
        p.name product_name
      FROM product_items i
      JOIN products p
        ON p.id=i.product_id
      WHERE i.id=?
        AND p.active=1
    `)
    .bind(itemId)
    .first();

  if (!row) {
    return showProducts(
      env,
      chatId,
      messageId
    );
  }

  const text =
    `📦 <b>THÔNG TIN SẢN PHẨM</b>\n` +
    `━━━━━━━━━━━━\n\n` +

    `🏷️ Tên: <b>${esc(
      row.product_name
    )} ${esc(
      row.title
    )}</b>\n` +

    `💰 Giá: <b>${money(
      row.price
    )}</b>\n` +

    `📊 Trong kho: <b>${row.stock}</b>\n\n` +

    `👇 Chọn MUA NGAY để thanh toán.`;

  return sendOrEdit(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "🛒 MUA NGAY",
            callback_data:
              `confirm:${itemId}`
          }
        ],
        [
          {
            text: "⬅️ Quay Lại",
            callback_data:
              `p:${row.product_id}`
          }
        ]
      ]
    }
  );
}


/* =========================================================
   BUY ITEM
========================================================= */

async function buyItem(
  env,
  chatId,
  messageId,
  userId,
  itemId
) {
  const item = await env.DB
    .prepare(`
      SELECT
        i.*,
        p.name product_name,
        p.active
      FROM product_items i
      JOIN products p
        ON p.id=i.product_id
      WHERE i.id=?
    `)
    .bind(itemId)
    .first();

  if (!item || !item.active) {
    return sendOrEdit(
      env,
      chatId,
      messageId,
      `❌ Sản phẩm không còn khả dụng.`,
      {
        inline_keyboard: [
          [
            {
              text: "🛍️ Xem Sản Phẩm",
              callback_data: "buy"
            }
          ]
        ]
      }
    );
  }

  if (Number(item.stock) <= 0) {
    return sendOrEdit(
      env,
      chatId,
      messageId,
      `❌ <b>SẢN PHẨM ĐÃ HẾT HÀNG</b>`,
      {
        inline_keyboard: [
          [
            {
              text: "⬅️ Quay Lại",
              callback_data:
                `p:${item.product_id}`
            }
          ]
        ]
      }
    );
  }

  const user = await env.DB
    .prepare(`
      SELECT balance
      FROM users
      WHERE telegram_id=?
    `)
    .bind(String(userId))
    .first();

  if (!user) {
    throw new Error(
      "Không tìm thấy user"
    );
  }

  if (
    Number(user.balance) <
    Number(item.price)
  ) {
    const missing =
      Number(item.price) -
      Number(user.balance);

    return sendOrEdit(
      env,
      chatId,
      messageId,
      `❌ <b>SỐ DƯ KHÔNG ĐỦ</b>\n\n` +

      `💳 Số dư: <b>${money(
        user.balance
      )}</b>\n` +

      `💰 Giá: <b>${money(
        item.price
      )}</b>\n` +

      `➖ Cần nạp thêm: <b>${money(
        missing
      )}</b>`,
      {
        inline_keyboard: [
          [
            {
              text: "💳 Nạp Tiền",
              callback_data:
                "deposit"
            }
          ],
          [
            {
              text: "⬅️ Quay Lại",
              callback_data:
                `i:${itemId}`
            }
          ]
        ]
      }
    );
  }

  const orderId =
    rid("ORD");

  /*
    Trừ tiền và trừ kho có điều kiện.
    Nếu một trong hai thay đổi thất bại,
    hoàn lại phần đã thay đổi.
  */

  const out = await env.DB.batch([
    env.DB
      .prepare(`
        UPDATE users
        SET
          balance=balance-?,
          total_spent=total_spent+?
        WHERE
          telegram_id=?
          AND balance>=?
      `)
      .bind(
        item.price,
        item.price,
        String(userId),
        item.price
      ),

    env.DB
      .prepare(`
        UPDATE product_items
        SET stock=stock-1
        WHERE
          id=?
          AND stock>0
      `)
      .bind(itemId)
  ]);

  const userChanged =
    Number(
      out[0]?.meta?.changes || 0
    );

  const stockChanged =
    Number(
      out[1]?.meta?.changes || 0
    );

  if (
    userChanged !== 1 ||
    stockChanged !== 1
  ) {
    const rollback = [];

    if (userChanged === 1) {
      rollback.push(
        env.DB
          .prepare(`
            UPDATE users
            SET
              balance=balance+?,
              total_spent=total_spent-?
            WHERE telegram_id=?
          `)
          .bind(
            item.price,
            item.price,
            String(userId)
          )
      );
    }

    if (stockChanged === 1) {
      rollback.push(
        env.DB
          .prepare(`
            UPDATE product_items
            SET stock=stock+1
            WHERE id=?
          `)
          .bind(itemId)
      );
    }

    if (rollback.length) {
      await env.DB.batch(
        rollback
      );
    }

    return sendOrEdit(
      env,
      chatId,
      messageId,
      `⚠️ Số dư hoặc kho vừa thay đổi.\n\n` +
      `Vui lòng thử lại.`,
      {
        inline_keyboard: [
          [
            {
              text: "🔄 Xem Lại",
              callback_data:
                `i:${itemId}`
            }
          ]
        ]
      }
    );
  }

  try {
    await env.DB
      .prepare(`
        INSERT INTO purchases(
          id,
          telegram_id,
          product_item_id,
          product_name,
          item_title,
          price
        )
        VALUES(?,?,?,?,?,?)
      `)
      .bind(
        orderId,
        String(userId),
        itemId,
        item.product_name,
        item.title,
        item.price
      )
      .run();

  } catch (e) {
    console.error(
      "purchase insert",
      e
    );
  }

  return sendOrEdit(
    env,
    chatId,
    messageId,
    `✅ <b>MUA HÀNG THÀNH CÔNG</b>\n\n` +

    `📦 Sản phẩm: <b>${esc(
      item.product_name
    )} ${esc(
      item.title
    )}</b>\n` +

    `💰 Đã thanh toán: <b>${money(
      item.price
    )}</b>\n` +

    `🧾 Mã đơn: <code>${orderId}</code>\n\n` +

    `📩 <b>Liên hệ Admin ${esc(
      env.ADMIN_USERNAME || ""
    )} để nhận key.</b>`,
    {
      inline_keyboard: [
        [
          {
            text: "🛍️ Mua Thêm",
            callback_data:
              "buy"
          }
        ],
        [
          {
            text: "🏠 Trang Chủ",
            callback_data:
              "home"
          }
        ]
      ]
    }
  );
}


/* =========================================================
   DEPOSIT
========================================================= */

async function promptDeposit(
  env,
  chatId,
  messageId,
  userId
) {
  try {
    await env.DB
      .prepare(`
        DELETE FROM deposits
        WHERE
          telegram_id=?
          AND status='INPUT'
      `)
      .bind(String(userId))
      .run();

    const inputId = rid("INPUT");

    /*
      deposits.content đang có UNIQUE constraint.
      Không được dùng "INPUT" cố định vì user khác có thể
      đang có một row INPUT với cùng content.
      Dùng giá trị riêng cho từng lần nhập tiền; sau khi
      nhập số tiền, createDeposit() sẽ thay bằng mã NAPxxxx.
    */
    const inputContent =
      `INPUT_${String(userId)}_${Date.now()}_${crypto.randomUUID()
        .replace(/-/g, "")
        .slice(0, 6)
        .toUpperCase()}`;

    await env.DB
      .prepare(`
        INSERT INTO deposits(
          id,
          telegram_id,
          amount,
          content,
          status,
          expires_at,
          created_at
        )
        VALUES(?,?,?,?,?,?,?)
      `)
      .bind(
        inputId,
        String(userId),
        0,
        inputContent,
        "INPUT",
        addMin(10),
        nowISO()
      )
      .run();

    return sendOrEdit(
      env,
      chatId,
      messageId,
      `💳 <b>NẠP TIỀN</b>\n\n` +
      `Nhập số tiền muốn nạp.\n\n` +
      `💰 Tối thiểu: <b>${money(
        env.MIN_DEPOSIT || 10000
      )}</b>\n\n` +
      `Ví dụ: <code>50000</code>`,
      {
        inline_keyboard: [
          [
            {
              text: "⬅️ Hủy",
              callback_data: "home"
            }
          ]
        ]
      }
    );
  } catch (e) {
    console.error("promptDeposit", e);

    // ACK was already sent in handleUpdate, so now send a real error
    // instead of silently failing.
    try {
      await tg(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          parse_mode: "HTML",
          text:
            `⚠️ <b>Không mở được Nạp Tiền.</b>\n\n` +
            `Lỗi hệ thống: <code>${esc(
              e?.message || e
            )}</code>`
        }
      );
    } catch (sendError) {
      console.error("promptDeposit error reply", sendError);
    }

    return false;
  }
}

async function createDeposit(
  env,
  message
) {
  const uid =
    String(message.from.id);

  /*
    Chỉ xử lý nếu user thực sự
    đang ở trạng thái INPUT.
  */

  let input;

  try {
    input = await env.DB
      .prepare(`
        SELECT *
        FROM deposits
        WHERE
          telegram_id=?
          AND status='INPUT'
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .bind(uid)
      .first();
  } catch (e) {
    console.error("createDeposit input lookup", e);

    await tg(
      env,
      "sendMessage",
      {
        chat_id: message.chat.id,
        parse_mode: "HTML",
        text:
          `⚠️ <b>Hệ thống nạp tiền đang lỗi.</b>

` +
          `Vui lòng báo Admin kiểm tra database.`
      }
    ).catch(err =>
      console.error("createDeposit error reply", err)
    );

    return true;
  }

  if (!input) {
    return false;
  }

  if (
    Date.parse(
      input.expires_at
    ) < Date.now()
  ) {
    await env.DB
      .prepare(`
        UPDATE deposits
        SET status='EXPIRED'
        WHERE id=?
      `)
      .bind(input.id)
      .run();

    return false;
  }

  const amount =
    parseMoney(message.text);

  const min =
    Number(
      env.MIN_DEPOSIT || 10000
    );

  if (
    !Number.isSafeInteger(amount) ||
    amount < min
  ) {
    await tg(
      env,
      "sendMessage",
      {
        chat_id:
          message.chat.id,

        text:
          `❌ Số tiền không hợp lệ.\n\n` +
          `Tối thiểu: <b>${money(
            min
          )}</b>\n\n` +
          `Nhập lại số tiền:`,

        parse_mode: "HTML"
      }
    );

    return true;
  }

  const id =
    rid("NAP");

  const content =
    `NAP${crypto.randomUUID()
      .replace(/-/g, "")
      .slice(0, 8)
      .toUpperCase()}`;

  await env.DB
    .prepare(`
      UPDATE deposits
      SET
        id=?,
        amount=?,
        content=?,
        status='PENDING',
        expires_at=?
      WHERE id=?
    `)
    .bind(
      id,
      amount,
      content,
      addMin(
        Number(
          env.PAYMENT_EXPIRE_MINUTES ||
          15
        )
      ),
      input.id
    )
    .run();

  const pendingDeposit =
    await env.DB
      .prepare(`
        SELECT *
        FROM deposits
        WHERE id=?
      `)
      .bind(id)
      .first();

  await notifyAdminDepositPending(
    env,
    pendingDeposit
  ).catch(
    e => console.error(
      "admin pending notification",
      e
    )
  );

  const qr =
    `https://img.vietqr.io/image/` +
    `MB-${encodeURIComponent(
      env.MB_BANK_ACCOUNT
    )}-compact2.png` +

    `?amount=${amount}` +

    `&addInfo=${encodeURIComponent(
      content
    )}` +

    `&accountName=${encodeURIComponent(
      env.BANK_ACCOUNT_NAME || ""
    )}`;

  await tg(
    env,
    "sendPhoto",
    {
      chat_id:
        message.chat.id,

      photo: qr,

      caption:
        `💳 <b>HÓA ĐƠN NẠP TIỀN</b>\n` +
        `━━━━━━━━━━━━\n\n` +

        `🏦 Ngân hàng: <b>${esc(
          env.BANK_NAME || "MB Bank"
        )}</b>\n` +

        `💳 STK: <code>${esc(
          env.MB_BANK_ACCOUNT
        )}</code>\n` +

        `👤 Chủ TK: <b>${esc(
          env.BANK_ACCOUNT_NAME
        )}</b>\n` +

        `💰 Số tiền: <b>${money(
          amount
        )}</b>\n` +

        `📝 Nội dung: <code>${content}</code>\n\n` +

        `⚠️ <b>Chuyển đúng số tiền và nội dung.</b>`,

      parse_mode: "HTML",

      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Trang Chủ",
              callback_data:
                "home"
            }
          ]
        ]
      }
    }
  );

  return true;
}


/* =========================================================
   PROFILE
========================================================= */

async function showProfile(
  env,
  chatId,
  messageId,
  user
) {
  const ref =
    `https://t.me/${env.BOT_USERNAME ||
      "YOUR_BOT"}?start=ref_${user.telegram_id}`;

  return sendOrEdit(
    env,
    chatId,
    messageId,
    `💎 <b>THÔNG TIN CÁ NHÂN</b>\n` +
    `━━━━━━━━━━━━\n\n` +

    `🆔 ID: <code>${user.telegram_id}</code>\n` +
    `👤 Tên: <b>${esc(
      user.first_name ||
      user.username ||
      "Không rõ"
    )}</b>\n` +

    `💳 Số dư: <b>${money(
      user.balance
    )}</b>\n` +

    `💰 Tổng nạp: <b>${money(
      user.total_deposit
    )}</b>\n` +

    `💸 Tổng chi: <b>${money(
      user.total_spent
    )}</b>\n\n` + 
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Trang Chủ",
            callback_data:
              "home"
          }
        ]
      ]
    }
  );
}


/* =========================================================
   TOP
========================================================= */

async function showTop(
  env,
  chatId,
  messageId,
  userId
) {
  const result = await env.DB.batch([
    env.DB.prepare(`
      SELECT
        telegram_id,
        username,
        first_name,
        total_deposit
      FROM users
      WHERE total_deposit>0
      ORDER BY total_deposit DESC
      LIMIT 10
    `),

    env.DB
      .prepare(`
        SELECT
          total_deposit
        FROM users
        WHERE telegram_id=?
      `)
      .bind(String(userId))
  ]);

  const top =
    result[0].results;

  const me =
    result[1].results[0];

  let rank =
    "Chưa xếp hạng";

  if (
    me &&
    Number(me.total_deposit) > 0
  ) {
    const r = await env.DB
      .prepare(`
        SELECT COUNT(*)+1 AS rank
        FROM users
        WHERE total_deposit>?
      `)
      .bind(me.total_deposit)
      .first();

    rank =
      `Top ${r.rank}`;
  }

  let text =
    `🏆 <b>TOP NẠP</b>\n` +
    `━━━━━━━━━━━━\n\n`;

  if (!top.length) {
    text +=
      `Chưa có dữ liệu.`;
  } else {
    top.forEach(
      (u, i) => {
        text +=
          `<b>Top ${i + 1}</b> — ` +
          `${esc(
            u.first_name ||
            u.username ||
            u.telegram_id
          )}: ` +

          `<b>${money(
            u.total_deposit
          )}</b>\n`;
      }
    );
  }

  text +=
    `\n📊 Xếp hạng của bạn: <b>${rank}</b>`;

  return sendOrEdit(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Trang Chủ",
            callback_data:
              "home"
          }
        ]
      ]
    }
  );
}


/* =========================================================
   HISTORY
========================================================= */

async function showHistory(
  env,
  chatId,
  messageId,
  userId
) {
  const ds = await env.DB
    .prepare(`
      SELECT *
      FROM deposits
      WHERE
        telegram_id=?
        AND status='PAID'
      ORDER BY paid_at DESC
      LIMIT 10
    `)
    .bind(String(userId))
    .all();

  let text =
    `📜 <b>LỊCH SỬ NẠP</b>\n` +
    `━━━━━━━━━━━━\n\n`;

  if (!ds.results.length) {
    text +=
      `Chưa có giao dịch nạp thành công.`;
  } else {
    ds.results.forEach(
      d => {
        const time =
          new Date(
            d.paid_at ||
            d.created_at
          ).toLocaleString(
            "vi-VN",
            {
              timeZone:
                "Asia/Ho_Chi_Minh"
            }
          );

        text +=
          `💰 Đã cộng: <b>${money(
            d.amount
          )}</b>\n` +

          `📝 Nội dung: <code>${esc(
            d.content
          )}</code>\n` +

          `🔖 Mã GD: <code>${esc(
            d.bank_transaction_id ||
            d.id
          )}</code>\n` +

          `🕒 ${esc(time)}\n\n`;
      }
    );
  }

  return sendOrEdit(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Trang Chủ",
            callback_data:
              "home"
          }
        ]
      ]
    }
  );
}


/* =========================================================
   SUPPORT
========================================================= */

async function showSupport(
  env,
  chatId,
  messageId
) {
  return sendOrEdit(
    env,
    chatId,
    messageId,
    `🔐 <b>HỖ TRỢ</b>\n` +
    `━━━━━━━━━━━━\n\n` +

    `1. Chọn chức năng cần dùng.\n` +
    `2. Nạp đúng số tiền và nội dung.\n` +
    `3. Hệ thống tự kiểm tra giao dịch.\n` +
    `4. Nếu chưa nhận tiền, liên hệ Admin.\n\n` +

    `👤 Admin: ${esc(
      env.ADMIN_USERNAME || ""
    )}\n\n` +

    `${esc(
      env.SUPPORT_TEXT || ""
    )}`,
    {
      inline_keyboard: [
        [
          {
            text:
              "💬 Liên Hệ Admin",

            url:
              `https://t.me/${String(
                env.ADMIN_USERNAME || ""
              ).replace("@", "")}`
          }
        ],
        [
          {
            text: "⬅️ Trang Chủ",
            callback_data:
              "home"
          }
        ]
      ]
    }
  );
}


/* =========================================================
   MB AUTH
========================================================= */

async function getMbAccessToken(
  env
) {
  if (
    tokenCache.value &&
    tokenCache.expires >
      Date.now() + 60000
  ) {
    return tokenCache.value;
  }

  if (
    !env.MB_TOKEN_URL ||
    !env.MB_CLIENT_ID ||
    !env.MB_CLIENT_SECRET
  ) {
    throw new Error(
      "Thiếu cấu hình MB token"
    );
  }

  const basic = btoa(
    `${env.MB_CLIENT_ID}:${env.MB_CLIENT_SECRET}`
  );

  const body =
    new URLSearchParams({
      grant_type:
        "client_credentials"
    });

  const r = await fetch(
    env.MB_TOKEN_URL,
    {
      method: "POST",

      headers: {
        Authorization:
          `Basic ${basic}`,

        "Content-Type":
          "application/x-www-form-urlencoded",

        Accept:
          "application/json"
      },

      body:
        body.toString()
    }
  );

  const j =
    await r.json()
      .catch(() => ({}));

  if (
    !r.ok ||
    !j.access_token
  ) {
    throw new Error(
      `Không lấy được MB token: ${
        j.message ||
        j.error ||
        r.status
      }`
    );
  }

  tokenCache = {
    value:
      j.access_token,

    expires:
      Date.now() +
      Math.max(
        60,
        Number(
          j.expires_in
        ) || 300
      ) * 1000
  };

  return tokenCache.value;
}


async function getMbTransactions(
  env
) {
  if (!env.MB_TRANSACTION_URL) {
    throw new Error(
      "MB_TRANSACTION_URL chưa được cấu hình"
    );
  }

  const token =
    await getMbAccessToken(env);

  const method =
    String(
      env.MB_TRANSACTION_METHOD ||
      "GET"
    ).toUpperCase();

  const r = await fetch(
    env.MB_TRANSACTION_URL,
    {
      method,

      headers: {
        Authorization:
          `Bearer ${token}`,

        Accept:
          "application/json",

        "Content-Type":
          "application/json"
      },

      body:
        method === "GET"
          ? undefined
          : JSON.stringify({})
    }
  );

  const text =
    await r.text();

  if (!r.ok) {
    throw new Error(
      `MB API ${r.status}: ${text.slice(
        0,
        300
      )}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "MB transaction API không trả JSON"
    );
  }
}


function flattenTransactions(
  data
) {
  if (Array.isArray(data)) {
    return data;
  }

  const paths = [
    data?.data?.transactions,
    data?.data?.transactionList,
    data?.data?.items,
    data?.data,
    data?.transactions,
    data?.items,
    data?.result
  ];

  return (
    paths.find(
      Array.isArray
    ) || []
  );
}


function txAmount(tx) {
  return Number(
    tx.amount ??
    tx.transactionAmount ??
    tx.creditAmount ??
    tx.value ??
    0
  );
}


function txContent(tx) {
  return String(
    tx.description ??
    tx.content ??
    tx.remark ??
    tx.transactionDescription ??
    tx.addInfo ??
    ""
  ).toUpperCase();
}


function txId(tx) {
  return String(
    tx.transactionId ??
    tx.transaction_id ??
    tx.id ??
    tx.refNo ??
    tx.referenceNo ??
    ""
  );
}


/* =========================================================
   ADMIN DEPOSIT NOTIFICATIONS + PAYMENT SETTLEMENT
========================================================= */

async function notifyAdminDepositPending(env, d) {
  if (!d) return;

  const claim = await env.DB
    .prepare(`
      UPDATE deposits
      SET admin_pending_notified_at=?
      WHERE
        id=?
        AND (
          admin_pending_notified_at IS NULL
          OR admin_pending_notified_at=''
        )
    `)
    .bind(nowISO(), d.id)
    .run();

  if (Number(claim.meta.changes) !== 1) return;

  try {
    await tg(env, "sendMessage", {
      chat_id: ADMIN_ID,
      parse_mode: "HTML",
      text:
        `📢 <b>Thông Báo: Admin 🧑‍💻</b>\n\n` +
        `🆔 <b>Mã Đơn:</b> <code>${esc(d.content)}</code>\n` +
        `🛒 <b>Đơn Hàng:</b> 💰Nạp Tiền\n` +
        `📌 <b>Trạng Thái:</b> Chưa Xử Lí`
    });
  } catch (e) {
    await env.DB
      .prepare(`
        UPDATE deposits
        SET admin_pending_notified_at=NULL
        WHERE id=?
      `)
      .bind(d.id)
      .run();
    throw e;
  }
}


async function notifyAdminDepositPaid(env, d) {
  if (!d) return;

  const claim = await env.DB
    .prepare(`
      UPDATE deposits
      SET admin_paid_notified_at=?
      WHERE
        id=?
        AND (
          admin_paid_notified_at IS NULL
          OR admin_paid_notified_at=''
        )
    `)
    .bind(nowISO(), d.id)
    .run();

  if (Number(claim.meta.changes) !== 1) return;

  try {
    await tg(env, "sendMessage", {
      chat_id: ADMIN_ID,
      parse_mode: "HTML",
      text:
        `📢 <b>Thông Báo: Admin 🧑‍💻</b>\n\n` +
        `🆔 <b>Mã Đơn:</b> <code>${esc(d.content)}</code>\n` +
        `🛒 <b>Đơn Hàng:</b> 💰Nạp Tiền\n` +
        `📌 <b>Trạng Thái:</b> Húp`
    });
  } catch (e) {
    await env.DB
      .prepare(`
        UPDATE deposits
        SET admin_paid_notified_at=NULL
        WHERE id=?
      `)
      .bind(d.id)
      .run();
    throw e;
  }
}


async function settleDeposit(env, d, transactionId, rawTransaction) {
  if (!d || d.status !== "PENDING") return d;

  const existing = await env.DB
    .prepare(`
      SELECT id, status
      FROM deposits
      WHERE bank_transaction_id=?
      LIMIT 1
    `)
    .bind(String(transactionId))
    .first();

  if (existing) {
    return env.DB
      .prepare(`SELECT * FROM deposits WHERE id=?`)
      .bind(d.id)
      .first();
  }

  const claim = await env.DB
    .prepare(`
      UPDATE deposits
      SET
        status='PAID',
        bank_transaction_id=?,
        bank_raw=?,
        paid_at=?
      WHERE
        id=?
        AND status='PENDING'
    `)
    .bind(
      String(transactionId),
      String(rawTransaction || "").slice(0, 20000),
      nowISO(),
      d.id
    )
    .run();

  if (Number(claim.meta.changes) !== 1) {
    return env.DB
      .prepare(`SELECT * FROM deposits WHERE id=?`)
      .bind(d.id)
      .first();
  }

  const userUpdate = await env.DB
    .prepare(`
      UPDATE users
      SET
        balance=balance+?,
        total_deposit=total_deposit+?
      WHERE telegram_id=?
    `)
    .bind(
      Number(d.amount),
      Number(d.amount),
      d.telegram_id
    )
    .run();

  if (Number(userUpdate.meta.changes) !== 1) {
    console.error(
      "DEPOSIT PAID nhưng không tìm thấy user:",
      d.telegram_id,
      d.id
    );
  }

  const paid = await env.DB
    .prepare(`SELECT * FROM deposits WHERE id=?`)
    .bind(d.id)
    .first();

  await notifyAdminDepositPaid(env, paid).catch(
    e => console.error("admin paid notification", e)
  );

  await notifyPaid(env, paid).catch(
    e => console.error("user paid notification", e)
  );

  return paid;
}


/* =========================================================
   SEPAY WEBHOOK
========================================================= */

async function verifySePayWebhook(request, rawBody, env) {
  /*
    Hỗ trợ API Key:
      SEPAY_WEBHOOK_API_KEY

    Nếu m dùng HMAC-SHA256 thì đặt:
      SEPAY_WEBHOOK_SECRET

    Có một trong hai là đủ.
  */

  if (env.SEPAY_WEBHOOK_API_KEY) {
    const auth = request.headers.get("Authorization") || "";
    const expected = `Apikey ${env.SEPAY_WEBHOOK_API_KEY}`;

    if (auth === expected) return true;
  }

  if (!env.SEPAY_WEBHOOK_SECRET) return false;

  const signature =
    request.headers.get("X-SePay-Signature") || "";

  const timestamp =
    request.headers.get("X-SePay-Timestamp") || "";

  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);

  /*
    Chống replay webhook quá 5 phút.
  */
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SEPAY_WEBHOOK_SECRET),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );

  const hex = Array.from(new Uint8Array(signed))
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");

  return signature === `sha256=${hex}`;
}


function sepayTransferAmount(payload) {
  return Number(
    payload.transferAmount ??
    payload.amount ??
    payload.transactionAmount ??
    0
  );
}


function sepayTransferContent(payload) {
  return String(
    payload.content ??
    payload.description ??
    payload.addInfo ??
    payload.transferDescription ??
    ""
  ).toUpperCase();
}


function sepayTransferId(payload) {
  return String(
    payload.id ??
    payload.transactionId ??
    payload.transaction_id ??
    payload.referenceCode ??
    payload.referenceNo ??
    ""
  );
}


async function handleSePayWebhook(request, env) {
  const rawBody = await request.text();

  const verified = await verifySePayWebhook(
    request,
    rawBody,
    env
  );

  if (!verified) {
    return new Response("Unauthorized", {
      status: 401
    });
  }

  let payload;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad JSON", {
      status: 400
    });
  }

  const transferType = String(
    payload.transferType ??
    payload.transfer_type ??
    ""
  ).toLowerCase();

  /*
    Chỉ xử lý tiền vào.
  */
  if (
    transferType === "out" ||
    transferType === "debit"
  ) {
    return new Response("OK");
  }

  const amount = sepayTransferAmount(payload);
  const content = sepayTransferContent(payload);
  const transactionId = sepayTransferId(payload);

  if (!amount || amount <= 0 || !transactionId) {
    return new Response("OK");
  }

  /*
    Nếu khai báo SEPAY_BANK_ACCOUNT thì bắt buộc
    giao dịch phải vào đúng tài khoản này.
  */
  if (env.SEPAY_BANK_ACCOUNT) {
    const accountNumber = String(
      payload.accountNumber ??
      payload.account_number ??
      ""
    );

    if (
      accountNumber &&
      accountNumber !== String(env.SEPAY_BANK_ACCOUNT)
    ) {
      return new Response("OK");
    }
  }

  /*
    Tìm đơn PENDING theo số tiền + mã NAP.
  */
  const pending = await env.DB
    .prepare(`
      SELECT *
      FROM deposits
      WHERE
        status='PENDING'
        AND expires_at>?
        AND amount=?
      ORDER BY created_at ASC
      LIMIT 50
    `)
    .bind(nowISO(), amount)
    .all();

  const sepayAccount =
    String(
      payload.accountNumber ??
      payload.account_number ??
      payload.accountNo ??
      payload.account ??
      ""
    ).trim();

  const configuredAccount =
    String(
      env.SEPAY_BANK_ACCOUNT ||
      env.MB_ACCOUNT_NUMBER ||
      ""
    ).trim();

  if (
    configuredAccount &&
    (
      !sepayAccount ||
      sepayAccount !== configuredAccount
    )
  ) {
    console.log(
      "Bỏ qua SePay webhook: sai tài khoản nhận",
      {
        received: sepayAccount,
        expected: configuredAccount
      }
    );

    return new Response("OK");
  }

  const d = (pending.results || []).find(
    x =>
      content.includes(
        String(x.content || "").toUpperCase()
      )
  );

  if (!d) {
    /*
      Giao dịch không thuộc bot thì trả 200 để
      SePay không retry vô hạn.
    */
    return new Response("OK");
  }

  const result = await settleDeposit(
    env,
    d,
    transactionId,
    rawBody
  );

  if (result?.status === "PAID") {
    return new Response("OK");
  }

  return new Response("OK");
}


/* =========================================================
   CHECK DEPOSIT
========================================================= */

async function checkDeposit(
  env,
  depositId
) {
  const d = await env.DB
    .prepare(`
      SELECT *
      FROM deposits
      WHERE id=?
    `)
    .bind(depositId)
    .first();

  if (
    !d ||
    d.status !== "PENDING"
  ) {
    return d;
  }

  if (
    Date.parse(
      d.expires_at
    ) <= Date.now()
  ) {
    await env.DB
      .prepare(`
        UPDATE deposits
        SET status='EXPIRED'
        WHERE
          id=?
          AND status='PENDING'
      `)
      .bind(d.id)
      .run();

    return {
      ...d,
      status: "EXPIRED"
    };
  }

  const data =
    await getMbTransactions(env);

  const match =
    flattenTransactions(
      data
    ).find(
      tx =>
        txAmount(tx) ===
          Number(d.amount) &&

        txContent(tx).includes(
          String(
            d.content
          ).toUpperCase()
        )
    );

  if (!match) {
    return d;
  }

  const transactionId =
    txId(match) ||
    rid("MB");

  return settleDeposit(
    env,
    d,
    transactionId,
    JSON.stringify(match)
  );
}


async function notifyPaid(
  env,
  d
) {
  /*
    Chống gửi notification trùng.
  */

  const claim = await env.DB
    .prepare(`
      UPDATE deposits
      SET notified_at=?
      WHERE
        id=?
        AND (
          notified_at IS NULL
          OR notified_at=''
        )
    `)
    .bind(
      nowISO(),
      d.id
    )
    .run();

  if (
    Number(
      claim.meta.changes
    ) !== 1
  ) {
    return;
  }

  const user = await env.DB
    .prepare(`
      SELECT *
      FROM users
      WHERE telegram_id=?
    `)
    .bind(d.telegram_id)
    .first();

  if (!user) {
    return;
  }

  try {
    await tg(
      env,
      "sendMessage",
      {
        chat_id:
          d.telegram_id,

        parse_mode:
          "HTML",

        text:
          `✅ <b>NẠP TIỀN THÀNH CÔNG</b>\n\n` +

          `💰 Đã cộng: <b>${money(
            d.amount
          )}</b>\n` +

          `📝 Nội dung: <code>${esc(
            d.content
          )}</code>\n` +

          `🔖 Mã giao dịch: <code>${esc(
            d.bank_transaction_id
          )}</code>\n` +

          `💳 Số dư mới: <b>${money(
            user.balance
          )}</b>`
      }
    );

  } catch (e) {
    /*
      Reset để cron lần sau
      có thể gửi lại.
    */

    await env.DB
      .prepare(`
        UPDATE deposits
        SET notified_at=NULL
        WHERE id=?
      `)
      .bind(d.id)
      .run();

    throw e;
  }
}


/* =========================================================
   ADMIN MESSAGE HANDLER
========================================================= */

async function handleAdminMessage(
  env,
  message
) {
  if (!isAdmin(message.from.id)) {
    return false;
  }

  const state =
    await getAdminState(
      env,
      message.from.id
    );

  if (!state) {
    return false;
  }

  const text =
    String(
      message.text || ""
    ).trim();

  if (!text) {
    return true;
  }

  const chatId =
    message.chat.id;

  const userId =
    message.from.id;

  /*
    CANCEL
  */

  if (
    text.toLowerCase() === "/cancel" ||
    text.toLowerCase() === "hủy" ||
    text.toLowerCase() === "huy"
  ) {
    await clearAdminState(
      env,
      userId
    );

    await sendOrEdit(
      env,
      chatId,
      null,
      `❌ Đã hủy thao tác.`,
      {
        inline_keyboard: [
          [
            {
              text:
                "🛠️ Admin Panel",
              callback_data:
                "admin"
            }
          ]
        ]
      }
    );

    return true;
  }


  /*
    ADD PRODUCT
  */

  if (
    state.action ===
    "ADD_PRODUCT_NAME"
  ) {
    if (
      text.length < 2 ||
      text.length > 100
    ) {
      await tg(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          parse_mode: "HTML",
          text:
            `❌ Tên sản phẩm phải từ 2 đến 100 ký tự.\n` +
            `Nhập lại hoặc /cancel`
        }
      );

      return true;
    }

    await setAdminState(
      env,
      userId,
      "ADD_PRODUCT_ID",
      {
        name: text
      }
    );

    await tg(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `📦 Tên: <b>${esc(
            text
          )}</b>\n\n` +

          `Bây giờ nhập <b>ID sản phẩm</b>.\n\n` +

          `Ví dụ: <code>${slugify(
            text
          )}</code>\n\n` +

          `ID chỉ gồm chữ, số và dấu -.`
      }
    );

    return true;
  }


  if (
    state.action ===
    "ADD_PRODUCT_ID"
  ) {
    const id =
      slugify(text);

    const exists = await env.DB
      .prepare(`
        SELECT id
        FROM products
        WHERE id=?
      `)
      .bind(id)
      .first();

    if (exists) {
      await tg(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `❌ ID này đã tồn tại.\n` +
            `Nhập ID khác hoặc /cancel`
        }
      );

      return true;
    }

    const max = await env.DB
      .prepare(`
        SELECT
          COALESCE(
            MAX(sort_order),
            0
          ) AS max_sort
        FROM products
      `)
      .first();

    await env.DB
      .prepare(`
        INSERT INTO products(
          id,
          name,
          sort_order,
          active
        )
        VALUES(?,?,?,1)
      `)
      .bind(
        id,
        state.payload.name,
        Number(max.max_sort || 0) + 1
      )
      .run();

    await clearAdminState(
      env,
      userId
    );

    await sendOrEdit(
      env,
      chatId,
      null,
      `✅ <b>ĐÃ THÊM SẢN PHẨM</b>\n\n` +

      `📦 ${esc(
        state.payload.name
      )}\n` +

      `🆔 <code>${id}</code>`,
      {
        inline_keyboard: [
          [
            {
              text:
                "➕ Thêm Gói",
              callback_data:
                `admin_add_item:${id}`
            }
          ],
          [
            {
              text:
                "⚙️ Quản Lý",
              callback_data:
                `ap:${id}`
            }
          ]
        ]
      }
    );

    return true;
  }


  /*
    EDIT PRODUCT NAME
  */

  if (
    state.action ===
    "EDIT_PRODUCT_NAME"
  ) {
    if (
      text.length < 2 ||
      text.length > 100
    ) {
      return true;
    }

    await env.DB
      .prepare(`
        UPDATE products
        SET name=?
        WHERE id=?
      `)
      .bind(
        text,
        state.payload.productId
      )
      .run();

    await clearAdminState(
      env,
      userId
    );

    await sendOrEdit(
      env,
      chatId,
      null,
      `✅ Đã sửa tên sản phẩm thành:\n\n` +
      `<b>${esc(text)}</b>`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Quay Lại",
              callback_data:
                `ap:${state.payload.productId}`
            }
          ]
        ]
      }
    );

    return true;
  }


  /*
    ADD ITEM TITLE
  */

  if (
    state.action ===
    "ADD_ITEM_TITLE"
  ) {
    await setAdminState(
      env,
      userId,
      "ADD_ITEM_PRICE",
      {
        ...state.payload,
        title: text
      }
    );

    await tg(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `💰 Nhập giá cho gói <b>${esc(
            text
          )}</b>\n\n` +

          `Ví dụ: <code>50000</code>`
      }
    );

    return true;
  }


  if (
    state.action ===
    "ADD_ITEM_PRICE"
  ) {
    const price =
      parseMoney(text);

    if (
      !Number.isSafeInteger(price) ||
      price < 0
    ) {
      await tg(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `❌ Giá không hợp lệ.\nNhập lại.`
        }
      );

      return true;
    }

    await setAdminState(
      env,
      userId,
      "ADD_ITEM_STOCK",
      {
        ...state.payload,
        price
      }
    );

    await tg(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `📦 Nhập số lượng kho.\n\n` +
          `Ví dụ: <code>100</code>`
      }
    );

    return true;
  }


  if (
    state.action ===
    "ADD_ITEM_STOCK"
  ) {
    const stock =
      parseMoney(text);

    if (
      !Number.isSafeInteger(stock) ||
      stock < 0
    ) {
      return true;
    }

    const productId =
      state.payload.productId;

    const max = await env.DB
      .prepare(`
        SELECT
          COALESCE(
            MAX(sort_order),
            0
          ) AS max_sort
        FROM product_items
        WHERE product_id=?
      `)
      .bind(productId)
      .first();

    const itemId =
      rid("ITEM");

    await env.DB
      .prepare(`
        INSERT INTO product_items(
          id,
          product_id,
          title,
          price,
          stock,
          sort_order
        )
        VALUES(?,?,?,?,?,?)
      `)
      .bind(
        itemId,
        productId,
        state.payload.title,
        state.payload.price,
        stock,
        Number(max.max_sort || 0) + 1
      )
      .run();

    await clearAdminState(
      env,
      userId
    );

    await sendOrEdit(
      env,
      chatId,
      null,
      `✅ <b>ĐÃ THÊM GÓI</b>\n\n` +

      `🏷️ ${esc(
        state.payload.title
      )}\n` +

      `💰 ${money(
        state.payload.price
      )}\n` +

      `📦 Kho: ${stock}`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⚙️ Quản Lý Gói",
              callback_data:
                `ai:${itemId}`
            }
          ],
          [
            {
              text:
                "⬅️ Sản Phẩm",
              callback_data:
                `ap:${productId}`
            }
          ]
        ]
      }
    );

    return true;
  }


  /*
    EDIT ITEM TITLE
  */

  if (
    state.action ===
    "EDIT_ITEM_TITLE"
  ) {
    await env.DB
      .prepare(`
        UPDATE product_items
        SET title=?
        WHERE id=?
      `)
      .bind(
        text,
        state.payload.itemId
      )
      .run();

    await clearAdminState(
      env,
      userId
    );

    return sendOrEdit(
      env,
      chatId,
      null,
      `✅ Đã sửa tên gói.`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Quay Lại",
              callback_data:
                `ai:${state.payload.itemId}`
            }
          ]
        ]
      }
    );
  }


  /*
    EDIT ITEM PRICE
  */

  if (
    state.action ===
    "EDIT_ITEM_PRICE"
  ) {
    const price =
      parseMoney(text);

    if (
      !Number.isSafeInteger(price) ||
      price < 0
    ) {
      return true;
    }

    await env.DB
      .prepare(`
        UPDATE product_items
        SET price=?
        WHERE id=?
      `)
      .bind(
        price,
        state.payload.itemId
      )
      .run();

    await clearAdminState(
      env,
      userId
    );

    return sendOrEdit(
      env,
      chatId,
      null,
      `✅ Đã sửa giá thành <b>${money(
        price
      )}</b>`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Quay Lại",
              callback_data:
                `ai:${state.payload.itemId}`
            }
          ]
        ]
      }
    );
  }


  /*
    EDIT ITEM STOCK
  */

  if (
    state.action ===
    "EDIT_ITEM_STOCK"
  ) {
    const stock =
      parseMoney(text);

    if (
      !Number.isSafeInteger(stock) ||
      stock < 0
    ) {
      return true;
    }

    await env.DB
      .prepare(`
        UPDATE product_items
        SET stock=?
        WHERE id=?
      `)
      .bind(
        stock,
        state.payload.itemId
      )
      .run();

    await clearAdminState(
      env,
      userId
    );

    return sendOrEdit(
      env,
      chatId,
      null,
      `✅ Đã cập nhật kho: <b>${stock}</b>`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Quay Lại",
              callback_data:
                `ai:${state.payload.itemId}`
            }
          ]
        ]
      }
    );
  }


  /*
    FIND USER
  */

  if (
    state.action ===
    "FIND_USER"
  ) {
    const search =
      text.replace("@", "");

    let user = await env.DB
      .prepare(`
        SELECT *
        FROM users
        WHERE telegram_id=?
      `)
      .bind(search)
      .first();

    if (!user) {
      user = await env.DB
        .prepare(`
          SELECT *
          FROM users
          WHERE LOWER(username)=LOWER(?)
          LIMIT 1
        `)
        .bind(search)
        .first();
    }

    await clearAdminState(
      env,
      userId
    );

    if (!user) {
      await sendOrEdit(
        env,
        chatId,
        null,
        `❌ Không tìm thấy user.`,
        {
          inline_keyboard: [
            [
              {
                text:
                  "🔎 Tìm Lại",
                callback_data:
                  "admin_find_user"
              }
            ],
            [
              {
                text:
                  "⬅️ Admin",
                callback_data:
                  "admin"
              }
            ]
          ]
        }
      );

      return true;
    }

    await sendOrEdit(
      env,
      chatId,
      null,
      `👤 <b>THÔNG TIN USER</b>\n` +
      `━━━━━━━━━━━━\n\n` +

      `🆔 <code>${user.telegram_id}</code>\n` +

      `👤 ${esc(
        user.first_name ||
        user.username ||
        "Không rõ"
      )}\n` +

      `💳 Số dư: <b>${money(
        user.balance
      )}</b>\n` +

      `💰 Tổng nạp: <b>${money(
        user.total_deposit
      )}</b>\n` +

      `💸 Tổng chi: <b>${money(
        user.total_spent
      )}</b>`,
      {
        inline_keyboard: [
          [
            {
              text:
                "💰 Cộng Tiền User Này",
              callback_data:
                `admin_credit:${user.telegram_id}`
            }
          ],
          [
            {
              text:
                "⬅️ Admin",
              callback_data:
                "admin"
            }
          ]
        ]
      }
    );

    return true;
  }


  /*
    ADD MONEY SEARCH USER
  */

  if (
    state.action ===
    "ADD_MONEY_USER"
  ) {
    const search =
      text.replace("@", "");

    let target = await env.DB
      .prepare(`
        SELECT *
        FROM users
        WHERE telegram_id=?
      `)
      .bind(search)
      .first();

    if (!target) {
      target = await env.DB
        .prepare(`
          SELECT *
          FROM users
          WHERE LOWER(username)=LOWER(?)
          LIMIT 1
        `)
        .bind(search)
        .first();
    }

    if (!target) {
      await tg(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            `❌ Không tìm thấy user.\n` +
            `Nhập lại ID hoặc username.`
        }
      );

      return true;
    }

    await setAdminState(
      env,
      userId,
      "ADD_MONEY_AMOUNT",
      {
        targetId:
          target.telegram_id,

        targetName:
          target.first_name ||
          target.username ||
          target.telegram_id
      }
    );

    await tg(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `👤 User: <b>${esc(
            target.first_name ||
            target.username ||
            target.telegram_id
          )}</b>\n` +

          `🆔 <code>${target.telegram_id}</code>\n` +

          `💳 Số dư hiện tại: <b>${money(
            target.balance
          )}</b>\n\n` +

          `💰 Nhập số tiền muốn cộng:`
      }
    );

    return true;
  }


  /*
    ADD MONEY AMOUNT
  */

  if (
    state.action ===
    "ADD_MONEY_AMOUNT"
  ) {
    const amount =
      parseMoney(text);

    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0
    ) {
      return true;
    }

    const targetId =
      state.payload.targetId;

    const before = await env.DB
      .prepare(`
        SELECT *
        FROM users
        WHERE telegram_id=?
      `)
      .bind(targetId)
      .first();

    if (!before) {
      await clearAdminState(
        env,
        userId
      );

      return true;
    }

    await env.DB
      .prepare(`
        UPDATE users
        SET balance=balance+?
        WHERE telegram_id=?
      `)
      .bind(
        amount,
        targetId
      )
      .run();

    const after = await env.DB
      .prepare(`
        SELECT *
        FROM users
        WHERE telegram_id=?
      `)
      .bind(targetId)
      .first();

    await clearAdminState(
      env,
      userId
    );

    await sendOrEdit(
      env,
      chatId,
      null,
      `✅ <b>ĐÃ CỘNG TIỀN</b>\n\n` +

      `👤 ${esc(
        after.first_name ||
        after.username ||
        after.telegram_id
      )}\n` +

      `🆔 <code>${targetId}</code>\n` +

      `➕ Đã cộng: <b>${money(
        amount
      )}</b>\n` +

      `💳 Số dư mới: <b>${money(
        after.balance
      )}</b>`,
      {
        inline_keyboard: [
          [
            {
              text:
                "💰 Cộng Tiếp",
              callback_data:
                `admin_credit:${targetId}`
            }
          ],
          [
            {
              text:
                "⬅️ Admin",
              callback_data:
                "admin"
            }
          ]
        ]
      }
    );

    /*
      Thông báo user nhưng nếu Telegram lỗi
      không làm hỏng thao tác admin.
    */

    tg(
      env,
      "sendMessage",
      {
        chat_id: targetId,
        parse_mode: "HTML",
        text:
          `💰 <b>BẠN ĐƯỢC CỘNG TIỀN</b>\n\n` +

          `➕ Số tiền: <b>${money(
            amount
          )}</b>\n` +

          `💳 Số dư hiện tại: <b>${money(
            after.balance
          )}</b>`
      }
    ).catch(
      e => console.error(
        "notify credit",
        e
      )
    );

    return true;
  }

  return false;
}


/* =========================================================
   HANDLE UPDATE
========================================================= */

async function handleUpdate(
  env,
  update
) {
  await ensureSeed(env);


  /* =======================================================
     MESSAGE
  ======================================================= */

  if (update.message?.from) {
    const m =
      update.message;

    await ensureUser(
      env,
      m.from
    );

    if (
      m.text &&
      m.text.startsWith("/start")
    ) {
      await clearAdminState(
        env,
        m.from.id
      );

      return showHome(
        env,
        m.chat.id,
        null,
        m.from.first_name ||
          m.from.username ||
          "bạn",
        m.from.id
      );
    }

    if (m.text) {
      /*
        ADMIN INPUT xử lý trước.
      */

      const adminHandled =
        await handleAdminMessage(
          env,
          m
        );

      if (adminHandled) {
        return;
      }

      /*
        Sau đó mới xử lý nạp tiền.
      */

      const created =
        await createDeposit(
          env,
          m
        );

      if (created) {
        return;
      }
    }

    return;
  }


  /* =======================================================
     CALLBACK
  ======================================================= */

  if (!update.callback_query) {
    return;
  }

  const q =
    update.callback_query;

  const chatId =
    q.message.chat.id;

  const msgId =
    q.message.message_id;

  const userId =
    q.from.id;

  const data =
    q.data || "";

  /*
    ACK CALLBACK NGAY.
    Đây là phần giúp Telegram không hiện loading lâu.
  */

  await tg(
    env,
    "answerCallbackQuery",
    {
      callback_query_id:
        q.id
    }
  ).catch(() => {});

  const user =
    await ensureUser(
      env,
      q.from
    );


  /* =======================================================
     NOOP
  ======================================================= */

  if (data === "noop") {
    return;
  }


  /* =======================================================
     HOME
  ======================================================= */

  if (data === "home") {
    return showHome(
      env,
      chatId,
      msgId,
      q.from.first_name ||
        q.from.username ||
        "bạn",
      userId
    );
  }


  /* =======================================================
     ADMIN CHECK
  ======================================================= */

  const adminActions =
    data === "admin" ||
    data.startsWith("admin_") ||
    data.startsWith("ap:") ||
    data.startsWith("ai:");

  if (
    adminActions &&
    !isAdmin(userId)
  ) {
    return;
  }


  /* =======================================================
     ADMIN PANEL
  ======================================================= */

  if (data === "admin") {
    await clearAdminState(
      env,
      userId
    );

    return showAdminPanel(
      env,
      chatId,
      msgId
    );
  }


  if (
    data === "admin_products"
  ) {
    return showAdminProducts(
      env,
      chatId,
      msgId
    );
  }


  if (
    data.startsWith("ap:")
  ) {
    return showAdminProduct(
      env,
      chatId,
      msgId,
      data.slice(3)
    );
  }


  if (
    data.startsWith("ai:")
  ) {
    return showAdminItem(
      env,
      chatId,
      msgId,
      data.slice(3)
    );
  }


  /* =======================================================
     ADD PRODUCT
  ======================================================= */

  if (
    data === "admin_add_product"
  ) {
    await setAdminState(
      env,
      userId,
      "ADD_PRODUCT_NAME"
    );

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `➕ <b>THÊM SẢN PHẨM</b>\n\n` +

      `Nhập tên sản phẩm.\n\n` +

      `Ví dụ: <code>Migui Premium</code>\n\n` +

      `Gõ /cancel để hủy.`,
      {
        inline_keyboard: [
          [
            {
              text:
                "❌ Hủy",
              callback_data:
                "admin"
            }
          ]
        ]
      }
    );
  }


  /* =======================================================
     EDIT PRODUCT
  ======================================================= */

  if (
    data.startsWith(
      "admin_edit_product:"
    )
  ) {
    const productId =
      data.slice(
        "admin_edit_product:".length
      );

    await setAdminState(
      env,
      userId,
      "EDIT_PRODUCT_NAME",
      {
        productId
      }
    );

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `✏️ Nhập tên mới cho sản phẩm.\n\n` +
      `Gõ /cancel để hủy.`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Quay Lại",
              callback_data:
                `ap:${productId}`
            }
          ]
        ]
      }
    );
  }


  /* =======================================================
     TOGGLE PRODUCT
  ======================================================= */

  if (
    data.startsWith(
      "admin_toggle_product:"
    )
  ) {
    const productId =
      data.slice(
        "admin_toggle_product:".length
      );

    await env.DB
      .prepare(`
        UPDATE products
        SET active=
          CASE
            WHEN active=1 THEN 0
            ELSE 1
          END
        WHERE id=?
      `)
      .bind(productId)
      .run();

    return showAdminProduct(
      env,
      chatId,
      msgId,
      productId
    );
  }


  /* =======================================================
     DELETE PRODUCT
  ======================================================= */

  if (
    data.startsWith(
      "admin_delete_product:"
    )
  ) {
    const productId =
      data.slice(
        "admin_delete_product:".length
      );

    const p = await env.DB
      .prepare(`
        SELECT *
        FROM products
        WHERE id=?
      `)
      .bind(productId)
      .first();

    if (!p) {
      return showAdminProducts(
        env,
        chatId,
        msgId
      );
    }

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `⚠️ <b>XÁC NHẬN XÓA</b>\n\n` +

      `Bạn có chắc muốn xóa:\n` +

      `📦 <b>${esc(
        p.name
      )}</b>\n\n` +

      `Toàn bộ gói bên trong cũng sẽ bị xóa.`,
      {
        inline_keyboard: [
          [
            {
              text:
                "🗑️ XÓA VĨNH VIỄN",
              callback_data:
                `admin_delete_product_yes:${productId}`
            }
          ],
          [
            {
              text:
                "❌ Hủy",
              callback_data:
                `ap:${productId}`
            }
          ]
        ]
      }
    );
  }


  if (
    data.startsWith(
      "admin_delete_product_yes:"
    )
  ) {
    const productId =
      data.slice(
        "admin_delete_product_yes:".length
      );

    await env.DB.batch([
      env.DB
        .prepare(`
          DELETE FROM product_items
          WHERE product_id=?
        `)
        .bind(productId),

      env.DB
        .prepare(`
          DELETE FROM products
          WHERE id=?
        `)
        .bind(productId)
    ]);

    return showAdminProducts(
      env,
      chatId,
      msgId
    );
  }


  /* =======================================================
     ADD ITEM
  ======================================================= */

  if (
    data.startsWith(
      "admin_add_item:"
    )
  ) {
    const productId =
      data.slice(
        "admin_add_item:".length
      );

    await setAdminState(
      env,
      userId,
      "ADD_ITEM_TITLE",
      {
        productId
      }
    );

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `➕ <b>THÊM GÓI SẢN PHẨM</b>\n\n` +

      `Nhập tên gói.\n\n` +

      `Ví dụ: <code>7 Ngày</code>\n\n` +

      `Gõ /cancel để hủy.`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Quay Lại",
              callback_data:
                `ap:${productId}`
            }
          ]
        ]
      }
    );
  }


  /* =======================================================
     EDIT ITEM
  ======================================================= */

  if (
    data.startsWith(
      "admin_edit_item_title:"
    )
  ) {
    const itemId =
      data.slice(
        "admin_edit_item_title:".length
      );

    await setAdminState(
      env,
      userId,
      "EDIT_ITEM_TITLE",
      {
        itemId
      }
    );

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `✏️ Nhập tên gói mới.`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Hủy",
              callback_data:
                `ai:${itemId}`
            }
          ]
        ]
      }
    );
  }


  if (
    data.startsWith(
      "admin_edit_item_price:"
    )
  ) {
    const itemId =
      data.slice(
        "admin_edit_item_price:".length
      );

    await setAdminState(
      env,
      userId,
      "EDIT_ITEM_PRICE",
      {
        itemId
      }
    );

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `💰 Nhập giá mới.\n\n` +
      `Ví dụ: <code>50000</code>`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Hủy",
              callback_data:
                `ai:${itemId}`
            }
          ]
        ]
      }
    );
  }


  if (
    data.startsWith(
      "admin_edit_item_stock:"
    )
  ) {
    const itemId =
      data.slice(
        "admin_edit_item_stock:".length
      );

    await setAdminState(
      env,
      userId,
      "EDIT_ITEM_STOCK",
      {
        itemId
      }
    );

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `📦 Nhập số lượng kho mới.`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Hủy",
              callback_data:
                `ai:${itemId}`
            }
          ]
        ]
      }
    );
  }


  /* =======================================================
     DELETE ITEM
  ======================================================= */

  if (
    data.startsWith(
      "admin_delete_item:"
    )
  ) {
    const itemId =
      data.slice(
        "admin_delete_item:".length
      );

    const item = await env.DB
      .prepare(`
        SELECT *
        FROM product_items
        WHERE id=?
      `)
      .bind(itemId)
      .first();

    if (!item) {
      return showAdminProducts(
        env,
        chatId,
        msgId
      );
    }

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `⚠️ Xóa gói <b>${esc(
        item.title
      )}</b>?`,
      {
        inline_keyboard: [
          [
            {
              text:
                "🗑️ Xóa",
              callback_data:
                `admin_delete_item_yes:${itemId}`
            }
          ],
          [
            {
              text:
                "❌ Hủy",
              callback_data:
                `ai:${itemId}`
            }
          ]
        ]
      }
    );
  }


  if (
    data.startsWith(
      "admin_delete_item_yes:"
    )
  ) {
    const itemId =
      data.slice(
        "admin_delete_item_yes:".length
      );

    const item = await env.DB
      .prepare(`
        SELECT *
        FROM product_items
        WHERE id=?
      `)
      .bind(itemId)
      .first();

    if (!item) {
      return showAdminProducts(
        env,
        chatId,
        msgId
      );
    }

    await env.DB
      .prepare(`
        DELETE FROM product_items
        WHERE id=?
      `)
      .bind(itemId)
      .run();

    return showAdminProduct(
      env,
      chatId,
      msgId,
      item.product_id
    );
  }


  /* =======================================================
     ADMIN ADD MONEY
  ======================================================= */

  if (
    data === "admin_add_money"
  ) {
    await setAdminState(
      env,
      userId,
      "ADD_MONEY_USER"
    );

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `💰 <b>CỘNG TIỀN USER</b>\n\n` +

      `Nhập Telegram ID hoặc username.\n\n` +

      `Ví dụ:\n` +
      `<code>7424477198</code>\n` +
      `hoặc\n` +
      `<code>@username</code>`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Hủy",
              callback_data:
                "admin"
            }
          ]
        ]
      }
    );
  }


  if (
    data.startsWith(
      "admin_credit:"
    )
  ) {
    const targetId =
      data.slice(
        "admin_credit:".length
      );

    const target = await env.DB
      .prepare(`
        SELECT *
        FROM users
        WHERE telegram_id=?
      `)
      .bind(targetId)
      .first();

    if (!target) {
      return;
    }

    await setAdminState(
      env,
      userId,
      "ADD_MONEY_AMOUNT",
      {
        targetId:
          target.telegram_id,

        targetName:
          target.first_name ||
          target.username ||
          target.telegram_id
      }
    );

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `💰 <b>CỘNG TIỀN</b>\n\n` +

      `👤 ${esc(
        target.first_name ||
        target.username ||
        target.telegram_id
      )}\n` +

      `💳 Số dư: <b>${money(
        target.balance
      )}</b>\n\n` +

      `Nhập số tiền muốn cộng.`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Hủy",
              callback_data:
                "admin"
            }
          ]
        ]
      }
    );
  }


  /* =======================================================
     FIND USER
  ======================================================= */

  if (
    data === "admin_find_user"
  ) {
    await setAdminState(
      env,
      userId,
      "FIND_USER"
    );

    return sendOrEdit(
      env,
      chatId,
      msgId,
      `🔎 <b>TÌM USER</b>\n\n` +

      `Nhập Telegram ID hoặc username.`,
      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ Hủy",
              callback_data:
                "admin"
            }
          ]
        ]
      }
    );
  }


  /* =======================================================
     ADMIN DEPOSITS
  ======================================================= */

  if (
    data === "admin_deposits"
  ) {
    return showAdminDeposits(
      env,
      chatId,
      msgId
    );
  }


  if (
    data === "admin_users"
  ) {
    return showAdminUsers(
      env,
      chatId,
      msgId
    );
  }


  /* =======================================================
     BUY
  ======================================================= */

  if (data === "buy") {
    return showProducts(
      env,
      chatId,
      msgId
    );
  }


  /* =======================================================
     DEPOSIT
  ======================================================= */

  if (data === "deposit") {
    return promptDeposit(
      env,
      chatId,
      msgId,
      userId
    );
  }


  /* =======================================================
     PROFILE
  ======================================================= */

  if (data === "profile") {
    return showProfile(
      env,
      chatId,
      msgId,
      user
    );
  }


  /* =======================================================
     TOP
  ======================================================= */

  if (data === "top") {
    return showTop(
      env,
      chatId,
      msgId,
      userId
    );
  }


  /* =======================================================
     HISTORY
  ======================================================= */

  if (data === "history") {
    return showHistory(
      env,
      chatId,
      msgId,
      userId
    );
  }


  /* =======================================================
     SUPPORT
  ======================================================= */

  if (data === "support") {
    return showSupport(
      env,
      chatId,
      msgId
    );
  }


  /* =======================================================
     PRODUCT
  ======================================================= */

  if (
    data.startsWith("p:")
  ) {
    return showProduct(
      env,
      chatId,
      msgId,
      data.slice(2)
    );
  }


  /* =======================================================
     ITEM
  ======================================================= */

  if (
    data.startsWith("i:")
  ) {
    return showItem(
      env,
      chatId,
      msgId,
      data.slice(2)
    );
  }


  /* =======================================================
     BUY CONFIRM
  ======================================================= */

  if (
    data.startsWith(
      "confirm:"
    )
  ) {
    return buyItem(
      env,
      chatId,
      msgId,
      userId,
      data.slice(8)
    );
  }


  /* =======================================================
     CHECK DEPOSIT
  ======================================================= */

  if (
    data.startsWith(
      "check:"
    )
  ) {
    try {
      const d =
        await checkDeposit(
          env,
          data.slice(6)
        );

      if (
        d?.status === "PAID"
      ) {
        await notifyPaid(
          env,
          d
        ).catch(
          e => console.error(
            "notify paid",
            e
          )
        );

        return sendOrEdit(
          env,
          chatId,
          msgId,
          `✅ <b>NẠP TIỀN THÀNH CÔNG</b>\n\n` +

          `💰 Đã cộng: <b>${money(
            d.amount
          )}</b>\n\n` +

          `Bạn có thể tiếp tục sử dụng bot.`,
          {
            inline_keyboard: [
              [
                {
                  text:
                    "🏠 Trang Chủ",
                  callback_data:
                    "home"
                }
              ]
            ]
          }
        );
      }

      if (
        d?.status === "EXPIRED"
      ) {
        return sendOrEdit(
          env,
          chatId,
          msgId,
          `⌛ <b>ĐƠN NẠP ĐÃ HẾT HẠN</b>\n\n` +
          `Vui lòng tạo đơn mới.`,
          {
            inline_keyboard: [
              [
                {
                  text:
                    "💳 Nạp Lại",
                  callback_data:
                    "deposit"
                }
              ]
            ]
          }
        );
      }

      /*
        Không edit message liên tục
        khi chưa có giao dịch,
        chỉ gửi alert nhẹ.
      */

      return tg(
        env,
        "answerCallbackQuery",
        {
          callback_query_id:
            q.id,

          text:
            "Chưa tìm thấy giao dịch phù hợp.",

          show_alert:
            true
        }
      ).catch(() => {});

    } catch (e) {
      console.error(
        "check deposit",
        e
      );

      return tg(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          parse_mode: "HTML",
          text:
            `⚠️ Chưa thể kiểm tra giao dịch.\n` +
            `Vui lòng thử lại sau.`
        }
      );
    }
  }
}


/* =========================================================
   SCHEDULED
========================================================= */

async function runDepositPoll(
  env
) {
  await ensureSeed(env);

  const pending = await env.DB
    .prepare(`
      SELECT id
      FROM deposits
      WHERE
        status='PENDING'
        AND expires_at>?
      ORDER BY created_at
      LIMIT 50
    `)
    .bind(nowISO())
    .all();

  /*
    Chạy tuần tự để tránh spam API ngân hàng
    và tránh Worker bị quá tải.
  */

  for (
    const x of pending.results
  ) {
    try {
      const d =
        await checkDeposit(
          env,
          x.id
        );

      if (
        d?.status === "PAID"
      ) {
        await notifyPaid(
          env,
          d
        ).catch(
          e => console.error(
            "notify cron",
            e
          )
        );
      }

    } catch (e) {
      console.error(
        "deposit poll",
        x.id,
        e.message
      );
    }
  }

  await env.DB
    .prepare(`
      UPDATE deposits
      SET status='EXPIRED'
      WHERE
        status='PENDING'
        AND expires_at<=?
    `)
    .bind(nowISO())
    .run();

  /*
    Xóa admin state quá cũ để DB không phình.
  */

  await env.DB
    .prepare(`
      DELETE FROM admin_states
      WHERE updated_at<?
    `)
    .bind(
      new Date(
        Date.now() -
        24 * 60 * 60 * 1000
      ).toISOString()
    )
    .run();
}


/* =========================================================
   CLOUDFLARE WORKER
========================================================= */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    const u =
      new URL(
        request.url
      );

    if (
      request.method === "GET" &&
      u.pathname === "/"
    ) {
      return new Response(
        "MB Shop Bot OK"
      );
    }

    if (
      request.method === "POST" &&
      u.pathname === "/sepay-webhook"
    ) {
      return handleSePayWebhook(
        request,
        env
      ).catch(
        e => {
          console.error(
            "sepay webhook",
            e
          );

          return new Response(
            "Webhook error",
            {
              status: 500
            }
          );
        }
      );
    }


    if (
      request.method === "POST" &&
      u.pathname === "/webhook"
    ) {
      let update;

      try {
        update =
          await request.json();

      } catch {
        return new Response(
          "bad request",
          {
            status: 400
          }
        );
      }

      /*
        Dùng waitUntil để Worker trả HTTP OK
        nhanh hơn Telegram, giảm webhook retry.
      */

      ctx.waitUntil(
        handleUpdate(
          env,
          update
        ).catch(
          e => console.error(
            "handle update",
            e
          )
        )
      );

      return new Response(
        "ok"
      );
    }

    return new Response(
      "Not found",
      {
        status: 404
      }
    );
  },


  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      runDepositPoll(
        env
      ).catch(
        e => console.error(
          "scheduled",
          e
        )
      )
    );
  }
};
