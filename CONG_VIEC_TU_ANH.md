# Hoàn thiện các nhóm trong ảnh — cập nhật 26/10/2026

Tiếp tục theo yêu cầu người dùng; sau chỉ dẫn mới đã ghép các phần chức năng trước, chạy test tổng rồi sửa từng lỗi. Bảng dưới mô tả phạm vi thực tế đã triển khai, không khẳng định tương đương mọi tính năng của Anki Desktop.

## Các nhóm chức năng

| Nhóm | Phần đã có |
|---|---|
| Soạn thẻ | Image Occlusion hình chữ nhật, ellipse, đa giác, ghép/tách nhóm, xoay, màu, nhãn chữ và hai chế độ che; cloze lồng nhau; editor trực quan/HTML; đổi tên field giữ giá trị, card ID và lịch sử; diff ký tự Unicode; TTS filter, block nhiều field, cloze-only và danh sách voice; LaTeX thật thành ảnh với header/footer theo note type |
| Lịch học | Easy Days và cân bằng lượng ôn trong khoảng interval cho phép; optimizer đọc lịch sử Anki có điểm bắt đầu hợp lệ; chia thời gian train/holdout, đánh giá log loss và Brier, không tự áp dụng tham số |
| Browser | `added:`, `rated:`, regex giới hạn tài nguyên, `prop:due`; bulk delete/reset/reschedule; Undo có kiểm tra thay đổi xen ngang; reset giữ log thống kê nhưng cắt lịch sử dựng lại FSRS |
| Custom Study | Nhiều bộ lọc không trùng card; preset theo deck/ngày/tag, ôn trước hạn/quên/gần đây; tăng giới hạn new/review riêng hôm nay; tự phát audio/TTS, timer và tự chuyển có chờ audio |
| Import/export/restore | Đổi tên và remap media trùng; package duplicate newer/skip/update/add; text duplicate theo deck/collection và first/all fields; backup kèm media; preview COLPKG rồi thay collection có dữ liệu, safety backup và chống stale revision |
| Dùng lâu dài | PWA/service worker; tải thẻ và media có kiểm tra hash; IndexedDB theo tài khoản; học offline và lặp bước SM-2/FSRS; hàng đợi bền qua reload; sync theo thứ tự, retry không ghi trùng; phát hiện xung đột card/cấu hình, giữ câu trả lời local để người dùng xử lý; sửa source fields/tags offline, merge từng field, chọn local/server khi xung đột; sync nền tùy hỗ trợ trình duyệt; tải deck phân trang |

## Các lỗi đã sửa trong lượt này

- Reset không còn dựng lại trí nhớ FSRS từ lịch sử trước reset; Undo khôi phục đúng lịch sử và memory.
- Restore tăng phiên bản card/session, vô hiệu hóa Undo/receipt cũ; commit lỗi khôi phục lại cả DB lẫn media; lỗi package không hợp lệ trả thông báo thay vì 500.
- Đổi tên field bị chặn nếu còn sửa definition chưa lưu; input bắt buộc trong editor trực quan có thông báo lỗi.
- Import hai field so khớp source fields thay vì mặt thẻ đã render; cập nhật note ở deck khác giữ nguyên deck đó.
- Parser text gọi `close()` để nội dung có `&` (như bảng LaTeX) không bị xem là rỗng.
- TTS/audio automation chờ audio và chống chấm lặp; local write/download bị hủy nếu phiên đăng nhập đổi.
- Logout hỏi trước khi xóa câu trả lời chưa đồng bộ; API ngày ôn không tính mốc reset là câu trả lời.

## Đợt mở rộng vùng che ảnh

