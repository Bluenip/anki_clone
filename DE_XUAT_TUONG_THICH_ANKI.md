> **Cập nhật triển khai 26/10/2026:** Xem [CONG_VIEC_TU_ANH.md](CONG_VIEC_TU_ANH.md) để biết các mục đã triển khai, kiểm thử và giới hạn hiện tại. Tài liệu này giữ vai trò đề xuất/lịch sử thiết kế.

# Đề xuất đưa Anki Clone tới trải nghiệm gần Anki Desktop

Ngày khảo sát: 22/10/2026. Trạng thái: **đề xuất, chưa triển khai**.

Tài liệu này mở rộng `DE_XUAT_CAI_THIEN.md`, không ghi đè tài liệu cũ. Mục tiêu do chủ dự án xác nhận: nhập/xuất **CSV, TXT và APKG**, spaced repetition đúng hành vi, các tùy chọn trong ảnh Anki Options và bổ sung các khả năng Anki còn có. `.txt` không phải `.tex`. Thêm TSV và COLPKG vào phạm vi tương thích.

Phương pháp: Codex đọc code, tra tài liệu Anki chính thức và giao một lượt review độc lập cho AGY với **Claude Sonnet 4.6 Thinking**. Chỉ khảo sát tĩnh; không chạy ứng dụng, test, build, import thử hay sửa mã chức năng. Các nhận xét “đã có” dưới đây nói về code, chưa phải chứng nhận chạy đúng.

## 1. Kết luận và nguyên tắc nghiệm thu

Web đã có nền tảng deck/thẻ, học bốn nút, learning/relearning, một phần SM-2, APKG, Options, Browse, auth và shared decks. Nhưng giao diện Options đang đi trước chức năng thật. Chỉ làm giống hình sẽ chưa khiến web hoạt động giống Anki.

Ba việc quan trọng nhất:

1. Đổi nền tảng dữ liệu từ hai mặt thẻ sang **note → nhiều card**, có note type, field, template, GUID và media độc lập.
2. Làm nhập/xuất hai chiều không mất dữ liệu trong phạm vi đã công bố; dùng Anki Desktop làm đối chứng.
3. Tách scheduler, queue và reviewer; FSRS phải tính lịch thật, mọi tùy chọn phải có tác dụng và test hành vi.

Không tuyên bố “giống 100% Anki” chung chung. Trước triển khai cần chốt một phiên bản Anki Desktop ổn định làm mốc, ghi số phiên bản/commit, scheduler và phiên bản định dạng gói trong bộ fixture. Ảnh là mốc giao diện, không đủ để suy ra phiên bản hoặc toàn bộ thuật toán. Mỗi tính năng theo dõi bốn mức: **giao diện → API/lưu dữ liệu → hành vi → kiểm chứng đối chiếu**.

## 2. Những khoảng cách đã thấy trực tiếp trong code

| Phát hiện | Dẫn chứng tại thời điểm khảo sát | Hệ quả |
|---|---|---|
| `Card` chỉ có front/back, không có `Note`/`NoteType`/`Template` | `backend/models.py:40` | Không giữ được note nhiều trường, siblings, cloze và template như dữ liệu gốc |
| Mỗi deck lưu settings chuỗi JSON; chưa có quan hệ preset dùng chung hay deck cha | `backend/models.py:23` | Chưa có nền tảng thật cho preset, subdeck và giới hạn theo cây |
| Preset dropdown là lựa chọn cố định | `frontend/src/pages/DeckOptionsPage.tsx:152` | Dòng “used by 1 deck” không phải phép đếm quan hệ preset |
| FSRS chỉ là state/toggle trong Options; scheduler đang dùng SM-2 | `DeckOptionsPage.tsx:93`, `backend/sm2.py`, `backend/routers/study_router.py:13` | Bật FSRS chưa chứng minh có thay đổi thuật toán |
| Queue chọn learning rồi review rồi new bằng các truy vấn cố định | `backend/routers/study_router.py:81`, `:114`, `:147` | Các lựa chọn display order chưa điều khiển đầy đủ queue |
| New vẫn được xét khi hết review limit | `backend/routers/study_router.py:148` | Chưa thể hiện tác dụng của cờ ignore review limit |
| Có fallback lấy learning chưa đến hạn mà không có cửa sổ look-ahead | `backend/routers/study_router.py:180` | Có thể học sớm hơn dự kiến; cần phân biệt “đang chờ” và “hết thẻ” |
| Ngày học lấy mốc 00:00 UTC | `backend/routers/study_router.py:32` | Chưa có timezone và giờ bắt đầu ngày tùy người dùng |
| Bộ đếm review đếm log `was_new=False`, gồm cả các lượt learning tiếp theo | `backend/routers/study_router.py:42` | Cần đối chiếu cách tính quota; không coi mọi lượt nhấn là một review card mới |
| Preview Hard learning và xử lý Hard chưa dùng cùng một phép chuyển trạng thái | `backend/sm2.py:_get_learning_intervals`, `study_router.py:357` | Nhãn thời gian có thể khác lịch thật được ghi |
| SM-2 có nhánh interval cố định theo repetitions và cập nhật ease theo công thức SM-2 | `backend/sm2.py:sm2_algorithm` | Không đủ căn cứ coi đây là thuật toán Anki SM-2 tương đương |
| Audio tự chạy theo effect, chưa đọc các tùy chọn audio | `frontend/src/pages/StudyPage.tsx:103` | Nút tắt autoplay trong Options chưa bảo đảm có hiệu lực |
| APKG chỉ tìm `collection.anki2` / `collection.anki21` | `backend/apkg_handler.py:169` | Chưa có đường hỗ trợ gói hiện đại tương ứng; phải test theo phiên bản |
| Import đọc note fields nhưng tạo Card bằng hai trường đầu; trường sau chỉ nhặt media | `backend/apkg_handler.py:312` | Mất cấu trúc trường/template và thông tin ngoài hai trường; card đảo có thể sai |
| Import tạo deck mới, chưa giữ GUID và cấu trúc note gốc | `backend/apkg_handler.py:308`, `:362` | Reimport không thể cập nhật đúng theo danh tính note hiện tại |
| Export tạo GUID mới và note Basic hai trường | `backend/apkg_handler.py:524`, `:584`, `:591` | Round-trip không giữ danh tính/model gốc |
| ReviewLog chỉ lưu rating, was_new và thời điểm | `backend/models.py:79` | Thiếu thời gian trả lời và lịch sử trạng thái đầy đủ cho stats/export/undo |
| Export revlog dùng interval hiện tại và duration cố định | `backend/apkg_handler.py:609` | Không thể gọi là xuất lại lịch sử gốc chính xác |
| Có nhập text cơ bản và upload TXT/CSV, nhưng parser split dòng và chỉ lấy hai cột | `backend/routers/decks_router.py:223`, `frontend/src/pages/DecksPage.tsx:376` | Chưa có parser CSV đầy đủ, wizard mapping/update; chưa có xuất CSV/TXT/TSV hoặc COLPKG |
| Browse chỉ tìm front/back bằng ILIKE, giới hạn 1000 dòng | `backend/routers/cards_router.py:21` | Chưa có query language, pagination và xử lý collection lớn |

