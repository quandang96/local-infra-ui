---
name: review-branch-logic
description: "Review lỗi logic, nghiệp vụ và hồi quy trong diff giữa hai Git branch do người dùng cung cấp. Dùng khi cần review base/head với vị trí, tình huống gây lỗi, bằng chứng và cách sửa cụ thể bằng tiếng Việt; chỉ phân tích tĩnh, không chạy test, type check hoặc lint. Không dùng cho yêu cầu chỉ kiểm tra style hay tự triển khai sửa code."
---

# Review logic và nghiệp vụ giữa hai branch

Tìm lỗi có thể xảy ra trong luồng thực tế do thay đổi được review gây ra. Kết quả phải giúp tác giả hiểu **lỗi nằm ở đâu, điều kiện nào gây lỗi, tác động gì và nên sửa thế nào**. Một review không có finding hợp lệ vẫn là kết quả đúng.

## Hợp đồng review

- Chỉ đọc code, diff và tài liệu. Không tự sửa code, chuyển branch, stash, merge, reset, commit hoặc đăng nhận xét lên dịch vụ bên ngoài.
- Không chạy test, type check, lint, build, ứng dụng, migration, cài dependency hoặc script dự án để kiểm chứng. Được dùng Git và công cụ đọc/tìm kiếm; được đọc test có sẵn để hiểu hành vi, không xem việc đọc là đã chạy test.
- Ưu tiên sai kết quả nghiệp vụ, dữ liệu sai/mất/trùng, chuyển trạng thái sai, quyền thao tác, hợp đồng API và hồi quy giữa các thành phần. Lỗi runtime thấy rõ bằng phân tích tĩnh thuộc phạm vi.
- Không tạo finding chỉ vì style, naming, thiếu comment/test, đề xuất refactor hoặc cảnh báo type/lint chưa gắn được với sai hành vi. Một biểu hiện như biến có thể null chỉ thành finding khi chỉ ra đường đi thực tế dẫn đến sai hành vi/crash; không bỏ qua bug có tác động chỉ vì checker cũng có thể phát hiện nó.
- Chỉ kết luận về snapshot và phạm vi đã đọc. Không tự duyệt merge, đảm bảo không còn bug hoặc tuyên bố test pass.
- Viết báo cáo bằng tiếng Việt; giữ tên hàm, trường dữ liệu, trạng thái và thuật ngữ nghiệp vụ gốc. Không tự dịch tên theo cách đổi điều kiện nghiệp vụ.

## 1. Xác định đầu vào và snapshot

Đầu vào tối thiểu: repository, `base` (branch đích/gốc) và `head` (branch chứa thay đổi). Dùng repository hiện tại nếu rõ ràng; không mặc định `main`, `develop` hay `HEAD` cho branch còn thiếu. Nếu người dùng chỉ đưa hai tên mà không nêu chiều, hỏi một câu để xác định branch chứa thay đổi. Chưa có hai branch thì thu thập thông tin, không tự chạy một review khác.

Requirement, acceptance criteria, mô tả thay đổi, DD/API/data contract và giới hạn thư mục là đầu vào bổ sung. Không bắt buộc tài liệu nghiệp vụ nếu lỗi nội tại đã có đủ bằng chứng trong code.

Đọc [quy trình Git](references/git-workflow.md) khi lấy diff từ repository:

1. Resolve đúng hai ref người dùng chọn, ghim `BASE_SHA`, `HEAD_SHA`.
2. Mặc định review thay đổi trên `head` từ merge base duy nhất: `COMPARE_SHA = merge-base(BASE_SHA, HEAD_SHA)`. Đây là diff của phần phát triển trên branch, không phải chênh lệch hai tip hay kết quả mô phỏng merge.
3. Nếu người dùng yêu cầu rõ so sánh hai tip, dùng `COMPARE_SHA = BASE_SHA` và ghi chế độ này.
4. Đọc diff `COMPARE_SHA → HEAD_SHA`. Mọi context trước/sau phải thuộc đúng hai snapshot. Không trộn file đang sửa trong working tree vào review hai branch.

Ghi lại mode, SHA và phạm vi. Không tự fetch hoặc thay local branch bằng remote branch có cùng tên. Ref thiếu, lịch sử nông hoặc nhiều merge base cần được làm rõ; không âm thầm đổi kiểu diff.

