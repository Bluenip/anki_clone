# Rà soát phần code Gemini bàn giao

Ngày 23/10/2026. Codex trực tiếp kiểm tra và sửa; đã dừng các job AGY theo yêu cầu. Repo có thay đổi chưa commit từ nhiều lượt, nên phạm vi được xác định theo các phần bàn giao trong phiên, không khẳng định truy nguyên tác giả của từng dòng.

| Phần đã rà soát | Lỗi/vấn đề đã sửa hoặc kiểm chứng |
| --- | --- |
| Add/Edit notes | Chèn cloze tiếp theo dùng index mới, vị trí con trỏ đúng; chặn submit lặp. Giữ tag có dấu phẩy. Chặn phản hồi cũ sau chuyển card/deck; stale note giữ bản nháp và yêu cầu reload tường minh. |
| Study/audio/timer | Giữ phím tắt hoạt động trong iframe, tránh chiếm input; request review/undo cũ sau đổi deck không tải lại deck cũ. Kiểm thử timer/audio và browser smoke có dữ liệu tạm. |
| Options/preset | Khóa Save khi attach preset/đổi override đang chạy; khóa controls khi lưu. Đổi deck trong lúc save không cập nhật revision/preset của deck mới bằng phản hồi cũ. |
| Browser/bulk tags | Rà soát selection, phân trang, stale version và refresh theo query; sibling khác deck được cập nhật đúng, mutation lỗi giữ input. Native tests kiểm chứng tags hierarchy và package Unicode/dấu phẩy. |
| Custom Study | Sửa bốn mức preview, query trống bị đổi thành is:due, race chuyển phiên rồi quay lại, phản hồi reload cũ, phím Space ngay sau render, hiển thị hết thẻ khi chỉ đang chờ; bổ sung xử lý lỗi validation và chống tạo lặp. |
| Stats | Bỏ cắt forecast ở 14 ngày; bỏ phản hồi request đã hủy; bổ sung lỗi/retry khi tải deck; sửa overflow mobile và làm tròn thời gian. |
| Tests do Gemini viết | Sửa matcher không được cài, reset mock không đủ, chờ heading thay vì dữ liệu thực, và assertion cloze vô tình chấp nhận lỗi. Chạy toàn bộ suite, thêm tests độc lập cho race/concurrency. |

Backend tích hợp được kiểm tra cùng UI: note revision dưới write lock, render sibling theo home deck, is:due, phiên lọc/Undo/ôn sớm, ownership và thống kê. Test hai kết nối SQLite xác nhận chỉ một trong hai bản sửa cùng revision được ghi.

Kiểm chứng frontend: 138 tests pass, production build pass, lint không cảnh báo. Firefox: 13 kiểm tra bulk tags/editor và 15 kiểm tra Custom Study/Stats; đã xem ảnh desktop/mobile. Số backend cuối cùng ghi trong TIEN_DO_TUONG_THICH_ANKI.md.

Các kiểm tra chạy trên DB/media tạm, không backfill hay reschedule dữ liệu thật. Đây là rà soát các phần bàn giao và luồng tích hợp đã nêu, không phải chứng nhận không còn bug hoặc đã tương thích toàn bộ Anki. Giới hạn và hạng mục chưa làm được ghi trong file tiến độ.
