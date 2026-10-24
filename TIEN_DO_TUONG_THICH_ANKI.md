# Tiến độ triển khai tương thích Anki

Cập nhật 23/10/2026. Phạm vi đối chiếu định dạng: backend Anki **26.9.3**. Đây là triển khai từng phần của `DE_XUAT_TUONG_THICH_ANKI.md`, chưa phải toàn bộ Anki Desktop.

## Đã có trong code

### Notes và hiển thị

- Schema bổ sung NoteType, Note, NoteCard, metadata package, trạng thái scheduler và nhật ký thao tác. Giữ Card ID/StudyProgress cũ; không tự backfill collection thật.
- Basic, reversed, optional reversed và cloze nhiều index/hint; fields/tags/GUID gốc được giữ riêng khỏi HTML card. Form Add và Edit dùng fields nguồn, không sửa nhầm projection của reversed/cloze.
- Sửa note giữ ID/lịch học của card còn tồn tại; từ chối xóa cloze/card đã có progress. Sửa nội dung tăng version để tab đang mở câu hỏi cũ phải reload.
- Note editor bỏ phản hồi tải note cũ sau khi đổi card/hủy/đổi deck; kết quả save cũ không đóng editor mới. Refresh danh sách dùng deck/query hiện tại và loại phản hồi cũ. Add/Edit giữ dấu phẩy trong tag; chỉ khoảng trắng phân cách tag. Note editor gửi revision của note; backend kiểm tra dưới write lock để chặn hai tab ghi đè nhau. Caller cũ không gửi revision vẫn được hỗ trợ. Sibling khác deck được render theo deck riêng.
- Renderer hỗ trợ field replacement, conditional/inverted sections, FrontSide, cloze/text/hint, Tags/Deck/Subdeck/Type/Card. Ngữ cảnh Deck/Tags được tính lại khi học. Filter chưa hỗ trợ hoặc nested cloze bị từ chối rõ ràng.
- HTML được sanitize trong iframe riêng; CSS của note type được giữ và dùng khi học. Script trong template/field được lưu nguồn cho export nhưng không chạy trong web.
- Media portable `[sound:...]`, tên Unicode, HTML entities trong tên ảnh, CSS fonts; URL của web không thay thế fields nguồn khi export.

### Trình soạn, media và đáp án gõ (bổ sung 23/10/2026)

- Màn `/note-types`: tạo/clone note type, chỉnh fields/templates/CSS, preview qua renderer thật. Lưu có revision và write lock, re-render mọi note trong cùng transaction; giữ card IDs/lịch học, rollback cả batch nếu một note không render được. Field chứa dữ liệu không bị xóa/đổi tên ngầm; không đổi cloze thành regular khi đã có notes. Chưa có UI mapping đổi tên field/xóa template đang dùng.
- Add chọn được note type tùy chỉnh. Add/Edit có toolbar HTML cơ bản (bold/italic/underline/list/subscript/superscript/math), đính kèm ảnh/audio và ghi âm. Upload tối đa 20 MB, tên SHA256 tránh ghi đè; source dùng tên portable. Ghi âm phụ thuộc quyền microphone/HTTPS và codec trình duyệt, chưa kiểm tra microphone vật lý.
- `/media`: kiểm tra file thiếu và chưa được tham chiếu bởi notes/templates/CSS; chưa tự xóa. File của draft chưa lưu có thể hiện là unused.
- `type:`/`type:cloze:` có ô nhập, Enter reveal, so sánh sau reveal; hỗ trợ `nc` (bỏ dấu) và `ci` (không phân biệt hoa thường). Thêm Basic (type in the answer). Vẫn tự chọn rating, không tự chấm lịch học. Hiện hiển thị hai đáp án và Match/Different, chưa diff từng ký tự giống Anki.
- Furigana/kana/kanji và hint details hoạt động trong renderer đã sanitize. Công thức `\(…\)`, `\[…\]`, `$$…$$`, `[$]…[/$]`, `[$$]…[/$$]` dùng KaTeX 0.19 + mhchem, tài nguyên đóng gói local, không chạy script của note. Đây là subset TeX, không phải toàn bộ MathJax/LaTeX engine của Anki; custom macros cấu hình và `[latex]` chưa hỗ trợ.
- Lazy-load các trang lớn; cập nhật dependency trong phạm vi phiên bản tương thích, npm audit không còn cảnh báo ở lần kiểm tra này.