Đối với mỗi dòng, cần cập nhật lại số dòng nếu code thay đổi trước khi triển khai.

## 3. Nền tảng dữ liệu cần bổ sung trước

Đề xuất schema nội bộ sau đây là thiết kế cho web, không phải bản sao schema Anki:

| Thực thể | Dữ liệu tối thiểu / trách nhiệm |
|---|---|
| Collection/Profile | Chủ sở hữu, timezone IANA, giờ đổi ngày, schema version, sync revision |
| NoteType / NoteField / CardTemplate | Field có thứ tự; sort field; CSS; question/answer template; template ordinal; loại normal/cloze/image occlusion; metadata gốc |
| Note | GUID bền vững, note type, field values nguyên bản, tags, modified time, provenance import |
| Card | Note ID, template/cloze ordinal, deck ID, new position, flag; một note có nhiều card |
| Deck | Parent ID, tên đầy đủ, preset ID; deck thật khác filtered deck |
| DeckPreset | Settings typed/versioned, owner; nhiều deck dùng chung một preset |
| DeckLimitOverride | Override lâu dài hoặc theo study-day; không lưu “Today only” thành mặc định vĩnh viễn |
| CardState | Trạng thái new/learning/review/relearning; step; due kiểu timestamp hoặc study-day; reps/lapses; ease; scheduler version; FSRS state |
| Visibility | Suspend độc lập với bury; buried-until + nguyên nhân tự động/thủ công; không phá lịch nền |
| ReviewEvent | Event ID, card/user, thời điểm UTC, timezone context, rating, review kind, elapsed, duration, interval/state trước-sau, scheduler/version, nguồn thao tác |
| MediaAsset / Reference | Tên logic gốc, hash nội dung, MIME, kích thước, owner và các nơi tham chiếu; không nhúng URL API làm dữ liệu chuẩn |
| ImportJob / ExportJob | Manifest, policy cập nhật/trùng, cảnh báo tương thích, tiến độ, kết quả, khả năng rollback |
| Operation / Undo | Thao tác nguyên tử và dữ liệu để đảo ngược; có version để tránh ghi đè thay đổi mới |

Không nhất thiết tách mọi field thành bảng ngay, nhưng phải có hợp đồng dữ liệu và validation. Với FSRS, lưu tối thiểu state mà engine phiên bản đã chọn yêu cầu, thường gồm stability/difficulty cùng thời điểm và lịch sử review; retrievability thường được tính theo thời điểm, không lưu như một hằng số đúng mãi.

Migration: sao lưu DB + media trước; mỗi Card cũ thành một Basic Note và một Card, giữ ID/mapping để nối StudyProgress; tạo GUID một lần; gán preset mới từ settings hiện tại mà không tự gộp các deck khác ý nghĩa. Trạng thái không khôi phục được từ lần import mất dữ liệu trước phải được ghi “không có dữ liệu”; không bịa lại note/template/lịch sử. Giữ lớp API front/back tạm thời để frontend chuyển dần. Dùng migration versioned, dry-run, kiểm đếm, transaction và rollback; không dùng script sửa DB trực tiếp thiếu kiểm soát.

## 4. Nhập/xuất và tương thích dữ liệu