## 2. Lập bản đồ thay đổi và chuẩn nghiệp vụ

Đọc danh sách file cùng toàn bộ hunk trong phạm vi, bao gồm phần xóa, đổi tên, config/schema/migration có ảnh hưởng hành vi. Với diff lớn, chia theo luồng chức năng, giữ danh sách đã đọc/chưa đọc và tiếp tục cho đến hết phần truy cập được. Không dừng sau lỗi đầu tiên; không coi output bị cắt là toàn bộ diff.

Với mỗi nhóm thay đổi, xác định:

- Entry point, người thực hiện, dữ liệu/trạng thái đầu vào.
- Điều kiện/ràng buộc nghiệp vụ cần giữ và nguồn của điều kiện đó.
- Hành vi trước/sau, kết quả trả về, dữ liệu ghi, side effect và bên tiêu thụ.

Requirement được người dùng xác nhận là chuẩn nghiệp vụ; contract/DD đã duyệt là chuẩn kỹ thuật. Code cũ, test và cách gọi hiện tại là bằng chứng về hành vi, không tự chứng minh hành vi đó đúng hoặc phải giữ mãi. Mô tả thay đổi giúp xác định chủ ý; việc đổi hành vi có chủ ý không tự là bug. Nguồn mâu thuẫn/nháp phải được nêu rõ, không tự chọn một bên làm chuẩn đã xác nhận.

Không bịa quy tắc như phải làm tròn theo cách nào, ai được hủy đơn, có cho phép vượt tồn kho hay không. Khi thiếu chuẩn, chỉ báo lỗi nội tại có thể chứng minh hoặc đưa một câu hỏi cụ thể vào phần cần làm rõ.

## 3. Lần theo luồng bị ảnh hưởng

Đọc phần xung quanh hunk, caller/callee, validation, truy vấn, schema/constraint và consumer cần thiết ở đúng revision. Đi theo dữ liệu từ đầu vào đến nơi sử dụng/lưu trữ; mở rộng sang code không đổi khi cần để chứng minh tác động của diff. Dừng mở rộng khi đã xác định được đường đi và các lớp bảo vệ liên quan.

Chọn các nhóm phù hợp từ [gợi ý phân tích nghiệp vụ](references/business-checks.md). Ưu tiên tình huống biên, luồng thất bại và tương tác giữa nhiều hunk; không áp mọi mục cho mọi thay đổi.

Với mỗi nghi vấn, lập một tình huống tối thiểu bằng suy luận:

`Trạng thái/dữ liệu hợp lệ → hành động hoặc thứ tự sự kiện → nhánh code thay đổi → kết quả thực tế → kết quả có căn cứ phải đạt`.

Đối chiếu cùng tình huống ở bản trước. Kiểm tra guard, middleware, transaction, unique constraint, cơ chế retry hoặc caller có chặn tình huống hay không trước khi báo lỗi. Đối với race condition, mô tả thứ tự xen kẽ khả thi; đối với lỗi API, đọc cả producer và consumer nếu có. Một giải pháp tốt cần sửa tại lớp thực sự giữ ràng buộc, không chỉ che triệu chứng ở UI.

Đây là phân tích tĩnh. Không tạo/chạy chương trình thử nghiệm để xác nhận tình huống.

## 4. Chốt finding bằng bằng chứng

Chỉ đưa vào danh sách lỗi khi đủ các yếu tố:

1. Có vị trí thêm/sửa/xóa cụ thể trong diff gây ra hoặc làm mở rộng lỗi.
2. Có đầu vào/trạng thái/thứ tự sự kiện khả thi được code hoặc contract hỗ trợ.
3. Có chuỗi nguyên nhân → sai hành vi → tác động rõ; đã kiểm tra lớp bảo vệ liên quan.
4. Có căn cứ cho hành vi kỳ vọng và có thể đề xuất hướng sửa khả thi.

Nếu còn thiếu dữ kiện quyết định, chuyển sang **Cần làm rõ**, nêu dữ kiện thiếu và nó ảnh hưởng kết luận thế nào. Không dùng “có thể lỗi” kèm mức độ nghiêm trọng để biến suy đoán thành finding. Điều kiện hiếm nhưng đã được chứng minh vẫn có thể là bug; không cần tái hiện runtime để ghi nhận bằng chứng tĩnh.