### CSV/TXT/TSV

- Parser CSV chuẩn: UTF-8/BOM, quoted delimiter, escape, multiline, đổi Front/Back, header tùy chọn, HTML/plain text.
- Nhận separator/html/columns/guid column directives, separator không phân biệt hoa/thường; preview rồi Add/Skip/Update; update giữ progress và GUID.
- Import nâng cao hỗ trợ Basic/reversed/optional reversed/Cloze, fields mapping, GUID/tags columns, global tags, #notetype và note type tùy chỉnh đã tồn tại theo ID. Preview không tạo metadata, kể cả card legacy; batch lỗi được rollback. Từ chối xóa card có lịch học khi update cloze/reversed.
- Export một dòng theo note nguồn, giữ tags/GUID/empty extra fields; không nhân đôi note reversed/Cloze. Gắn #notetype cho file nâng cao; nhập lại nhận loại note tự động. Loại tùy chỉnh phải tồn tại trước vì text không chứa template/CSS.
- Import/export CSV/TXT/TSV nhiều note type và deck qua #notetype column/#deck column; hỗ trợ #deck cố định. File xuất cây deck gồm subdecks, mỗi note chỉ một dòng; API có include_subdecks=false.
- Tạo deck theo file cần bật lựa chọn riêng; preview liệt kê cả parent decks sẽ tạo. Preflight toàn bộ các nhóm trước khi ghi, một commit chung; lỗi giữa chừng rollback cả notes, note types và deck hierarchy.
- Metadata columns không chiếm field mapping; chấp nhận padding rỗng cho loại note ít fields hơn và từ chối cột dư có nội dung. Trường bắt đầu bằng # được quote để không bị hiểu nhầm là directive.
- **Giới hạn:** tối đa 10.000 notes, 100 cột và 100 tổ hợp note-type/deck mỗi lần nhập; custom note types phải có sẵn. Text không chứa template/CSS, media bytes hay lịch học. Add với GUID đã tồn tại yêu cầu đổi sang Skip/Update; cập nhật không tự chuyển card sang deck khác. Chưa hỗ trợ match scope toàn collection theo first field như mọi tùy chọn Anki.

### APKG/COLPKG

- Đọc legacy `collection.anki2`/`collection.anki21` và modern `collection.anki21b`; modern zstd/protobuf được giải mã bằng adapter Anki đã pin, trên DB tạm.
- Kiểm tra ZIP paths/symlinks/count/size, ngân sách giải nén zstd lồng, manifest size/hash, media count/type/size. Ghi DB/media có rollback khi copy/commit thất bại.
- Giữ GUID, nhiều fields/templates/CSS/tags/card ordinals, hierarchy, flags/data và revlog metadata trong phạm vi renderer hỗ trợ. GUID đã tồn tại chỉ cập nhật nội dung nguồn mới hơn; giữ lịch/deck hiện tại của card đã có.
- Export APKG legacy/modern; lựa chọn kèm scheduling. Modern giữ stability/difficulty/last review của FSRS qua native Card API; legacy Anki tự loại FSRS memory nên modern là lựa chọn mặc định trên UI.
- Kèm history giữ duration thực, interval lịch sử (learning dùng số giây âm), reps/lapses/ease, suspended state và due theo ngày học. Đã sửa lỗi native adapter reset scheduling, reserved deck ID=1 bị đổi thành Default, due của suspended review bị ghi thành epoch, và lệch ngày khi chuyển modern.
- COLPKG xuất collection và restore **vào account có collection trống**, cần thao tác restore tường minh; không ghi đè collection có sẵn. Giữ deck rỗng, note type chưa dùng và shared preset/per-deck limits trong fixture đã thử. Native Anki có thể tạo Default/ancestor decks và stock note types.
- Preset/deck metadata nguồn được giữ; các option đã map được trao đổi với Anki. Không coi package này là backup bit-for-bit của mọi cấu hình/hành vi web.
- Chặn media cùng tên nhưng khác bytes khi file đang được note/template khác dùng; hiện yêu cầu đổi tên ở package nguồn, chưa tự remap conflict.
- **Giới hạn:** image occlusion có card, notes không có card trong collection restore, filter đặc biệt chưa hỗ trợ bị từ chối. SVG chưa được nhập. Các preference toàn collection, timezone IANA, today-only overrides, metadata ngoài schema hỗ trợ chưa cam kết round-trip đầy đủ. Export kèm scheduling từ nhiều deck dùng lẫn SM-2/FSRS bị từ chối vì Anki dùng scheduler chung cho collection.
- Giới hạn upload 50 MB, giải nén 150 MB, tối đa 10.000 card nhập/lần; không khẳng định đã kiểm tra collection lớn.

