# Mẫu kết quả review

Dùng cấu trúc sau, rút gọn mục không áp dụng. Ưu tiên finding có thể sửa được, không xuất một checklist dài các mục “ổn”. Không đặt chỉ tiêu số lỗi. Chỉ tạo file báo cáo khi người dùng yêu cầu.

## Phạm vi

```text
Repository: <đường dẫn hoặc tên đã xác minh>
Base: <ref> @ <BASE_SHA>
Head: <ref> @ <HEAD_SHA>
Chế độ: từ merge base | so sánh hai tip | patch được cung cấp
So sánh: <COMPARE_SHA> → <HEAD_SHA>
Phạm vi: <toàn diff hoặc thư mục/luồng người dùng chọn>
Mức hoàn tất: COMPLETE | PARTIAL | BLOCKED
Kết quả: <số lỗi có bằng chứng theo mức độ; không cộng câu hỏi vào số lỗi>
```

Chỉ hiển thị metadata thực sự có. COMPLETE nghĩa đã đọc và phân tích đủ diff/context quyết định trong phạm vi; không có nghĩa đã chứng minh toàn hệ thống đúng. PARTIAL phải nêu file/luồng/context còn thiếu. BLOCKED chỉ khi chưa thể thực hiện phần review có ý nghĩa.

## Lỗi phát hiện

```markdown
### F01 — [P1] <Tiêu đề nêu lỗi hoặc hành vi cần sửa>

- **Vị trí:** `path/to/file.ext:42–46` tại `<HEAD_SHA>`; hàm `<symbol>`.
- **Vấn đề:** <thay đổi cụ thể và nguyên nhân sai; giải thích hành vi trước/sau>.
- **Tình huống gây lỗi:** <đầu vào/trạng thái và hành động hoặc thứ tự sự kiện khả thi>.
- **Thực tế / kỳ vọng:** <code hiện tại tạo ra gì; đúng ra cần gì và căn cứ ở đâu>.
- **Tác động:** <người dùng, nghiệp vụ hoặc dữ liệu chịu ảnh hưởng>.
- **Bằng chứng liên quan:** <caller/guard/contract và vị trí đã đọc, nếu cần>.
- **Hướng sửa:** <sửa ở đâu, điều kiện/cập nhật nào cần đổi và vì sao giải quyết nguyên nhân>.
- **Tiêu chí sau sửa:** <kết quả phải đạt trong tình huống trên; chỉ mô tả, chưa chạy>.
```

Giữ mô tả ngắn nhưng đủ chuỗi nguyên nhân. Có thể ghép mục bằng chứng vào đoạn giải thích để tránh lặp. Nếu giải pháp phụ thuộc một lựa chọn nghiệp vụ, nêu lựa chọn cần chốt, không tự áp đặt. Không dùng bổ sung test làm hướng sửa duy nhất.

### Định vị dòng và liên kết

- Dòng tính từ 1, ưu tiên 1–5 dòng trực tiếp gây lỗi; chỉ dùng khoảng dài khi cần.
- Link local dạng `[file.ext](/absolute/path/file.ext:42)` chỉ khi file hiện tại thật sự khớp snapshot ở vị trí được dẫn. Nếu không khớp, dùng `path:line @ SHA` hoặc permalink tới commit khi đã xác minh URL; không tạo link nhìn đúng nhưng mở sai code.
- Với finding do xóa code, ghi `path:line @ COMPARE_SHA (phía cũ, đã xóa)`. Có thể bổ sung vị trí gọi còn tồn tại trên head. File rename cần ghi path đúng từng phía.
- Mỗi finding phải gắn nguyên nhân với một thay đổi trong diff. Bằng chứng phụ ở file không đổi không thay thế vị trí gây hồi quy.
- Nếu patch không có số dòng đáng tin cậy, dẫn hunk/symbol thật và nêu không xác định được dòng; không đoán số dòng.

### Ví dụ minh họa, không phải finding của repository hiện tại

Giả sử contract xác nhận `refund(requestId)` có thể được retry với cùng `requestId`, và một giao dịch chỉ được hoàn tiền một lần. Diff đã xóa nhánh trả lại kết quả đã lưu cho request trùng. Caller hiện retry khi timeout; đã đọc đủ handler và storage để xác định không có lớp khử trùng khác.

Finding phù hợp: **[P1] Khôi phục xử lý request hoàn tiền bị gửi lại**. Chỉ rõ dòng guard bị xóa phía cũ, mô tả lần gọi đầu đã ghi hoàn tiền nhưng response timeout, lần gọi sau tạo bản ghi/side effect thứ hai. Hướng sửa phải giữ một kết quả duy nhất cho cùng request và trả lại kết quả đó; nếu hai request đồng thời được phép đến, cơ chế ghi phải xử lý xung đột một cách nguyên tử theo storage hiện có. Tiêu chí sau sửa: cùng request được gọi lại không tăng tổng tiền đã hoàn.

Chỉ thấy thiếu guard trong diff mà chưa đọc handler/storage thì chưa đủ cho finding này. Thiếu thông tin phải thành câu hỏi về lớp xử lý idempotency, không khẳng định hệ thống hoàn tiền hai lần.

## Cần làm rõ

Chỉ liệt kê câu hỏi ảnh hưởng tính đúng hoặc cách sửa:

```text
Q01 — <file/hàm/luồng>: chưa rõ <quy tắc hoặc context>.
Cần: <nguồn/đoạn code/quyết định cụ thể>.
Ảnh hưởng: <kết luận nào sẽ khác tùy câu trả lời>.
```

Không gán P0–P3 cho câu hỏi, không cộng nó vào số lỗi. Nếu không còn câu hỏi, bỏ mục này.

## Phạm vi đã đọc và giới hạn

- Liệt kê gọn nhóm file/luồng đã review; dùng số lượng chỉ khi đã đếm.
- Nêu file/luồng chưa đọc, context thiếu hoặc phạm vi bị loại theo yêu cầu; đừng trình bày “chưa đọc” như “không có”.
- Khi không có finding hợp lệ: **Chưa phát hiện lỗi logic/nghiệp vụ đủ bằng chứng trong phạm vi đã đọc.**
- Kết thúc bằng: **Review bằng phân tích tĩnh; không chạy test, type check, lint hoặc build.**

Không ghi “an toàn để merge”, “không có bug” hoặc “test pass” từ việc đọc code.
