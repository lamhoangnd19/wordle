# Wordle Club

Wordle riêng cho nhóm bạn: mỗi người chơi có một phiên độc lập, mỗi ván chọn ngẫu nhiên một từ tiếng Anh 5 chữ cái, tối đa 6 lượt đoán. Chơi liên tục, không giới hạn theo ngày.

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
4. Sao chép `.env.example` thành `.env.local` trên máy, thay DATABASE_URL bằng connection string thật. Chạy `npm run db:setup` để tạo bảng và unique index. Script này có thể chạy lại an toàn, không xóa dữ liệu.
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
- Tải lại trang tiếp tục ván hiện tại. Nút bắt đầu không đổi từ khi ván đang diễn ra; lượt đoán trùng/không hợp lệ không mất lượt.
- Bảng hạng toàn bộ người chơi: số từ giải đúng giảm dần; đồng điểm xét số lượt đoán trung bình trong ván thắng tăng dần, sau đó tên theo thứ tự chữ cái. Hiển thị 50 người đứng đầu, hạng cá nhân tính trên toàn bộ người chơi.
- PostgreSQL transaction khóa hàng người chơi để các yêu cầu đồng thời không cộng điểm hai lần. Số ván đã chơi chỉ tăng khi ván kết thúc.
- Bảng hạng cập nhật sau mỗi thao tác và mỗi 20 giây khi trang đang mở. Không có điểm mẫu hoặc người chơi giả.
- Hơn 800 từ quen thuộc tại `server/words.js` được dùng làm đáp án. Lượt đoán được kiểm tra bằng toàn bộ 12.653 từ tiếng Anh 5 chữ cái từ gói MIT `an-array-of-english-words`, vì vậy từ hiếm hợp lệ vẫn được chấp nhận nhưng không bị chọn làm đáp án ngẫu nhiên. Từ ngẫu nhiên có thể trùng giữa hai người; không lặp ngay đáp án ván trước của cùng người.
- Dành cho nhóm bạn: chưa có xác thực tài khoản, CAPTCHA hoặc giới hạn tốc độ dành cho cuộc thi công khai.

## Kiểm tra

```powershell
npm test
npm run build
```

Test kiểm tra chữ lặp, 6 lượt thử, từ không hợp lệ, ẩn đáp án, phiên riêng, tiếp tục ván, cookie, trùng tên, chống cộng điểm lặp và ván cũ. Test API chạy bộ nhớ local; cần smoke test database/Vercel thực tế sau khi cấu hình.