### Scheduler, queue và review

- Engine **py-fsrs 6.3.2**, lưu version/state/stability/difficulty; desired retention/21 parameters có validation. Không tự reschedule hàng loạt khi bật FSRS.
- Card cũ có history được replay; review card không có history được khởi tạo estimate và ghi rõ nguồn. Fuzz FSRS có tùy chọn bật riêng (mặc định tắt), dùng biên độ của Anki và seed ổn định giữa preview/apply/retry/undo; chỉ tác động lần review tiếp theo, không đổi lịch hiện có. Seed khác Anki nên không cam kết ngày ôn trùng tuyệt đối. Đã có optimizer giới hạn lịch sử web đầy đủ (mô tả bên dưới); chưa có retention fitting hay Easy Days/load balancing giống Anki.
- Khi bật FSRS, card learning/relearning không có history vẫn giữ bước học hiện tại; memory của relearning được ước lượng.
- SM-2 hiện có được giữ như chế độ cũ; Hard learning/relearning dùng chung phép tính preview/apply. Chưa khẳng định SM-2 này giống thuật toán Anki mọi chi tiết.
- Queue tách new/intraday/interday/review; không đưa card tương lai trở lại ngay chỉ vì hết card khác. Learning-ahead là option tường minh.
- Display order, giới hạn selected deck/subdeck/ancestor, new-ignore-review-limit và start-from-top được dùng trong runtime. Deck list/detail/study stats lấy cùng logic quota.
- Review có request ID chống gửi trùng và version chống ghi từ tab cũ; review mới từ UI kiểm tra lại eligibility/quota trong phạm vi deck học. Legacy API caller không gửi study_deck_id vẫn giữ luồng cũ.
- Bury new/review/interday siblings theo Note; suspend/bury/unbury/unsuspend API; leech flag/tag/action.
- Undo review nhiều bước khôi phục progress, FSRS state, sibling bury, leech tags và log; versions vẫn tăng để chặn request cũ. Undo từ chối nếu có thay đổi mới không thể khôi phục an toàn. Bury/suspend riêng chưa phải thao tác undo tổng quát.
- Study-day timezone/cutoff, calendar days qua DST; today summary dùng review duration thật, không còn dòng thống kê 0 giả.

### Optimizer FSRS (bổ sung 23/10/2026)

- Options → FSRS → Optimize dùng native Anki đã pin, trong subprocess có giới hạn 120 giây. Chỉ tính trọng số, không ghi settings/lịch học; người dùng bấm Use rồi Save để áp dụng cho các lần ôn tiếp theo.
- Phạm vi selected deck/subtree, cần tối thiểu 400 interday outcomes có điểm bắt đầu học xác định; chỉ nhận history web có metadata trạng thái. Không suy đoán lịch sử imported/manual/incomplete. Delta tính theo ngày học home deck của web; chưa cam kết giống optimizer Anki ở mọi clock/reset/import fixture.
- Giới hạn 50.000 log, 20.000 mẫu và 1.000.000 phần tử history; một job huấn luyện mỗi process. Native smoke đã chạy với 400 mẫu tổng hợp và nhận 21 tham số qua validator. Chưa có đánh giá log loss/health check, ignore-before, fitting retention hoặc chạy optimizer tự động.

### Presets và deck tree

