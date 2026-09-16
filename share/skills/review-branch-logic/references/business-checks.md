# Gợi ý phân tích theo loại thay đổi

Chỉ đọc các nhóm tương ứng với code đang thay đổi. Đây là câu hỏi để tìm bằng chứng, không phải danh sách yêu cầu nghiệp vụ bắt buộc. Không tự đặt ngưỡng, cơ chế hay quy tắc chưa có nguồn. Luôn kiểm tra lớp bảo vệ ở caller, server, database hoặc hệ thống tích hợp trước khi kết luận thiếu.

## Điều kiện và ràng buộc nghiệp vụ

- Thay `AND/OR`, đảo phủ định hoặc thứ tự guard có mở/đóng sai một nhóm đầu vào hợp lệ không?
- `<` và `<=`, rỗng và không truyền, `0` và `null`, trạng thái mặc định có mang ý nghĩa khác nhau theo contract không?
- Thêm trạng thái/loại nghiệp vụ mới có bị rơi vào nhánh mặc định sai tại các consumer không?
- Guard bị xóa có thực sự được chuyển sang lớp khác hay đường gọi nào đó mất bảo vệ?

## Chuyển trạng thái và vòng đời

- Một hành động có thể chuyển từ trạng thái nào sang trạng thái nào? Điều kiện xét trước khi ghi còn đúng tại thời điểm ghi không?
- Hủy, hoàn tác, mở lại hoặc xử lý lỗi có cập nhật đồng bộ dữ liệu phụ thuộc và side effect không?
- Gọi lại cùng hành động có làm tăng/giảm số lượng, cộng/trừ tiền hoặc gửi thông báo thêm lần nữa không? Contract có cho phép gọi lặp không?
- Trạng thái kết thúc có thể bị callback chậm hoặc response cũ ghi đè không?

## Dữ liệu, số lượng và phép tính

- Mapping giữa form/request/domain/DB/response có đổi đơn vị, ID hoặc ý nghĩa trường không?
- Partial update phân biệt “không truyền” với “xóa giá trị” như thế nào? Default mới có ghi đè dữ liệu cũ hợp lệ không?
- Tổng, phần còn lại, giới hạn, dấu âm, độ chính xác, quy tắc làm tròn và thứ tự áp dụng giảm giá/phí có đúng nguồn nghiệp vụ không?
- Schema/migration có xử lý bản ghi cũ, `null`, giá trị enum cũ hoặc giai đoạn các phiên bản cùng tồn tại nếu dự án hỗ trợ không?
- Truy vấn join/filter/pagination/sort mới có mất/trùng bản ghi hay làm tổng và danh sách lệch nhau không? Chỉ kết luận với dữ liệu/tình huống cụ thể.

## Thời gian

- Quy tắc dùng ngày nghiệp vụ hay thời điểm tuyệt đối? Parse/format có làm đổi timezone hoặc ranh giới đầu/cuối ngày không?
- Thay cách so sánh ngày hết hạn có loại nhầm dữ liệu đúng tại biên không?
- Chỉ xét DST, lịch đặc biệt hoặc timezone khác khi cấu hình/contract thực tế hỗ trợ các trường hợp đó.

## Đồng thời, transaction và xử lý lặp

- Có thao tác đọc → kiểm tra → ghi trên cùng tài nguyên mà nhiều request được phép thực hiện đồng thời không? Constraint/lock/cập nhật có điều kiện đã bảo vệ chưa?
- Việc ghi nhiều bảng hoặc thay đổi trạng thái và phát sự kiện có thể chỉ hoàn thành một phần ở đường lỗi đã xác định không?
- Retry sau timeout có biết lần trước đã tạo side effect chưa? Idempotency key có scope và thời hạn phù hợp contract không?
- Nếu nghi race condition, viết thứ tự `A đọc → B đọc → A ghi → B ghi`, rồi đối chiếu transaction isolation, khóa và constraint thực tế; thiếu các dữ kiện này thì nêu câu hỏi thay vì khẳng định.

## Quyền và phạm vi dữ liệu

- Thao tác có kiểm tra actor được phép hành động trên đúng tài nguyên, trạng thái và tenant/owner không?
- Predicate giới hạn dữ liệu có bị rơi khỏi một truy vấn, đường bulk/export hoặc nhánh cập nhật mới không?
- Chặn nút trên UI có đi kèm bảo vệ server nếu endpoint cho phép gọi trực tiếp? Đọc middleware/handler trước khi nói thiếu.
- ID do client gửi có thay thế nhầm danh tính đã xác thực hoặc cho phép cập nhật trường nhạy cảm không?

## Hợp đồng API và tích hợp

- Thay request/response, mã lỗi, enum, format hoặc trường tùy chọn có làm consumer hiện hữu hiểu sai không?
- Producer và consumer có cập nhật cùng nhau? Thứ tự xử lý, phân trang hoặc giá trị mặc định mới có phá giả định đã có căn cứ không?
- Timeout/lỗi một phần có bị coi là thành công, bị nuốt hoặc tự retry một thao tác có side effect không?
- Khi nói “không tương thích”, phải chỉ ra consumer/version còn được hỗ trợ. Không tự yêu cầu hỗ trợ mọi client cũ.

## UI có ảnh hưởng nghiệp vụ

- Form đổi record/route/filter có giữ nhầm giá trị, quyền, selection hoặc dữ liệu đang tải của record trước không?
- Response cũ có thể đến sau response mới và ghi đè dữ liệu đang hiển thị/lưu không? Nêu thứ tự và điều kiện cụ thể.
- Optimistic update, submit lặp và xử lý thất bại có để trạng thái UI lệch dữ liệu server hoặc làm người dùng thao tác trên đối tượng sai không?
- Giá trị hiển thị và payload lưu có nhất quán với lựa chọn thực tế không? Không chuyển review này thành review màu sắc/layout.

## Hồi quy giữa các thành phần

- Hàm dùng chung thay đổi ngữ nghĩa có caller nào vẫn dùng giả định cũ không?
- Logic bị di chuyển có giữ thứ tự validation, tính toán, ghi dữ liệu và phát side effect không?
- Config/feature flag có tạo đường đi dùng đồng thời cấu trúc cũ/mới mà code không xử lý không?
- Với hai hunk riêng lẻ hợp lý, kiểm tra kết hợp của chúng trên cùng luồng trước khi kết luận.
