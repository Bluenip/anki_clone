# Đề xuất cải thiện Anki Clone — bản để duyệt

> Trạng thái: **Đề xuất, chưa triển khai**. Tài liệu này ghi lại các hạng mục cần cân nhắc; không đồng nghĩa với việc phê duyệt sửa mã hoặc triển khai lên môi trường công khai.

## 1. Đánh giá ngắn

Dự án đã có các chức năng nền tảng: tài khoản, bộ thẻ, học theo lịch, giới hạn học mỗi ngày và nhập/xuất bộ thẻ. Frontend build thành công (`npm run build`). `npm run lint` có 24 cảnh báo. Đây là nền tảng tốt cho prototype/portfolio, nhưng cần xử lý bảo mật và bổ sung kiểm thử trước khi phục vụ người dùng thực.

Phạm vi đánh giá: đọc mã nguồn và chạy build/lint frontend; **chưa kiểm thử giao diện trực tiếp trên trình duyệt**, chưa chạy kiểm thử end-to-end hoặc kiểm thử xâm nhập. Các nhận xét về giao diện dưới đây là đề xuất cần xác nhận khi xem web thực tế.

## 2. Các hạng mục đề xuất

### P0 — Cần xử lý trước khi công khai

#### P0.1. Thay cơ chế quên mật khẩu

- **Hiện trạng:** `backend/routers/auth_router.py` (`forgot_password`) chỉ cần biết email là đổi ngay mật khẩu tài khoản và trả mật khẩu mới trong API response; `frontend/src/pages/ForgotPasswordPage.tsx` hiển thị mật khẩu đó. Người khác biết email có thể chiếm quyền truy cập hoặc làm chủ tài khoản mất quyền đăng nhập.
- **Đề xuất:** Tạm vô hiệu hóa luồng này nếu chưa có dịch vụ gửi email. Khi triển khai đầy đủ, chỉ gửi liên kết đặt lại qua email với token ngẫu nhiên dùng một lần, hết hạn ngắn; không đổi mật khẩu trước khi xác minh token, không trả mật khẩu/token trong API response. Trả thông điệp giống nhau dù email có tồn tại hay không; giới hạn tần suất yêu cầu.
- **Tiêu chí nghiệm thu:** Gửi yêu cầu chỉ với email không làm thay đổi mật khẩu; link/token chỉ dùng một lần, hết hạn đúng thời điểm; phản hồi không lộ thông tin tài khoản.

#### P0.2. Kiểm tra quyền sở hữu khi đánh giá thẻ

- **Hiện trạng:** `backend/routers/study_router.py` (`POST /api/study/{card_id}/review`) truy vấn thẻ theo ID, chưa kiểm tra `card.deck.user_id` có phải người dùng hiện tại không.
- **Đề xuất:** Chỉ cho phép ghi kết quả ôn tập nếu thẻ thuộc bộ thẻ của người dùng đang đăng nhập. Rà soát các endpoint nhận `deck_id`/`card_id` khác theo cùng quy tắc.
- **Tiêu chí nghiệm thu:** User B không thể ôn tập hoặc sửa tiến độ của thẻ thuộc User A khi đoán được ID; API trả 404/403 phù hợp và không ghi `StudyProgress`/`ReviewLog`.

#### P0.3. Kiểm soát HTML của nội dung thẻ

- **Hiện trạng:** `frontend/src/pages/StudyPage.tsx` và `CardEditorPage.tsx` hiển thị mặt thẻ qua `dangerouslySetInnerHTML`; chưa thấy bước lọc HTML trong luồng này. Thẻ nhập từ người dùng hoặc gói chia sẻ có nguy cơ chạy mã độc trong trình duyệt (XSS).
- **Đề xuất:** Nếu không cần rich text, hiển thị như văn bản thuần. Nếu cần định dạng và media từ `.apkg`, lọc HTML theo allowlist thẻ/thuộc tính/URL trước khi render, đồng thời kiểm tra luồng nhập nội dung. Bổ sung CSP như lớp bảo vệ phụ, không thay cho việc lọc HTML.
- **Tiêu chí nghiệm thu:** Nội dung chứa `script`, event handler (`onerror`...), hoặc URL `javascript:` không thực thi; định dạng và media hợp lệ vẫn hiển thị đúng.

#### P0.4. Chuyển JWT secret ra cấu hình triển khai

- **Hiện trạng:** `backend/auth.py` chứa `SECRET_KEY` cố định trong mã nguồn. Nếu dùng chung khóa này khi triển khai, người biết mã nguồn có thể giả mạo JWT.
- **Đề xuất:** Đọc khóa ngẫu nhiên mạnh từ biến môi trường/bộ quản lý secret; fail fast khi thiếu khóa trong production. Thay khóa của mọi môi trường đã từng dùng giá trị hiện tại (token cũ sẽ hết hiệu lực).
- **Tiêu chí nghiệm thu:** Không có khóa production trong repository; ứng dụng production không khởi động nếu thiếu khóa; JWT ký bằng khóa cũ bị từ chối sau khi đổi khóa.

