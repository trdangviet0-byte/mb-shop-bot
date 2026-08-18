# MB Shop Telegram Bot

## Chức năng
- `/start` chào mừng + menu chính.
- Mua Key / Acc: 14 sản phẩm, keyboard 2 cột.
- Chọn sản phẩm -> các mục/gói có giá + số lượng kho.
- Đủ tiền: transaction an toàn, trừ số dư + trừ kho + tạo đơn.
- Thiếu tiền: báo chính xác số tiền còn thiếu + nút nạp tiền.
- Nạp tối thiểu 10.000đ.
- Sinh nội dung nạp duy nhất, QR VietQR.
- Auto kiểm tra giao dịch bằng adapter MB API mỗi phút.
- Cá nhân, top nạp, lịch sử nạp, hỗ trợ.
- Sau mua: `Mua hàng thành công, Vui lòng ib Admin @RusTayIOS để lấy key`.

## 1. Cài Node.js và Wrangler
```bash
npm install
npx wrangler login
```

## 2. Tạo D1
```bash
npx wrangler d1 create mb-shop-db
```
Copy `database_id` vào `wrangler.toml`.

Khởi tạo database local:
```bash
npx wrangler d1 execute DB --local --file=./schema.sql
```

Khởi tạo production:
```bash
npx wrangler d1 execute DB --remote --file=./schema.sql
```

## 3. Secrets
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put MB_BANK_ACCOUNT
npx wrangler secret put MB_CLIENT_ID
npx wrangler secret put MB_CLIENT_SECRET
npx wrangler secret put MB_TOKEN_URL
npx wrangler secret put MB_TRANSACTION_URL
```

`MB_TOKEN_URL` là URL trong trang API Authorization Token của MB.
`MB_CLIENT_ID` và `MB_CLIENT_SECRET` là thông tin MB cấp.

## 4. Endpoint giao dịch MB
Ảnh API Authorization Token chỉ đủ để lấy access token. Để auto nạp tiền,
bạn phải có API/endpoint trả về lịch sử giao dịch của tài khoản được MB cấp quyền.
Đặt endpoint đó vào `MB_TRANSACTION_URL`.

Code transaction adapter ở:
`src/index.js` -> `getMbTransactions()`.

Nếu response khác, chỉ cần sửa:
- `getMbTransactions`
- `flattenTransactions`
- `txAmount`, `txContent`, `txId`

## 5. Deploy
```bash
npm run deploy
```

## 6. Telegram webhook
Sau khi có URL Worker:
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://YOUR-WORKER.workers.dev/webhook"
```

## Bảo mật
Không commit:
- BOT_TOKEN
- MB_CLIENT_SECRET
- access token
- số tài khoản nếu bạn không muốn công khai

Secrets chỉ nằm trong Cloudflare Worker.