Không báo lại lỗi đã tồn tại và không bị thay đổi làm nặng hơn. Nếu diff mở một đường đi mới vào lỗi cũ hoặc tăng phạm vi ảnh hưởng, chỉ rõ thay đổi nào làm điều đó. Gộp các biểu hiện cùng nguyên nhân và cùng cách sửa; giữ riêng lỗi có trigger hoặc cách xử lý khác nhau.

Mức độ theo tác động có bằng chứng, không theo độ tự tin:

| Mức | Ý nghĩa |
| --- | --- |
| P0 | Sự cố nghiêm trọng diện rộng, mất dữ liệu lớn hoặc luồng cốt lõi chắc chắn hỏng; chỉ dùng khi bằng chứng đủ rõ. |
| P1 | Lỗi nghiêm trọng cần ưu tiên sửa: kết quả giao dịch sai, vượt quyền, mất dữ liệu hoặc luồng chính bị chặn trong tình huống đã xác định. |
| P2 | Lỗi chức năng có tác động hữu hạn, vẫn cần sửa. |
| P3 | Lỗi hành vi nhỏ có tác động cụ thể; không dùng cho góp ý phong cách. |

## 5. Xuất kết quả có thể sửa được

Dùng [mẫu báo cáo](references/report-format.md). Mỗi finding phải có:

- **Vị trí:** đường dẫn, dòng tính từ 1 và revision; ưu tiên khoảng ngắn giao với hunk gây lỗi. Với code bị xóa, dùng dòng phía `COMPARE_SHA`, ghi rõ phía cũ; không gán số dòng cũ cho `head`.
- **Vấn đề và nguyên nhân:** thay đổi nào phá điều kiện nào, cùng bằng chứng code/contract liên quan.
- **Tình huống:** trạng thái đầu vào và các bước/điều kiện gây lỗi; thực tế khác kỳ vọng ra sao.
- **Tác động:** chức năng, người dùng hoặc dữ liệu bị ảnh hưởng.
- **Hướng sửa:** thay đổi logic cụ thể, vị trí phù hợp và ràng buộc cần giữ. Có thể dùng đoạn mã ngắn khi đủ context; không tự áp dụng bản sửa.
- **Tiêu chí sau sửa:** kết quả cần đúng cho tình huống trên, dưới dạng mô tả; không phải test đã chạy.

Không dùng hướng sửa chung chung như “thêm validation”, “handle error” hay “thêm test” làm giải pháp duy nhất. Nêu trường/điều kiện, lớp xử lý và cách giữ tương thích khi cần; không bắt tác giả viết lại kiến trúc để sửa một lỗi nhỏ.

Sắp xếp lỗi theo mức độ và ảnh hưởng. Sau findings, ghi câu hỏi còn lại và phạm vi đã đọc/chưa đọc. Ghi **COMPLETE / PARTIAL / BLOCKED** cho mức hoàn tất đọc và phân tích, tách khỏi số lỗi. Thiếu kiểm chứng runtime theo chế độ này không tự làm review thành PARTIAL; thiếu context quyết định hoặc còn file chưa đọc thì có.

Khi không có lỗi đủ bằng chứng, ghi: **“Chưa phát hiện lỗi logic/nghiệp vụ đủ bằng chứng trong phạm vi đã đọc.”** Luôn nêu: **“Review bằng phân tích tĩnh; không chạy test, type check, lint hoặc build.”** Nếu chỉ có diff được cung cấp mà không có đầy đủ context, công khai giới hạn đó.

## Cách gọi

```text
$review-branch-logic base=develop head=feature/order-cancel
```

```text
$review-branch-logic base=origin/main head=origin/feature/refund
Phạm vi: checkout và refund.
Nghiệp vụ đã xác nhận: mỗi giao dịch chỉ được hoàn tiền thành công một lần.
```

```text
$review-branch-logic base=release/1.4 head=release/1.5
So sánh trực tiếp hai tip, không dùng merge base.
```

Mặc định trả báo cáo trong hội thoại. Chỉ ghi file báo cáo khi người dùng yêu cầu, tại đường dẫn được chỉ định hoặc đã thống nhất.