### P1 — Nên làm tiếp theo

#### P1.1. Bổ sung kiểm thử tự động

- **Đề xuất:** Backend: test xác thực, phân quyền chéo người dùng, reset mật khẩu, giới hạn/ngày và lịch ôn tập. Frontend: test luồng đăng nhập, tạo bộ thẻ, học thẻ, thông báo lỗi API. Thêm kiểm tra build/lint/test vào CI.
- **Tiêu chí nghiệm thu:** Các lỗi P0 có regression test; CI chạy trên mỗi pull request và báo lỗi nếu test/build không đạt.

#### P1.2. Làm rõ lỗi và trạng thái thao tác trên giao diện

- **Hiện trạng:** `frontend/src/pages/DecksPage.tsx` có các `catch` bỏ qua lỗi khi tải, tạo, đổi tên, xóa bộ thẻ; người dùng có thể tưởng thao tác thành công.
- **Đề xuất:** Hiện thông báo lỗi rõ ràng, cho phép thử lại; phân biệt trạng thái tải, rỗng và lỗi; vô hiệu hóa nút trong khi đang gửi yêu cầu để hạn chế thao tác lặp.
- **Tiêu chí nghiệm thu:** Mô phỏng API lỗi ở từng thao tác vẫn nhận được thông báo hữu ích; dữ liệu trên màn hình không giả vờ đã cập nhật thành công.

#### P1.3. Giới hạn và xác thực dữ liệu đầu vào

- **Hiện trạng:** Các schema tài khoản trong `backend/schemas.py` dùng chuỗi thông thường; `backend/routers/apkg_router.py` đọc toàn bộ file upload vào bộ nhớ trước khi nhập.
- **Đề xuất:** Kiểm tra định dạng email, độ dài/tính hợp lệ của mật khẩu và nội dung; giới hạn kích thước file/gói giải nén, số lượng thẻ/media; trả lỗi 4xx có kiểm soát thay vì lộ exception thô.
- **Tiêu chí nghiệm thu:** Input và file quá lớn hoặc sai định dạng bị từ chối an toàn; thông báo lỗi không lộ đường dẫn hay thông tin nội bộ.

### P2 — Chất lượng trải nghiệm và bảo trì

#### P2.1. Cải thiện accessibility và mobile

- **Đề xuất:** Kiểm thử trực tiếp ở desktop và màn hình nhỏ; kiểm tra điều hướng chỉ bằng bàn phím, nhãn cho nút biểu tượng (ví dụ nút bánh răng trong `DecksPage.tsx`), focus rõ ràng, độ tương phản, modal và tùy chọn giảm chuyển động. Ưu tiên sửa theo kết quả kiểm thử thay vì thay toàn bộ thiết kế.
- **Tiêu chí nghiệm thu:** Người dùng có thể hoàn tất các luồng chính bằng bàn phím; không tràn ngang ở kích thước mobile phổ biến; thành phần tương tác có tên truy cập được.

#### P2.2. Giảm cảnh báo lint và nợ kiểu dữ liệu

- **Hiện trạng:** Lint báo 24 cảnh báo, gồm dependencies của hooks và tạo component trong lúc render; `DecksPage.tsx` dùng `any[]` cho dữ liệu bộ thẻ.
- **Đề xuất:** Sửa cảnh báo theo từng nhóm, định nghĩa kiểu dữ liệu API chung; không tắt rule chỉ để làm sạch báo cáo.
- **Tiêu chí nghiệm thu:** `npm run build` và `npm run lint` không có lỗi/cảnh báo trong phần mã được xử lý.

## 3. Thứ tự triển khai gợi ý

1. **Chặn rủi ro ngay:** tắt/đổi luồng quên mật khẩu hiện tại, chặn review thẻ của người khác, xử lý HTML thẻ và thay JWT secret production.
2. **Chống tái phát:** viết test cho từng lỗi bảo mật; chạy CI.
3. **Hoàn thiện sản phẩm:** xác thực input/upload, trạng thái lỗi UI, mobile/accessibility, xử lý cảnh báo lint.

## 4. Các quyết định cần bạn duyệt

- [ ] Duyệt toàn bộ nhóm **P0** hay chọn hạng mục cụ thể?
- [ ] Quên mật khẩu: **tạm tắt** cho tới khi có email, hay triển khai ngay reset qua email?
- [ ] Nội dung thẻ: **văn bản thuần** hay tiếp tục hỗ trợ **HTML giới hạn** để giữ định dạng `.apkg`?
- [ ] Có cần phục vụ người dùng công khai ngay, hay dự án trước mắt chỉ dùng cho demo/local?
- [ ] Sau P0, ưu tiên **test/CI**, **trải nghiệm giao diện**, hay **nhập/xuất dữ liệu**?

> Chưa có thay đổi nào đối với mã ứng dụng theo tài liệu này. Chỉ triển khai các hạng mục sau khi được duyệt.