Anki có gói deck và gói collection; xuất văn bản là một cách trao đổi khác, không bảo toàn toàn bộ collection. Web nên cung cấp tên định dạng rõ ràng và mô tả dữ liệu nào được giữ. [Nguồn: xuất dữ liệu](https://docs.ankiweb.net/manual/exporting).

| Định dạng | Nhập web | Xuất web | Phạm vi đề xuất |
|---|---|---|---|
| CSV UTF-8 | Bắt buộc | Bắt buộc | Chọn separator, mapping field, preview, quote/multiline; CSV export riêng là tiện ích web, không giả định Anki có cùng menu |
| TXT / TSV UTF-8 | Bắt buộc | Bắt buộc | Text phân cách tab hoặc delimiter người dùng chọn, hỗ trợ header Anki theo phiên bản |
| APKG legacy | Bắt buộc | Bắt buộc | Note/card/template/media/deck; tùy chọn tiến độ và preset, fixture đối chứng |
| APKG hiện đại | Bắt buộc sau nền tảng | Bắt buộc sau nền tảng | Nhận dạng version, DB/media compression/metadata bằng codec được kiểm chứng; không chỉ đổi đuôi file |
| COLPKG | Bổ sung | Bổ sung | Collection đầy đủ; restore vào collection mới hoặc xác nhận thay thế dữ liệu rõ ràng; backup trước restore |
| `.anki2` / `.anki21` nội bộ | Công cụ phục hồi nâng cao nếu cần | Không là định dạng giao diện ưu tiên | Không hứa DB file riêng chứa media hay là backup đầy đủ |
| Định dạng Anki cũ / SuperMemo XML | Backlog tương thích có kiểm tra phiên bản | Chỉ khi thật sự cần | Điều tra importer trong Anki mốc đã chốt; chưa cam kết mọi biến thể lịch sử |
| XLSX/ODS/PDF/Word | Không mặc định | Không mặc định | Hướng dẫn chuyển CSV/TXT; không đánh đồng với định dạng Anki native |

### 4.1. Import văn bản

Đề xuất wizard: chọn file → UTF-8/BOM + delimiter → xem trước → chọn deck/note type → ánh xạ field/tags/GUID → policy trùng → tổng kết rồi xác nhận. Parser phải hiểu quote, dấu phân cách trong field và newline, không dùng split dòng đơn giản. [Nguồn: nhập văn bản](https://docs.ankiweb.net/manual/importing/text-files).

Thiết kế cần có:

- Policy add/update/skip, scope note type hoặc note type+deck; ưu tiên GUID khi có, giữ GUID qua export.
- Chọn nội dung plain text hay HTML; bảo toàn nội dung gốc, sanitize ở renderer; báo dòng sai và số trường lệch thay vì âm thầm mất dữ liệu.
- Hỗ trợ tags và các directive/header đã xác nhận ở phiên bản mốc; hiển thị cảnh báo nếu header chưa hiểu.
- Media tham chiếu trong text không đồng nghĩa file media được nhúng: cho upload media kèm riêng hoặc ZIP do web quy định, ghi rõ đây là luồng bổ sung của web.
- Export notes khác export rendered cards; cho chọn fields, tags, deck, note type/GUID, delimiter và HTML/plain text. Notes export không nhân bản note theo số card.
- Văn bản không giữ scheduler/template/media binary đầy đủ; không gọi CSV/TXT là bản sao lưu toàn diện.
- Nếu có chế độ mở bằng spreadsheet để tránh formula injection, cung cấp lựa chọn tường minh và giữ chế độ round-trip không âm thầm đổi field.

### 4.2. Import/export APKG

Giữ field values, model/field order, template question/answer/CSS, ord/cloze index, GUID, tags, deck hierarchy và media filename/hash. Không render rồi ghi đè ngược vào field gốc. Import lại gói không đổi phải không sinh thêm note/card. Cập nhật gói cần policy modified time/model changes và preview xung đột; giữ tiến độ cục bộ khi chỉ cập nhật nội dung. [Nguồn: gói Anki](https://docs.ankiweb.net/manual/importing/packaged-decks).

Tách lựa chọn “nhập tiến độ” khỏi “nhập nội dung”; tác giả chia sẻ deck không nên ép lịch học cá nhân lên người nhận. Định nghĩa rõ include media/presets/scheduling trong xuất; lịch sử thiếu phải cảnh báo thay vì tự điền duration 60 giây hoặc interval hiện tại vào mọi log cũ.

Gói lớn dùng job/streaming, progress/cancel; ngưỡng dung lượng cấu hình thay vì tăng vô hạn. Giữ kiểm tra zip bomb/path traversal/symlink đã có; thêm cleanup staging, giới hạn tài nguyên SQLite, isolation và rollback DB + media cùng nhau. File export dùng tên tạm duy nhất để tránh va chạm khi hai job cùng giây.

### 4.3. Bộ nghiệm thu trao đổi

1. Fixture Basic, reversed, optional reversed, cloze nhiều số, note nhiều trường, hierarchy, template CSS, Unicode/RTL, ảnh/audio/tên media đặc biệt và gói legacy/modern.
2. Anki → web → Anki vào profile thử nghiệm sạch: so số note/card/ord/GUID/field/tag/deck/template/media và xem mặt trước/sau; kiểm tra lịch khi bật tùy chọn tiến độ.
3. Web → Anki → web theo cùng manifest; không yêu cầu file ZIP giống từng byte, yêu cầu ý nghĩa dữ liệu được bảo toàn.
4. Reimport cùng gói hai lần không tăng số lượng; sửa một note rồi import cập nhật đúng note, không reset tiến độ ngoài policy.
5. CSV/TXT có BOM, tiếng Việt, dấu nháy, delimiter trong field, multiline, field rỗng, dòng sai và trùng; có báo cáo add/update/skip/error.
6. Gói có tính năng chưa hỗ trợ phải bị từ chối hoặc có cảnh báo mất mát trước xác nhận. Không âm thầm nhập một phần rồi thông báo thành công hoàn toàn.

## 5. Scheduler và hàng đợi học

Ưu tiên engine được kiểm chứng, pin phiên bản và có test vectors, thay vì tự viết một thuật toán rồi đặt tên FSRS/Anki. Cân nhắc engine backend của Anki qua adapter/service so với thư viện FSRS độc lập; thư viện FSRS chỉ giải quyết một phần, không tự cung cấp toàn bộ queue, import hay preset. Thử nghiệm nhỏ cả hai trước quyết định; đánh giá khả năng đóng gói, API, hiệu năng và điều kiện sử dụng/phân phối mã. [Nguồn: thuật toán Anki](https://faqs.ankiweb.net/what-spaced-repetition-algorithm.html), [mã nguồn Anki](https://github.com/ankitects/anki).

Hợp đồng đề xuất:

- `Scheduler.preview(state, rating, now, config)` và `Scheduler.apply(...)` dùng cùng phép chuyển trạng thái. Preview không mutate; apply ghi event/state trong transaction.
- `Queue` xử lý due, hierarchy, limit, sort, siblings và filtered deck; không để scheduler tự quyết mọi thứ trong router.
- `Reviewer` chỉ trình bày, audio/timer và thao tác; server là nguồn sự thật cho lịch và quota.
- FSRS: thuật toán/version, desired retention, parameters, optimize/evaluate bằng lịch sử thật, phạm vi preset, maximum interval, reschedule-on-change tường minh, preview tác động và backup trước batch reschedule. Không có lịch sử thì dùng default đã pin, không giả vờ đã tối ưu cá nhân.
- SM-2 tương thích: đối chiếu Again/Hard/Good/Easy theo từng state; không coi repetitions như chỉ số để luôn áp interval 1/6 ngày; kiểm tra ease/fuzz/overdue theo phiên bản mốc.
- Learning nội ngày khác interday; lapse interval chỉ giảm đúng thời điểm, không giảm hai lần qua preview/apply hoặc graduate.
- Study-day theo timezone/rollover, log UTC; có clock injection để test qua nửa đêm, đổi timezone và DST.
- Chống double-submit: request ID/idempotency và version card; hai tab không ghi hai lượt review cùng một trạng thái.
- Bury là ẩn tạm đến study-day tiếp; suspend là loại khỏi học cho tới khi bật lại. Siblings dựa vào Note ID, kể cả card ở deck khác.
- Learning chưa due: thông báo thời gian chờ hoặc chỉ lấy trong learning-ahead window đã định nghĩa; không trả thẻ bất kỳ trong tương lai.
- Undo phải hoàn tác lịch, event, quota và sibling bury của đúng operation; không chỉ đổi card hiện trên màn hình.

Nghiệm thu: cùng snapshot/config/clock/rating sequence cho kết quả như engine mốc trong phạm vi đã chốt; khi có fuzz dùng seed hoặc so vùng hợp lệ. Test new/learning/interday/review/relearning, bước rỗng, overdue, leech, suspension, quota=0, cây deck, today-only, timezone, hai tab và undo. Không dùng test chép lại công thức đang viết làm bằng chứng tương thích.

## 6. Ma trận mọi tùy chọn trong ảnh và phần liên quan

Các nhóm đối chiếu gồm Daily Limits, New Cards, Lapses, Display Order, Burying, Audio, Timers, Auto Advance, Easy Days và FSRS. Tên trong cột đầu lấy từ ảnh người dùng và UI hiện tại. Cột nghiệm thu là đặc tả đề xuất cho web. Tài liệu Anki là nguồn để chốt chi tiết theo phiên bản, đặc biệt sự khác nhau giữa SM-2 và FSRS; không sao chép mọi giá trị mặc định từ ảnh. [Tham chiếu Options](https://docs.ankiweb.net/manual/deck-options).

| Nhóm / tùy chọn | Hiện tại | Cần thực thi / nghiệm thu |
|---|---|---|
| Preset dropdown / used-by count | Dropdown tĩnh | CRUD, clone, rename, assign; đếm deck thật; đổi preset tác động đúng các deck liên quan |
| Save / menu / apply subdecks | Chỉ lưu JSON cho deck | Save nguyên tử, báo thay đổi chưa lưu, apply subdecks đúng phạm vi, rollback lỗi |
| New cards/day; Maximum reviews/day | Có config và quota cơ bản | Validation; phân biệt số card/lượt học; đồng nhất API count với queue |
| Preset / This deck / Today only | Chưa có đầy đủ | Override rõ nguồn, expiry theo study-day, reset về kế thừa |
| New cards ignore review limit | Có UI, thiếu consumer config | Hai trạng thái cho queue khác nhau đúng; không học new khi review cap chặn nếu cờ tắt |
| Limits start from top | Có UI, thiếu hierarchy | Chọn subdeck vẫn tôn trọng giới hạn ancestor khi bật |
| Learning steps | Có parser và state machine một phần | Parse hợp lệ/không âm; từng bước, rỗng, nội ngày/liên ngày, Hard preview đúng lịch |
| Graduating interval / Easy interval | Có SM-2 | Áp dụng đúng state; ẩn/giải thích khi engine FSRS không dùng |
| Insertion order | Có UI/config, query hiện sort created_at | Position bền vững hoặc random theo policy; không đổi thứ tự hỗn loạn mỗi request |
| Relearning steps / Minimum interval | Có xử lý một phần | Lapse rồi graduate giữ interval đúng; không áp tham số SM-2 vào FSRS ngoài ý nghĩa của engine |
| Leech threshold / action | Có flag và auto-suspend | Tag `leech` thật ở note khi chọn tag; quản lý unsuspend; tương thích quy tắc lặp leech của mốc |
| New card gather order | UI/lưu JSON | Thu thập theo deck/position/random như lựa chọn được hỗ trợ, tôn trọng hierarchy và quota |
| New card sort order | UI/lưu JSON | Tách gather khỏi sort; dùng ordinal/template để nhóm card đúng |
| New/review order | UI/lưu JSON | Before/after/mix có tác dụng trong queue và counter |
| Interday learning/review order | UI/lưu JSON | Phân biệt interday khỏi learning nội ngày; test thứ tự và quota |
| Review sort order | UI/lưu JSON | Implement từng lựa chọn đã công bố; thêm FSRS difficulty/retrievability khi engine có dữ liệu |
| Bury new siblings | UI/lưu JSON, thiếu note model | Học card A ẩn siblings new theo note, không chặn chính A học lại |
| Bury review siblings | UI/lưu JSON | Ẩn sibling review; unbury thủ công/ngày mới; không sửa due nền |
| Bury interday learning siblings | UI/lưu JSON | Xử lý đúng state; kết hợp ba cờ có bộ test riêng |
| Don't play audio automatically | UI, StudyPage auto-play | Tắt thật; vẫn replay được; xử lý browser chặn autoplay |
| Skip question when replaying answer | UI/lưu JSON | Replay mặt sau theo cờ; audio chạy tuần tự, dừng audio cũ khi đổi card |
| Maximum answer seconds | UI, log chưa lưu duration | Cap thời gian ghi thống kê, không tự đánh trượt chỉ vì hết cap |
| Show on-screen timer | UI/lưu JSON | Đồng hồ thật; không đếm hai lần do rerender; quy tắc tab ẩn xác định |
| Stop timer on answer | UI/lưu JSON | Timer dừng/tiếp đúng cờ, tách thời gian mặt trước/mặt sau nếu cần |
| Seconds to show question/answer | UI/lưu JSON | Timer bắt đầu/reset đúng; 0 có nghĩa được giải thích rõ; không submit lặp |
| Wait for audio | UI/lưu JSON | Chờ queue audio kết thúc; audio lỗi không gây treo vô hạn |
| Question action / Answer action | UI/lưu JSON | Chỉ cho chọn action đã implement; Show Answer/Bury/... thực thi thật; hủy timer khi rời trang |
| Easy Days | UI slider, nhãn Maximum hiện khác ảnh | Hiển thị Minimum/Reduced/Normal; scheduler phân phối workload có ràng buộc, không đơn giản nhân interval với %; mode không hỗ trợ phải disable |
| FSRS | Toggle chưa có engine | Đầy đủ engine/parameters/retention/version/log/preview, không có nút bật giả |
| Maximum interval và SM-2 advanced | Có một phần | Schema bounds, units đúng; cùng config ở preview/apply; giải thích mode-specific |
| Custom scheduling | Hiển thị một phần | Backlog nâng cao; chỉ chạy trong môi trường cách ly có timeout, không eval JS trong app origin/backend |
| Nút ? và reset | Phần lớn biểu tượng tĩnh | Trợ giúp từng mục, default theo mode, reset tường minh, tên truy cập và bàn phím |

Nguồn thực thi cần rà soát khi triển khai: `DeckOptionsPage.tsx`, `backend/sm2.py:DeckSchedulingConfig`, `_load_deck_config`, queue ở `study_router.py`, `StudyPage.tsx`, `ReviewLog`. Không đánh dấu “xong” chỉ vì setting được gửi tới server và lưu lại.

## 7. Các khả năng khác cần thêm để gần Anki

Danh sách là backlog mở rộng theo tác vụ Anki Desktop, không cam kết bao gồm mọi add-on bên thứ ba hoặc mọi phiên bản lịch sử.

| Mã | Nhóm | Đề xuất / tiêu chí chính | Ưu tiên |
|---|---|---|---|
| A01 | Note types | Basic, reversed, optional reversed; field tùy ý; thêm/xóa/sắp field; đổi note type với mapping và preview card bị ảnh hưởng | Nền tảng |
| A02 | Cloze | Nhiều cloze index, hint, một index nhiều chỗ che, edit không tạo card trùng; giữ cú pháp nguồn | Cao |
| A03 | Image occlusion | Vẽ/sửa/xóa mask, mode hide-one/hide-all theo phạm vi đã chốt, ảnh gốc+mask data, import/export fixture. **25/10/2026:** đã triển khai subset hình chữ nhật; xem mục Image Occlusion trong `TIEN_DO_TUONG_THICH_ANKI.md` để biết kiểm chứng và giới hạn. | Sau A01/A02 |
| A04 | Templates | Front/back/CSS editor, live preview, field replacement, conditional sections, FrontSide, card generation/empty card detection | Cao |
| A05 | Renderer | Typed answer + so đáp án, hint, filters, ruby/RTL/fonts, MathJax/mhchem; LaTeX legacy cần pipeline riêng, không phải import `.tex` | Theo giai đoạn |
| A06 | Editor | Rich text + source HTML, paste/drag-drop media, audio recording, sticky fields, chọn type/deck/tags, cảnh báo trùng và field trống | Cao |
| A07 | Browser | Cards/Notes mode; sidebar deck/tag/type; cột/sort/page/virtualization; preview và card info/lịch sử | Cao |
| A08 | Search | Parser dùng chung: deck/tag/note/card/state/flag/due/rated/added/field, AND/OR/NOT/quote; báo query sai; saved searches | Cao |
| A09 | Bulk operations | Move deck, tags, flags, mark, suspend/unsuspend, bury/unbury, find/replace có preview, đổi note type | Cao |
| A10 | Scheduling tools | Forget/reset, set due date, reposition new cards; phân biệt thay lịch với xóa history; undo và batch confirmation | Cao |
| A11 | Study UX | Space show answer, 1–4 rate, replay audio, edit/info, bury/suspend/mark/undo; không chiếm phím khi nhập; counts new/learn/due và finish/wait state | Cao |
| A12 | Filtered/custom study | Search-based deck, rebuild/empty, giới hạn/thứ tự, giữ deck/due gốc; preview không đổi lịch khác mode reschedule | Sau search/queue |
| A13 | Statistics | Review count/time, answer buttons, forecast, interval distribution, workload, calendar; FSRS retention/state khi có; bộ lọc deck/collection/time | Sau log |
| A14 | Deck operations | Deck cha/con, rename/move, options/presets, description, delete có preview; giới hạn không bị nhân đôi khi tổng hợp tree | Cao |
| A15 | Media tools | Add/record/play audio/video; replay tuần tự; check missing/unused; dedupe; user-confirmed cleanup; fonts/CSS refs cũng được tính | Cao |
| A16 | Integrity tools | Check database, duplicate notes, empty cards; báo vấn đề trước sửa; không xóa media khi còn được template/CSS/note khác tham chiếu | Cao |
| A17 | Backups/restore | Collection snapshots tự động + trước import/migrate/reschedule; retention; restore thử nghiệm; backup đầy đủ media tách rõ với DB-only | Cao |
| A18 | Profile/preferences | Nhiều collection/profile nếu cần; theme/light/dark/system, language, timezone/rollover, zoom, font, giảm chuyển động, preference theo tài khoản | Vừa |
| A19 | Multi-device sync | Server đồng bộ nội bộ, revisions/tombstones, media incremental, conflict UI, tránh review trùng; backup trước full replacement | Sau offline design |
| A20 | Offline/PWA | Cache app + collection/media được chọn, offline review queue và outbox/idempotency; quota/storage eviction/reconnect rõ ràng | Giai đoạn sau |
| A21 | Shared decks | Giữ luồng đã có; publish/update dựa GUID, version/metadata/media checks; tải không kéo theo lịch học cá nhân mặc định | Sau import |
| A22 | Advanced compatibility | Template JS/custom scheduler, TTS, LaTeX legacy, add-on hooks: đánh giá từng khả năng, sandbox hoặc adapter; hiển thị unsupported rõ ràng | Sau nền tảng |

Tham chiếu hành vi: [note/editor](https://docs.ankiweb.net/manual/editing), [templates](https://docs.ankiweb.net/manual/templates/intro), [field rendering](https://docs.ankiweb.net/manual/templates/fields), [math](https://docs.ankiweb.net/manual/math), [browser](https://docs.ankiweb.net/manual/browsing), [search](https://docs.ankiweb.net/manual/searching), [filtered decks](https://docs.ankiweb.net/manual/filtered-decks), [statistics](https://docs.ankiweb.net/manual/stats), [media](https://docs.ankiweb.net/manual/media), [backups](https://docs.ankiweb.net/manual/backups), [sync](https://docs.ankiweb.net/manual/syncing).

## 8. Giao diện theo ảnh và những giới hạn của nền web

Options desktop: thanh trên gọn, tên deck, preset selector + Save split-button; hai cột nhóm theo ảnh, nền xám đậm, khoảng cách và kích thước chữ vừa phải. Hiện CSS kiểu glass-card cần giảm nếu mục tiêu là giống ảnh. Easy Days dùng đúng nhãn mức thay vì “Maximum”. Trên mobile chuyển một cột và giữ thao tác Save dễ tìm. Chưa đo trực tiếp nên chưa chốt thông số pixel hay khẳng định đã giống.

Các màn hình cần nhất quán: Decks → Overview → Study; Add/Edit theo field; Browse nhiều vùng; Statistics; Import preview/summary; Export options; Media/Backup manager. Có trạng thái loading/empty/error/retry; không báo lỗi chỉ bằng console. Menu/phím tắt/focus phải dùng được bằng bàn phím và có nhãn screen reader.

Không cho template từ APKG chạy script với quyền của website chính: dùng renderer cách ly, CSP, validate postMessage và URL/media policy. Nếu template JS chưa tương thích thì báo trước import. Giữ dữ liệu nguồn khi sanitize để có thể export lại, nhưng không phát hành lại nội dung nguy hiểm mà không có policy chia sẻ rõ ràng. CSP phải áp dụng ở nơi phục vụ HTML frontend, không chỉ JSON API.

AnkiWeb là dịch vụ riêng: tài khoản web này không tự đồng bộ được với AnkiWeb. Chưa có cam kết API/quyền tích hợp thì dùng APKG/COLPKG làm cầu trao đổi hoặc nghiên cứu adapter riêng. Add-on Python/Qt desktop không chạy trực tiếp trong React/browser. Quyền autoplay, microphone, TTS, codec, filesystem và offline storage phụ thuộc trình duyệt; phải có fallback. PWA là cách triển khai web đề xuất, không phải tuyên bố AnkiWeb hiện có đúng khả năng đó.

## 9. Lộ trình triển khai có cổng nghiệm thu

| Giai đoạn | Công việc | Điều kiện chuyển bước |
|---|---|---|
| G0 — Chốt mốc và bảo toàn dữ liệu | Chọn phiên bản Anki; fixtures + manifests; sao lưu; audit CSP/auth/media; đánh dấu setting chưa hoạt động | Restore thử thành công, không mất dữ liệu; không còn label giả gây hiểu sai |
| G1 — Note/card và migration | Note types, fields/templates, GUID, hierarchy, presets, media references, event log; renderer Basic/cloze nền tảng | Migration giữ số card/progress; một note tạo siblings đúng; API compatibility và rollback qua test |
| G2 — Interoperability | CSV/TXT/TSV wizard; APKG codec/version + update; export không mất field/template; COLPKG scope | Ma trận round-trip với Anki mốc đạt theo manifest; unsupported được báo rõ |
| G3 — Scheduler/queue | Adapter engine; FSRS + SM-2 contract; timezone/quota/order/bury/leech/preview/undo/idempotency | Test vectors và sequence đối chứng; toàn bộ cờ queue có test hành vi |
| G4 — Reviewer và Options giống ảnh | Preset scope; audio/timers/auto advance/Easy Days; keyboard; save validation/help | Từng hàng ma trận Options chứng minh thay đổi hành vi, E2E desktop/mobile pass |
| G5 — Tác vụ Anki hàng ngày | Browser/search/bulk/custom study/stats/editor/image occlusion/check media/backups | Dữ liệu mẫu lớn thao tác không mất state; undo/batch/restore được kiểm thử |
| G6 — Offline/sync và nâng cao | Outbox/conflicts, media sync, profiles, renderer nâng cao, TTS/LaTeX/extension strategy | Hai thiết bị offline/reconnect không nhân review; conflict/restore có kiểm chứng |

G2 và G3 có thể chia thành lát nhỏ sau G1, nhưng không được làm scheduler hoặc import phụ thuộc schema cũ rồi phải viết lại. G4 chỉ gắn một tùy chọn khi backend/renderer tương ứng đã sẵn sàng. Không cần làm mọi tính năng trước khi dùng local: release theo lát có dữ liệu/thuật toán đúng và công bố phạm vi hỗ trợ.

## 10. Bộ tiêu chí hoàn thành bản gần Anki

- Tất cả định dạng bắt buộc có import/export và bộ round-trip, không chỉ download ra file mang đúng đuôi.
- Basic/reversed/cloze, nhiều field/template, tags, hierarchy và media giữ nguyên ý nghĩa sau trao đổi.
- Học theo spaced repetition thật; interval preview khớp lịch ghi; đổi Options tạo thay đổi quan sát được trong queue/reviewer.
- Mọi control trong ảnh đã được kiểm tra, hoặc ẩn/disable kèm lý do; không còn switch chỉ để lưu JSON.
- Stats dựa event thật; log thiếu được ghi thiếu, không bịa duration/interval lịch sử.
- Có undo, backup và restore; import/migration/batch không làm hỏng collection khi lỗi giữa chừng.
- Có test scheduler theo clock/version, parser/import/export, cross-user access, rendering XSS, API integration và E2E các luồng chính.
- Kiểm thử collection nhỏ, lớn và gói media lớn; đặt ngân sách hiệu năng dựa môi trường đo, không hứa số liệu chưa benchmark.
- Build/lint/test/CI chạy lại khi triển khai; review tĩnh lần này không xác nhận các check đó đang pass.

## 11. Ghi chú với đề xuất bảo mật cũ

Giữ những sửa chữa đã có; không viết lại auth vì mục tiêu parity. P0.1 đang chọn phương án tạm vô hiệu hóa reset, nên token email một lần không phải tính năng đã tồn tại. JWT secret code đã đọc env, nhưng rotation production cần xác minh riêng. File token từng được báo trong review trước có thời hạn đã qua theo metadata mà reviewer nêu; không được gọi là token hiện hoạt động chỉ vì decode được. Rating ngoài phạm vi đang bị router từ chối; thiếu constraint schema là nợ hợp đồng API, không phải bằng chứng lỗi chấp nhận rating sai.

## 12. Các quyết định thiết kế khuyến nghị

1. Dùng **Anki Desktop** làm mốc chính; mục tiêu mặc định là đúng dữ liệu/hành vi trước rồi giống giao diện.
2. Chốt CSV/TXT/TSV/APKG là bắt buộc; thêm COLPKG cho collection backup/restore, hỗ trợ hiện đại theo ma trận version.
3. Có FSRS và mode SM-2 được kiểm chứng; không tự đổi lịch hàng loạt khi bật hoặc đổi tham số.
4. Giữ dữ liệu import nguyên bản + cảnh báo khả năng chưa render được; không tiếp tục ép mọi deck về front/back.
5. Ưu tiên G0–G3 trước custom JS/add-ons/AnkiWeb sync; các mục sau vẫn giữ trong backlog để đạt độ gần Anki tối đa theo từng đợt.

## 13. Kết quả đối chiếu với AGY / Claude và các điểm đã hiệu chỉnh

AGY dùng Claude Sonnet 4.6 Thinking đã trả kết quả SUCCESS sau khoảng 8 phút. Nó tự mở hai subagent đọc backend/frontend. Báo cáo gốc ở `/home/bluenip/.gemini/antigravity-cli/brain/0d4e9e8c-b5dd-46e0-ae0b-9618fde5ebc3/BAO_CAO_ANKI_CLONE.md`; nội dung chưa được coi là kết luận đúng nếu chưa đối chiếu lại.

**Điểm thống nhất:** mô hình Note/Card là việc nền tảng; preset, FSRS, display order, burying, timers, auto advance, Easy Days còn nhiều placeholder; APKG chưa round-trip đầy đủ. Lộ trình trong tài liệu này đã tổng hợp các phát hiện đó.

**Các hiệu chỉnh sau khi Codex đọc lại code:**

- CSV/TXT không phải hoàn toàn chưa có: frontend đã nhận file, backend có import text. Phần thiếu là parser đúng chuẩn, nhiều field, preview/mapping/update và export tương ứng. Đã sửa bảng hiện trạng trong tài liệu này.
- Báo cáo Claude nói import revlog đã có: chưa thấy đường đọc bảng revlog trong `import_apkg`; `ReviewLog` đang được truy vấn ở phần export. Không tính “bảo toàn lịch sử import” là đã hoàn thành.
- Báo cáo Claude mô tả Hard preview dùng trung bình: code thực tế ở `_get_learning_intervals` dùng bước hiện tại, còn `_handle_learning` có dùng trung bình với bước sau. Đây là bất nhất nội bộ đã đọc được. Quy tắc Anki còn phụ thuộc bước đầu/bước sau và số bước, phải chốt theo engine mốc; không lấy công thức đơn giản trong báo cáo làm đặc tả.
- Không kết luận mọi lần due sau vài giây quanh giờ đổi ngày là bug: interval theo study-day không đồng nghĩa đủ 24 giờ thực. Khoảng cách đã xác nhận là web cố định UTC 00:00, thiếu timezone/rollover; cần đối chiếu chính sách ngày học thay vì sửa thành cộng cứng N×24 giờ.
- Fallback học sớm không nhất thiết sai trong mọi tình huống vì có learning-ahead. Điểm thiếu là không có cửa sổ/điều kiện giới hạn tương ứng.
- Không coi Good/Easy khi relearning cùng interval mặc nhiên là sai, cũng không áp easy_bonus cho mọi state; cần fixture theo phiên bản mốc.
- Không dùng câu “đã chạy đúng” trong báo cáo Claude làm kết quả kiểm thử: lượt này chỉ đọc tĩnh.

**Bổ sung các việc bảo toàn dữ liệu/quyền riêng tư trước mở rộng:**

| Việc | Bằng chứng | Đề xuất nghiệm thu |
|---|---|---|
| Media người dùng đang có URL public | `backend/main.py:91` mount StaticFiles không qua dependency auth | Phân biệt private/shared media, quyền tải hoặc signed URL phù hợp img/audio; biết URL không đồng nghĩa được đọc media private |
| Download shared deck giữ URL media của tác giả | `backend/routers/shared_router.py:119` copy front/back nguyên bản | Copy/dedupe vào sở hữu người tải và rewrite reference; tác giả xóa deck/media không làm bản tải hỏng |
| Xóa từng card chưa xóa ReviewLog rõ ràng | `backend/routers/cards_router.py:delete_card`, `models.py:79` | Chốt policy history, cascade/cleanup theo transaction; test với foreign keys thật |
| Chưa có uniqueness cho state user/card trong model | `backend/models.py:54` | Unique constraint + optimistic concurrency/idempotency, xử lý dữ liệu trùng cũ trước migration |
| Shared deck rating chưa có bảng một vote/user | `backend/routers/shared_router.py:rate_shared_deck` | Upsert vote theo user/deck; aggregate có thể tính lại; không tăng vô hạn cùng user |
| Settings string và schema/consumer lệch nhau | `DeckOptionsPage.tsx`, `schemas.py`, `DeckSchedulingConfig` | Hợp đồng typed/versioned từ UI tới engine, reject invalid values thay vì âm thầm bỏ qua |

Đưa các mục trên vào G0/G1; chưa sửa code trong lần lập đề xuất này. Tài liệu mới là kết quả tổng hợp, không phải phê duyệt triển khai tự động.

## 14. Chi phí khảo sát và cách giao việc sau này

Lượt review AGY này báo `input_tokens=234829`, `output_tokens=16033`, `cache_read_tokens=800210`, `total_tokens=250862`. Các trường do CLI báo không được cộng tùy tiện để suy ra quota/chi phí tài khoản; `total_tokens` không bao gồm cache read theo cách cộng giản đơn ở kết quả này.

Để tiết kiệm, các đợt sau nên để Codex lập inventory trước, giao Claude một phần thay đổi/câu hỏi cụ thể, yêu cầu không mở subagent, giới hạn lượng đọc và độ dài đầu ra. Đây là khuyến nghị cho lần sau, chưa thay đổi toàn bộ cấu hình AGY hay chuyển model mặc định của người dùng.
