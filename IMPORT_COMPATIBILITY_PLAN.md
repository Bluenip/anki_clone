# Kế hoạch cải thiện import Anki

Mục tiêu: nhập được deck nhạc 203,63 MiB và mở rộng tương thích với deck AnkiWeb phổ biến, giữ dữ liệu gốc và rollback khi lỗi. Không tuyên bố tỷ lệ tương thích khi chưa đo trên bộ mẫu đủ lớn.

## Công việc

- [x] Gom giới hạn upload/giải nén/media/note/card vào cấu hình môi trường; mặc định cho máy cá nhân: upload 1 GiB, giải nén 3 GiB, media 2 GiB, 100.000 note/card/media. Kiểm tra ổ đĩa trước giải nén và sao chép.
- [x] Thêm import nền có trạng thái lưu trên đĩa, phân quyền theo tài khoản, tiến độ, hủy, dọn file tạm; một import tại một thời điểm để tránh đụng media/SQLite. Giữ API đồng bộ cho client cũ, chạy xử lý ngoài event loop.
- [x] Thêm bước xem trước bằng chính pipeline validation trong transaction rollback; xác nhận mới ghi dữ liệu. Báo số thêm/cập nhật/bỏ qua, media và cảnh báo; phân biệt lỗi giới hạn, định dạng, tính năng không hỗ trợ.
- [x] Giữ hỗ trợ font đã có; thêm chế độ SVG tĩnh được làm sạch (loại script, foreignObject, liên kết ngoài). Giữ chặn SVG giả dạng ảnh. Giữ dữ liệu note/model/template/CSS gốc và thư viện Anki đã được pin.
- [x] Kiểm tra template Basic/đảo chiều/Cloze/điều kiện/FrontSide, Image Occlusion và toán bằng các test sẵn có; bổ sung kiểm thử khi phát hiện lỗi thực tế. JavaScript/add-on không chạy trong trang chính; báo cảnh báo thay vì hứa hiển thị đầy đủ.
- [x] Giảm bộ nhớ thừa trong quá trình import và thêm checkpoint tiến độ/hủy theo lô; giữ validation trước thay đổi dữ liệu và rollback media.
- [x] Chạy test hồi quy backend/frontend, build; nhập file Classical Music vào database/media tạm, kiểm tra số note/card/media, nhập lại và đối chiếu nội dung với Anki. Ghi kết quả, giới hạn vận hành và các trường hợp chưa hỗ trợ.

## Tiêu chí hoàn thành

File nhạc thực nhập thành công trong môi trường cô lập; preview không đổi collection; hủy/lỗi không để lại card/media mới; người khác không xem/hủy job; gói cũ/mới và roundtrip hiện có vẫn hoạt động; giao diện có upload progress, preview, xác nhận và kết quả. Không thay đổi collection thật khi kiểm tra.

## Phạm vi và giới hạn

Không tự động bỏ card hoặc thực thi JavaScript/add-on. Nếu template chưa hỗ trợ thì báo rõ và rollback. Không thay toàn bộ trình render hay engine dữ liệu trong lần này; tận dụng adapter Anki và metadata gốc hiện có. Các số giới hạn là cấu hình bảo vệ, không phải cam kết hiệu năng 100.000 card. Import nền chạy trong tiến trình API; job đang chạy bị ngắt khi tiến trình dừng phải được báo interrupted và có thể tải lại, không tự chạy lại một transaction không rõ kết quả.

## Kết quả kiểm tra

- File `Classical_Music_Themes_-_Part_I.apkg` (213.519.868 byte): preview báo 545 note/card/media và không tạo deck/note/card; nhập thật tạo đủ 545; nhập lại bỏ qua 545, không tạo bản sao.
- So sánh byte của cả 545 media với ZIP gốc: khớp. Đối chiếu 545 note/card, GUID và toàn bộ trường với thư viện Anki: khớp.
- Luồng HTTP nền với chính file 203,63 MiB: upload → preview → xác nhận → hoàn tất, xóa bản upload tạm sau hoàn tất.
- Kiểm thử job: phân quyền, preview không ghi dữ liệu, hủy lúc copy media và rollback, file hỏng, quá dung lượng, thiếu ổ đĩa, preview hết hạn, tiến trình bị ngắt và race giữa đọc trạng thái/hoàn tất.
- Bộ test backend đầy đủ (có bật fixture nhạc thật): **382 passed**. Sau bổ sung test thiếu ổ đĩa: nhóm job **10 passed**. Frontend: **172 passed / 27 file**. TypeScript + Vite production build thành công.
- Lint frontend không có lỗi; còn cảnh báo `set-state-in-effect` tại effect tải dữ liệu sẵn có của DecksPage.
- Cấu hình Docker Compose chuyển tiếp giới hạn môi trường; Nginx cho body 1100 MiB để chứa package 1 GiB và multipart overhead. Chưa chạy container Docker trong lần kiểm tra này.
- Chạy thử bằng database/media cô lập, không sửa collection thật. Đã dọn file script/log/fixture tạm của phiên sau lượt kiểm tra cuối; giữ file APKG gốc và mã nguồn kiểm thử.

## Các giới hạn còn lại

- Không đo tỷ lệ bao phủ toàn thư viện AnkiWeb. JavaScript/add-on và filter/template chưa hỗ trợ vẫn được báo rõ thay vì bỏ thẻ âm thầm.
- SVG được chuyển sang tập con đồ họa tĩnh; script/CSS/animation/liên kết ngoài bị loại, có cảnh báo. Font đã có sẵn và được giữ nguyên.
- Import nền dùng thread và file lock trên một máy Linux; không thay thế queue phân tán. Job đang xử lý không tự resume sau restart; cần kiểm tra collection nếu dừng đúng lúc commit.
- Tiến độ/hủy được kiểm tra tại các checkpoint; không ngắt giữa một lệnh copy/Anki backend đang chạy. Commit không bị hủy giữa chừng.
- Preview chạy pipeline trong transaction rollback, nên có thể tạm giữ SQLite write lock dù không lưu thay đổi. Xác nhận chạy lại validation vì collection có thể đổi từ lúc preview.
- Đã giảm lưu HTML render của toàn bộ deck trong bộ nhớ, chuyển quét media sang lô và hash media theo stream. Metadata/card/note planning vẫn ở bộ nhớ với giới hạn cấu hình; 100.000 card chưa phải benchmark hiệu năng.
- File upload của job hoàn tất/lỗi/hủy được xóa ngay. Preview chưa xác nhận hết hạn sau 24 giờ, status giữ tối đa 7 ngày qua cơ chế dọn lười khi truy vấn/tạo job; server không có request thì cần lần truy vấn tiếp theo để dọn.

