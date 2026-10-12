# Wordle Club

Wordle cho nhóm bạn với tài khoản và phòng chơi riêng. Mỗi người đăng ký bằng tên tài khoản và mật khẩu, sau đó tạo room hoặc nhập ID 6 ký tự để tham gia.

Mỗi room có dữ liệu hoàn toàn độc lập:

- Một từ chung trong phiên 10 phút, tối đa 6 lượt đoán.
- 0–2 phút: 5 điểm; 2–4: 4; 4–6: 3; 6–8: 2; 8–10: 1.
- Người online trong 30 giây gần nhất có thể biểu quyết nhất trí để bỏ qua phiên.
- Bảng xếp hạng, ván chơi, điểm và thành viên riêng.
- Chủ phòng có thể xóa room; toàn bộ dữ liệu và bảng điểm của room bị xóa theo.

## Chạy local

```bash
npm install
npm run dev
```

Mở http://localhost:5173. Không có `DATABASE_URL`, ứng dụng dùng bộ nhớ tạm để phát triển.

## Database Neon

Sao chép `.env.example` thành `.env.local`, cấu hình `DATABASE_URL` và chạy:

```bash
npm run db:setup
```

Migration `rooms_v1` xóa schema người chơi chung cũ đúng một lần, rồi tạo:

- `club_users`, `club_sessions`
- `club_rooms`, `club_room_members`
- `club_room_rounds`, `club_room_state`
- `club_room_skip_requests`, `club_room_skip_voters`

Mật khẩu được băm bằng scrypt với salt ngẫu nhiên. Cookie session là HttpOnly, SameSite=Lax và chỉ lưu hash token trong database. Xóa room dùng khóa ngoại cascade để xóa toàn bộ dữ liệu trong room.

## Kiểm tra và deploy

```bash
npm test
npm run build
npx vercel --prod
```

Vercel cần biến `DATABASE_URL`. `DATABASE_URL_UNPOOLED` được ưu tiên cho migration nếu có.