- Lưu ellipse bằng `rx`/`ry`, polygon bằng `points`, nhóm bằng cloze ordinal trong định dạng Anki; giữ tọa độ đỉnh gốc khi nhập/xuất.
- Vẽ ellipse bằng kéo chuột, đa giác bằng chọn các đỉnh; hoàn tất/hủy/bỏ đỉnh cuối. Chỉnh kích thước đa giác đồng thời co giãn các đỉnh.
- Chọn Card group để ghép một vùng vào thẻ khác hoặc tách thành thẻ mới; không tái sử dụng số thẻ đã xóa trong phiên chỉnh sửa.
- Mặt học đa giác dùng ảnh SVG tự sinh chỉ từ tọa độ đã kiểm tra, có đường viền khi lật đáp án; không bật chạy script từ template.
- Kiểm thử APKG cả định dạng cũ/mới qua Anki thật với ellipse, polygon và nhóm trộn nhiều hình; kiểm tra dữ liệu lỗi và hình suy biến.
- Đối chiếu định dạng với mã nguồn chính thức: [Ellipse](https://github.com/ankitects/anki/blob/main/ts/routes/image-occlusion/shapes/ellipse.ts), [Polygon](https://github.com/ankitects/anki/blob/main/ts/routes/image-occlusion/shapes/polygon.ts).

## Bổ sung sau yêu cầu “làm cho hết”

- Offline: tải source fields/tags, lưu bản sửa trong IndexedDB; replay review trước edit; khóa ghi theo account, kiểm tra GUID/schema, tự merge field độc lập và phép thêm/xóa tag. Cùng field đổi khác nhau trả xung đột kèm bản server để người dùng chọn. Receipt bền với request ID chống gửi trùng; restore/clear xóa receipt cũ.
- Giao diện chỉnh source offline, xem bản local, chọn local/server cho từng field xung đột, xếp bản đã giải quyết vào hàng đợi mới. Không cho học note còn bản sửa chờ; nếu server đã áp dụng mà refresh thất bại, chặn học từ snapshot cũ đến khi sync thành công.
- Service worker có replay answer/edit và đánh dấu cần refresh, không giữ khóa IndexedDB khi gọi mạng; kiểm tra quyền sync nền trước mỗi lượt và mỗi lần ghi, ngừng khi token hết hạn/đăng xuất. Logout tính cả bản sửa chưa đồng bộ.
- Tải deck phân trang, merge đầy đủ cards/notes/versions, kiểm tra manifest giữa các trang; không ghi đè lịch local đang có câu trả lời chờ sync.
- Image Occlusion: góc xoay theo đơn vị 10.000 bước của Anki, màu đã kiểm tra cú pháp, text annotation không sinh thẻ; escape dấu hai chấm/backslash, render chữ dưới dạng text an toàn, co font theo ảnh, clip phần vượt khung.

## LaTeX đã chạy được trên máy hiện tại

Đã cài Tectonic 0.17.0 vào `/home/bluenip/.cache/anki-latex`, kiểm tra SHA-256 trùng metadata bản phát hành chính thức. Đã nạp gói AMS, TikZ, mhchem và inputenc bằng ví dụ cố định. Không dùng sudo, không cài gói vào hệ thống.

Compiler chạy trong bubblewrap, không có mạng, không thấy DB/media/home; giới hạn CPU/bộ nhớ/thời gian/kích thước output. PDF được chuyển và crop thành ảnh. Ảnh nằm trong media để xuất/nhập và tải offline. SVG đã nhập được giữ nguyên; nếu note type yêu cầu SVG mới, ảnh được đóng gói thành SVG tự chứa.

Cài lại môi trường khác: `backend/venv/bin/python backend/setup_latex_runtime.py`. Cần Linux x86_64 cùng `bwrap`, `prlimit`, `pdftoppm`; có thể chọn Docker image với latex/dvipng thay thế. Cache gói bổ sung phải do quản trị viên chuẩn bị; nội dung note không tự tải gói từ mạng. Xem README để triển khai.

## Giới hạn cần hiểu đúng

- Image Occlusion hỗ trợ chữ nhật, ellipse và đa giác, tối đa 100 vùng/note và 100 đỉnh/đa giác. Có ghép/tách nhóm theo số thẻ, chỉnh vị trí/kích thước, hoàn tác từng đỉnh đang vẽ. Đã có xoay, màu hex/rgb/một số tên màu và nhãn text `c0`; vẫn kiểm tra giới hạn tọa độ/thuộc tính, không âm thầm chuyển đổi dữ liệu lạ. Nhãn text tối đa 2.000 ký tự, hiển thị bằng Arial; không cam kết giống từng pixel/font của Anki trên mọi hệ điều hành. Ghép/tách làm mất thẻ có lịch sử bị chặn khi lưu.
- Giọng TTS phụ thuộc voice của trình duyệt/hệ điều hành; một số voice hoặc media bên ngoài cần mạng.
- Offline tải theo trang 1.000 thẻ, tối đa 100.000 thẻ/cây deck và theo dung lượng trình duyệt; kiểm tra revision giữa các trang, không công bố bản tải nửa chừng. Đã thử API với 5.001 thẻ; không suy rộng thành benchmark 100.000 thẻ. Lịch local dùng SM-2/ts-fsrs để tiếp tục học; máy chủ tính lại khi replay, quyết định cuối cùng về cân bằng lượng ôn, quota và sibling. Thẻ ngoài snapshot đủ điều kiện cần sync để cập nhật.
- Sửa fields/tags offline đã có; chưa tạo note mới hoặc upload media mới khi mất mạng. Field khác nhau tự ghép; cùng field phải chọn local/server, không tự trộn các đoạn HTML trong một field. Note type thay đổi hoặc note bị xóa được giữ thành xung đột. Sync nền dùng Background Sync API khi được bật, còn phụ thuộc trình duyệt, token và hệ điều hành; không bảo đảm chạy khi bị force-close. Firefox không có API này nên đã gọi logic replay bằng service worker thật qua harness kiểm thử, không coi đó là xác nhận hệ điều hành tự đánh thức ứng dụng.
- PWA cần HTTPS hoặc localhost và app/API cùng origin. Đã kiểm tra Firefox desktop/mobile viewport; chưa kiểm tra cài đặt trên thiết bị Android/iOS thật.
- Import tối đa 50 MB/package, 10.000 note/lần text import. Đã kiểm thử 5.000 note qua public API; không suy rộng thành cam kết cho mọi collection kích thước lớn.

## Kiểm chứng

- Test tự động phủ rename/nested cloze/TTS, Unicode diff, editor, regex/date/due, load balancing, imported history/metrics, multi-filter/today limits, media collisions/duplicate policies, reset/Undo, restore/CAS/rollback/ownership, offline replay và audio/timer.
- Round-trip 5.000 note qua text import → APKG export → import vào tài khoản khác đã qua.
- LaTeX engine thật đã qua: bảng tabular, tạo ảnh, note → APKG → import, chặn đọc file ngoài sandbox. Không chỉ dùng mock compiler.
- Firefox: vẽ ellipse/đa giác bằng thao tác chuột thật, ghép nhóm, lưu/mở lại giữ ID thẻ, ảnh SVG vùng che tải trong iframe màn hình học và viewport mobile; visual/source HTML; rename giữ data và card ID; backup và restore collection có dữ liệu; tăng hạn mức hôm nay; offline tải thẻ/ảnh, chặn mạng thật, reload, ba câu trả lời qua các bước learning, reconnect/sync/retry; LaTeX hiện ảnh 176×68 trong iframe; kiểm tra chiều ngang 390px.
- Backend toàn bộ cuối: **383 passed**, không skip, 124,55 giây; còn 7 cảnh báo deprecation từ framework/cấu hình hiện có.
- Frontend toàn bộ: **170 passed**. TypeScript/Vite build, lint và `git diff --check` qua.
- Kiểm tra mới trên Firefox: sửa note khi chặn mạng thật, reload giữ bản sửa, merge field khác nhau, giải quyết cùng field, replay trong service worker thật, hiển thị yêu cầu refresh, xoay/màu/text IO trong iframe. Tải 1.001 thẻ qua nhiều trang trên browser giữ đủ cards/notes/versions; cố ý chặn bước refresh sau khi server đã áp dụng edit, xác nhận chặn học snapshot cũ rồi khôi phục bằng Sync now.
- Bộ test có fingerprint xác nhận DB/media thật không bị thay đổi. Các browser smoke dùng server, DB và media tạm; server/browser kiểm thử đã được dừng sau khi xác nhận.

Hai file lịch sử `DE_XUAT_CAI_THIEN.md` và `RA_SOAT_CODE_GEMINI.md` vẫn giữ nguyên. Không chạy migration/backfill, sửa DB/media thật, commit hoặc deploy ứng dụng trong lượt này. Bảng mới `offline_note_receipts` được tạo bằng cơ chế `create_all` hiện có khi khởi động backend mới; không sửa schema bảng cũ.
