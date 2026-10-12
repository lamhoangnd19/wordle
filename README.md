# Wordle Club

Wordle phiên chung cho nhóm bạn: tất cả người chơi cùng giải một từ tiếng Anh 5 chữ cái trong 10 phút, tối đa 6 lượt đoán. Hết giờ, hệ thống tự chuyển sang một từ chung mới. Người chơi online có thể biểu quyết nhất trí để bỏ qua sớm. Điểm thưởng phụ thuộc tốc độ: 5 điểm trong 2 phút đầu, rồi giảm còn 4, 3, 2 và 1 điểm sau mỗi mốc 2 phút; người chưa hoàn thành không được cộng điểm.

## Chạy trên máy

Yêu cầu Node.js 22.12+ hoặc 24+.

```powershell
npm install
npm run dev
```

Mở http://localhost:5173. Không có DATABASE_URL: dùng bộ nhớ chạy thử, bảng hạng chỉ tồn tại đến lúc tắt máy chủ. Vercel bắt buộc dùng PostgreSQL; ứng dụng không âm thầm dùng bộ nhớ trên production.

## Tạo database và triển khai Vercel

1. Trong Vercel, tạo project từ repository chứa mã nguồn này, chọn preset **Vite**. Build command `npm run build`, output `dist` (đã cấu hình trong vercel.json).
2. Trong tab **Storage**, chọn **Create Database**, chọn tích hợp **Neon / PostgreSQL** và kết nối với project. Hoặc tạo project tại https://neon.com và lấy pooled connection string từ hộp thoại Connect.
3. Thêm biến **DATABASE_URL** vào Environment Variables của Vercel, cho Production và Preview. Không dùng tiền tố `VITE_`: biến này chỉ dành cho máy chủ. Không đưa URL chứa mật khẩu vào repository.
4. Sao chép `.env.example` thành `.env.local` trên máy, thay DATABASE_URL bằng connection string thật. Chạy `npm run db:setup` để tạo bảng người chơi, unique index và bảng phiên chung, trạng thái phiên hiện tại và các bảng biểu quyết. Nếu có `DATABASE_URL_UNPOOLED`, script migration sẽ ưu tiên kết nối trực tiếp này. Script này có thể chạy lại an toàn, không xóa dữ liệu.
5. Deploy/redeploy project. Kiểm tra trang, tạo biệt danh, hoàn thành một ván rồi mở trên trình duyệt khác để xác nhận bảng hạng dùng chung. Gửi URL Vercel cho bạn bè.

Có thể dùng CLI đã đăng nhập thay bước import repo:

```powershell
npx vercel
# Cấu hình DATABASE_URL trong dashboard và chạy db:setup trước khi xuất bản
npx vercel --prod
```

Tài liệu: [Vite trên Vercel](https://vercel.com/docs/frameworks/frontend/vite), [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js), [Kết nối Neon](https://neon.com/docs/connect/connect-from-any-app).

## Cách hoạt động

- React + Vite phía trình duyệt; Node.js Vercel Function tại `/api/game`.
- Đáp án nằm trên máy chủ, không gửi xuống trình duyệt trước khi ván kết thúc. Chấm chữ lặp ưu tiên chữ đúng vị trí, rồi phân bổ số chữ còn lại.
- Cookie HttpOnly chứa token ngẫu nhiên; database chỉ lưu SHA-256 của token. Biệt danh duy nhất, không phân biệt chữ hoa/thường. Hồ sơ gắn với trình duyệt, chưa có đăng nhập hoặc khôi phục trên thiết bị khác. Xóa cookie sẽ mất quyền truy cập hồ sơ cũ.
- Mọi thiết bị nhận cùng mã phiên, đáp án và thời điểm kết thúc từ máy chủ; đồng hồ client được hiệu chỉnh bằng thời gian máy chủ. Mỗi phiên kéo dài 10 phút, kể cả phiên mới được tạo sớm sau một biểu quyết thành công.
- Điểm một lần giải đúng được tính từ thời điểm bắt đầu phiên: 0–2 phút = 5, 2–4 = 4, 4–6 = 3, 6–8 = 2, 8–10 = 1. Số từ đã giải được lưu riêng để tính tỷ lệ thắng và lượt đoán trung bình chính xác.
- Bảng hạng toàn bộ người chơi: số từ giải đúng giảm dần; đồng điểm xét số lượt đoán trung bình trong ván thắng tăng dần, sau đó tên theo thứ tự chữ cái. Hiển thị 50 người đứng đầu, hạng cá nhân tính trên toàn bộ người chơi.
- PostgreSQL transaction khóa hàng người chơi để các yêu cầu đồng thời không cộng điểm hai lần. Số ván đã chơi chỉ tăng khi ván kết thúc.
- Bảng hạng và biểu quyết cập nhật mỗi 5 giây khi trang đang mở. Người chơi có hoạt động trong 30 giây gần nhất được tính là online và được chốt vào danh sách biểu quyết. Người đề xuất tự đồng ý; chỉ khi toàn bộ danh sách đồng ý hệ thống mới tạo phiên mới. Một phiếu từ chối kết thúc đề xuất. Khi đồng hồ về 0, client tự tải phiên mới; lượt đoán gửi muộn cho phiên cũ bị từ chối. Không có điểm mẫu hoặc người chơi giả.
- Hơn 800 từ quen thuộc tại `server/words.js` được dùng làm đáp án. Lượt đoán được kiểm tra bằng toàn bộ 12.653 từ tiếng Anh 5 chữ cái từ gói MIT `an-array-of-english-words`, vì vậy từ hiếm hợp lệ vẫn được chấp nhận nhưng không bị chọn làm đáp án ngẫu nhiên. Mỗi phiên chỉ có một đáp án chung và đáp án không lặp ngay phiên trước.
- Dành cho nhóm bạn: chưa có xác thực tài khoản, CAPTCHA hoặc giới hạn tốc độ dành cho cuộc thi công khai.

## Kiểm tra

```powershell
npm test
npm run build
```

Test kiểm tra chữ lặp, 6 lượt thử, từ không hợp lệ, ẩn đáp án, phiên chung 10 phút, reset đồng bộ, cookie, trùng tên, chống cộng điểm lặp, từ chối lượt đoán của phiên cũ và biểu quyết nhất trí mà không cộng điểm cho ván chưa hoàn thành. Test API chạy bộ nhớ local; cần smoke test database/Vercel thực tế sau khi cấu hình.