- Preset dùng chung theo user, version/CAS khi save; used-by count thật, create/attach/detach. Không tự đổi preset cho deck cũ.
- This deck và Today only override hai daily limits. Hết ngày học thì today override hết hiệu lực; clear trả về deck/preset. Main Options luôn sửa base settings, không ghi today override vào preset.
- Tạo `Parent::Child` tạo parents thiếu; child mới kế thừa preset của parent khi có. Rename/move cả subtree giữ IDs/progress, kiểm tra collision/self move; delete parent bao gồm subdecks và ORM metadata cleanup.

### Browser: tìm kiếm và thao tác hàng loạt (2026-10-23)

- Tìm từ trong các fields nguồn của note, kể cả trường không xuất hiện trên mặt thẻ; card legacy dùng front/back và không tự backfill khi browse.
- Hỗ trợ AND ngầm/AND, OR, nhóm ngoặc, dấu trừ phủ định, cụm từ trong dấu ngoặc kép, wildcard `*` / `_` và escape. Bộ lọc `deck:` (kèm subdecks), `tag:` (kèm subtags, `tag:none`), `note:`, `cid:`, `nid:`, `is:new/learn/review/suspended/buried/due`. `is:due` xét cutoff/timezone/learning-ahead của home deck, bỏ qua daily quota; `deck:filtered` và tên phiên lọc được hỗ trợ.
- So sánh số nguyên không âm qua `prop:ivl`, `prop:reps`, `prop:lapses`, dùng `=`, `!=`, `<`, `<=`, `>`, `>=`. Thẻ chưa có progress được tính 0 cho ba thuộc tính này.
- SQL có tham số, giới hạn độ dài/token/độ sâu truy vấn; cú pháp sai và toán tử chưa hỗ trợ trả 422 rõ ràng. Mọi kết quả bị giới hạn theo tài khoản đăng nhập.
- Phân trang tối đa 1.000 card/trang, thứ tự created_at rồi ID giảm dần; có Previous/Next. Offset pagination không phải snapshot: khi tab khác thêm/xóa/chuyển thẻ, vị trí giữa các trang có thể thay đổi.
- Chọn tối đa 500 card trên trang hiện tại; suspend/unsuspend/bury/unbury và chuyển sang deck đích đã tồn tại. Kiểm tra ownership nguồn/đích và version từng card; một card thiếu hoặc stale thì không ghi một phần batch. Chuyển deck giữ note, lịch học, FSRS memory và trạng thái suspend/bury.
- Add/Remove Tags theo note: chọn một card sẽ tác động mọi sibling, kể cả khác deck/trang; UI nêu rõ phạm vi. Tối đa 500 card được chọn và 1.000 sibling bị tác động, 100 tag/note, 100 ký tự/tag. So khớp không phân biệt hoa thường; xóa tag cha xóa cả subtags, đối chiếu native Anki. Dấu phẩy là ký tự trong tag, khoảng trắng phân cách tag.
- Batch tag tăng version mọi sibling, giữ lịch học/FSRS/bury, rollback cả batch khi stale/thiếu quyền/render lỗi; legacy note metadata chỉ tạo trong transaction ghi. Render lại Tags/Deck theo từng deck, từ chối thay đổi sinh/xóa card; không tự khôi phục card đã xóa. Chưa có undo batch; undo review cũ bị chặn nếu có tag mutation liên quan.
- Đổi truy vấn/trang xóa lựa chọn; kết quả request cũ không ghi đè request mới. Batch xong tải lại đúng truy vấn/trang đã áp dụng, không dùng nội dung tìm kiếm đang gõ dở.
- Editor Basic trong Browser gửi expected_version và từ chối ghi đè bản sửa từ tab cũ; tải lại version thật sau save. Caller API cũ không gửi version vẫn giữ contract trước đây. Note custom/rendered dùng liên kết sang note/deck editor hiện có.
- Bổ sung tìm field bằng tên (`Front:dog` khớp cả field, `Front:*dog*` chứa từ, `Back:` tìm rỗng) và `flag:0..7`; Browser có gắn/xóa cờ hàng loạt, giữ bit metadata khác và version guard. Field search hiện đối chiếu HTML nguồn, chưa chuẩn hóa HTML như native.
- **Chưa hỗ trợ:** regex/rated/added, các thuộc tính khác; chưa cam kết HTML normalization, Unicode case folding mọi trường hợp giống Anki. Chưa có batch delete/reset/reschedule, undo batch tổng quát.
- Cú pháp tham chiếu: [Anki Searching](https://docs.ankiweb.net/manual/searching). Test native chỉ chứng minh các fixture đã đối chiếu, không xác nhận toàn bộ search grammar.

### Custom Study và thống kê (2026-10-23)

- Tạo phiên từ Browser search, giới hạn số thẻ và thứ tự; rebuild/empty/delete. Giữ nguyên home deck và loại thẻ trong phiên khỏi queue thường.
- Preview có bốn mức Again/Hard/Good/Easy, delay cấu hình và Undo; không ghi review history hoặc đổi lịch học. Chế độ reschedule dùng scheduler thật, có Undo khôi phục cả membership.
- Version phiên/card chặn tab cũ; rebuild/empty làm mất hiệu lực request cũ. Undo không phục hồi phiên đã bị sửa hoặc xóa. Ôn sớm SM-2 đối chiếu với native Anki ở các fixture riêng.
- UI có phím Space/1–4/R, chờ thẻ tới hạn, reload tường minh sau xung đột. Truy vấn trống giữ ý nghĩa tất cả thẻ đủ điều kiện.
- Stats lấy dữ liệu thật: trạng thái card, số note, thời gian ôn, lịch sử theo ngày, khoảng interval, forecast lịch hiện tại, recall của review có nguồn trạng thái xác định. Hỗ trợ collection/subtree và 7/30/90/365 ngày, cutoff/timezone theo home deck.
- Có sửa định nghĩa phiên với Save & Rebuild atomic. Giới hạn: một bộ lọc/5 thứ tự, chưa đủ menu Custom Study/preset như Anki; chưa export định nghĩa phiên. Custom Study chưa có toàn bộ audio tự động/timer của màn học thường. Forecast không dự đoán câu trả lời tương lai; stats chưa đủ mọi biểu đồ Anki.

### Giao diện và cộng tác AGY

- Gemini 3.8 Flash High qua AGY làm Add/Edit note, Options controls/preset manager và khung study/audio/timer.
- Codex làm backend/data/format/scheduler/queue/concurrency/undo/presets/tree; rà soát và sửa tích hợp UI, typing, validation, race khi chuyển card, CSP/media và tests.
- Options nền/panel xám, tiêu đề và field gần ảnh tham chiếu; các nhóm đã có consumer được bật. Easy Days/custom scheduling vẫn disabled, không tính là hoàn thành.
- Study: Space/Enter reveal, 1–4 rate, R audio, Ctrl+Z; phím dùng được khi focus trong iframe và không chiếm input. Timer, stop-on-answer duration, automatic reveal/answer actions, wait-for-audio và fallback khi media lỗi/stall.
- Preset/override nâng cao nằm trong disclosure để giữ trang Options chính gọn. Override có nút Apply riêng; main Save lưu base settings.
- **Claude Sonnet 4.6 qua AGY đã phản biện phần text import/export mới**, conversation `f45bc25f-fa52-4586-9b18-6d551a9a31fb`. Lượt đầu nêu 3 nghi vấn; Codex bổ sung test tái hiện và phản biện từng điểm. Claude chạy lại 22 test mixed import, xác nhận cả 3 là false positive và rút lại; chưa tìm thấy lỗi cụ thể trong 5 file được review. Đây là review text transfer, không phải xác nhận toàn bộ ứng dụng.
- Browser: Gemini Flash qua AGY tạo UI ban đầu và 6 test; Codex sửa tích hợp/race/version, bổ sung move/phân trang và 5 test an toàn. Claude Sonnet 4.6 qua AGY review backend search/batch/property, edit-version/move và UI/pagination trong conversation `d0ad3cc2-4026-4099-b2d2-76ac8dd2c940`; chạy các test tập trung, chưa tìm thấy bug cụ thể trong phạm vi này. Lượt đầu bị ngắt/review timeout đã được tiếp tục; không tính lượt timeout là hoàn tất review.
- Bulk tags: Gemini làm UI/tests và test APKG native, Codex làm transaction/sibling version/render/undo regression. Claude Sonnet 4.6 qua AGY phản biện trong conversation `2712b3fa-a053-4ab7-842f-64aac3061f2e`; sau đối chiếu code hiện tại, contract và test native, rút lại 3 nghi vấn, chạy 15 test và không còn lỗi cụ thể trong phạm vi này.
- Editor async: Gemini viết bản sửa ban đầu và 6 test race; lượt sửa tiếp timeout chưa ghi thay đổi. Codex hoàn thiện list refresh theo context hiện tại và tag dấu phẩy, bổ sung 3 regression tests. Claude conversation `9369b21b-ddf5-4f8f-99a1-b755611a1a33` chạy 27 test tập trung pass nhưng bị quota 429 trước khi kết luận review. **Phản biện Claude cho editor chưa hoàn tất** do quota; sau đó người dùng chuyển sang Codex tự rà soát và sửa. Không coi kết quả test là kết luận review của Claude.
- Codex đồng thời sửa hai trường hợp biên: tên và numeric ID của cùng note type phải về cùng nhóm để chặn cập nhật cùng note hai lần; #notetype cố định không được âm thầm ghi đè loại note người dùng chọn.
- Claude Sonnet 4.6 qua AGY đã review fuzz, giữ learning steps và thứ tự preview/apply/undo; chạy 30 test trong phạm vi review, không tìm thấy lỗi correctness cụ thể. Conversation `d136395b-e143-4473-b49e-c97f11f748b4`. Đây không phải audit toàn bộ scheduler. Gemini Flash khởi tạo trường cấu hình UI rồi timeout; Codex hoàn thiện control và kiểm thử.

- Theo yêu cầu mới nhất, dừng mọi công việc AGY/Gemini; Codex trực tiếp rà soát, sửa và kiểm thử các phần được bàn giao. Chi tiết: `RA_SOAT_CODE_GEMINI.md`.

## Kiểm chứng

- Backend: **313 test pass**. Frontend: **147 test pass**, build pass, oxlint không cảnh báo ở lần kiểm tra gần nhất.
- Có test dùng backend Anki 26.9.3 thật để mở APKG legacy/modern, đọc fields/GUID/tags/deck/card count và FSRS memory; gói xuất rồi nhập lại vào web không tạo card trùng trong fixtures. Có tests media Unicode/entities/fonts, real duration/suspended due, COLPKG empty decks/unused types/shared presets.
- Native Anki 26.9.3: đối chiếu biên fuzz, stability/difficulty và learning delays cho card mới và review card mẫu; chưa phủ mọi trạng thái/chuỗi review.
- Native Anki 26.9.3 xác nhận CSV/TXT hai chiều: Basic/reversed/Cloze, mixed note types, nhiều deck, GUID/tags/source fields. Test rollback lỗi giữa các nhóm, legacy preview không backfill, và export subtree với ký tự SQL wildcard trong tên deck.
- Firefox kiểm tra text import nâng cao: Cloze mapping, Tab thật, preview không ghi, thay input vô hiệu preview, giữ Extra/tags; mixed preview không tạo deck, liệt kê parent, confirm tạo đúng hierarchy, export cây deck có metadata.
- Firefox **158.0.1 headless** chạy với DB/media tạm riêng: cloze/CSS, script isolation, không có media HTML trùng ngoài iframe, Space trong iframe, rating/sibling bury, Ctrl+Z, FSRS Options, audio preference/R playback, timer, create/bind preset, Today only=0/clear, không lẫn override vào base, auto reveal+Good review.
- Browser mới: native Anki đối chiếu 17 truy vấn text/deck/tag/note và 8 truy vấn property; kiểm tra isolation, rollback batch, stale edit, chuyển deck giữ note/lịch và đọc qua mốc 1.000 card.
- Firefox smoke Browser trên 1.003 card tạm: search/phủ định, suspend đúng selection, refresh/clear selection, lỗi cú pháp, chặn stale edit, reload/save, move giữ note/bury, phân trang và cap 500. Screenshot `/home/bluenip/.cache/anki-browser-check/browser-search-firefox.png`.
- Bulk tags: native Anki xác nhận add/remove theo hierarchy; APKG modern sau batch sửa tag tiếng Việt/dấu phẩy giữ 1 note/2 card, GUID/fields/tags khi mở bằng Anki thật. Firefox xác nhận cảnh báo phạm vi note, sibling khác deck tăng version, xóa tag cha, chặn request stale và giữ input lỗi, tìm tag trên mọi sibling, bảng mobile còn hiển thị; mở editor rồi lưu giữ nguyên tag dấu phẩy (13 kiểm tra Firefox pass, gồm stale note/reload). Screenshot `/home/bluenip/.cache/anki-browser-check/bulk-tags-mobile-firefox.png`.
- Browser viewport mobile phát hiện bảng bị co về 0px do max-height cũ; đã sửa để bảng có vùng cuộn riêng (đo lại cao 306px). Screenshot `/home/bluenip/.cache/anki-browser-check/browser-search-mobile-firefox.png`.
- Browser smoke đã bắt và sửa lỗi CSP `'self'` của sandboxed srcdoc chặn media local trong Firefox. Screenshot: `/home/bluenip/.cache/anki-browser-check/options-firefox.png`.
- Test fixture fingerprint DB/media nguồn trước/sau; không chạy migration/backfill/reschedule trên dữ liệu thật, không commit/deploy. Chưa xác minh Docker deployment, thiết bị mobile thật, Safari/Chromium hoặc Anki Desktop GUI. Browser đã smoke thêm viewport mobile 390×844 trên Firefox desktop; không coi đây là test thiết bị thật.

- Firefox Custom Study/Stats: 15 kiểm tra pass, gồm bốn mức preview, delay, không thay lịch/history, Undo hai chế độ, Empty, giữ home deck, chặn phiên stale/reload, range thống kê và mobile không tràn trang.
- Note concurrency có test hai kết nối SQLite đồng thời: một save thành công, một trả 409; test sibling khác deck giữ ngữ cảnh render đúng.

- Bổ sung Firefox: tạo/preview note type, chọn custom type trong Add, gõ đáp án/Enter/so sánh, render math trong iframe, upload multipart qua giao diện Add/check media và editor mobile. Custom Study sửa phiên qua UI đã chạy thành công.
- Backend mới có tests rollback toàn bộ note type khi một note lỗi, media content addressing/isolation, template filters, filtered edit rollback/stale và optimizer native. Toàn bộ backend ở lượt cuối: 313 test pass.

## Backfill card cũ

`backend/backfill_notes.py` mặc định dry-run. Khi chủ động áp dụng cần dừng app, sao lưu cả DB và media. Apply tạo backup SQLite trước khi thêm metadata, chạy lại không nhân đôi GUID.

```bash
cd backend
python backfill_notes.py --database /duong/dan/anki.db
python backfill_notes.py --database /duong/dan/anki.db --apply
```

Startup `create_all` chỉ tạo bảng bổ sung; không backfill/reschedule card cũ tự động.

## Các phần chưa hoàn thành

1. Các tùy chọn duplicate/match scope còn lại của text import; mapping đổi tên field/xóa template đang dùng, editor WYSIWYG, diff đáp án từng ký tự, TTS/LaTeX đầy đủ, nested cloze và image occlusion. Editor template/media/typed answer/ruby và subset math đã có như mô tả trên.
2. Phủ fixture APKG/COLPKG thực tế lớn và các phiên bản khác; cấu hình/clock/global preferences đầy đủ, media conflict remapping, backup/restore vào collection có sẵn với preview/backup trước thay thế.
3. Easy Days/load balancing, mở rộng optimizer cho history nhập và đánh giá chất lượng; mở rộng golden fixtures scheduler/queue. Fuzz FSRS đã có nhưng seed khác native Anki; chưa có fuzz cho nhánh SM-2.
4. Mở rộng Browser search ngoài subset đã hỗ trợ, batch delete/reset/reschedule, Custom Study presets/hai bộ lọc và xuất định nghĩa phiên, undo thao tác hàng loạt, stats nâng cao và integrity/media UI.
5. Offline/PWA, multi-device sync/conflicts và các compatibility nâng cao đã ghi trong đề xuất.

Không dùng test/build pass làm bằng chứng rằng các mục còn lại đã được thực hiện.
