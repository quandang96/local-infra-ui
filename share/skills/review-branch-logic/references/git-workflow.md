# Lấy đúng diff và context của hai branch

## Quy tắc sử dụng lệnh

Đây là các mẫu lệnh **chỉ đọc**, không phải script để chạy nguyên khối. Chọn lệnh cần thiết và tuân theo wrapper trong hướng dẫn môi trường. Nếu môi trường yêu cầu RTK, dùng `rtk proxy git ...` cho diff/show/grep cần giữ nguyên dòng và nội dung; tránh output bị rút gọn làm mất bằng chứng.

Trong ví dụ, `$REVIEW_BASE_REF`, `$REVIEW_HEAD_REF`, `$REVIEW_BASE_SHA`, `$REVIEW_HEAD_SHA`, `$REVIEW_COMPARE_SHA`, `$REVIEW_PATH` là giá trị đã xác định, không phải tên branch mặc định. Truyền từng giá trị thành một argument được quote, không nội suy đầu vào người dùng thành shell code, không dùng `eval`. Dùng SHA đã resolve cho các lệnh đọc sau đó.

## Xác định repository và ref

```bash
git rev-parse --show-toplevel
git --no-optional-locks status --short
git rev-parse --is-shallow-repository
git show-ref --heads
git for-each-ref --format='%(refname)' refs/remotes/
git rev-parse --verify --end-of-options "${REVIEW_BASE_REF}^{commit}"
git rev-parse --verify --end-of-options "${REVIEW_HEAD_REF}^{commit}"
```

Chỉ dùng danh sách ref khi cần làm rõ tên. Ưu tiên ref branch đầy đủ, ví dụ `refs/heads/develop` hoặc `refs/remotes/origin/develop`, sau khi xác định đúng đầu vào. Nếu tên trùng tag/branch hoặc có nhiều lựa chọn remote, làm rõ thay vì chọn ngẫu nhiên. Nếu người dùng chọn `origin/develop`, review đúng remote-tracking ref đang có ở local; không khẳng định đó là trạng thái mới nhất trên server.

Working tree bẩn không cản review branch: giữ nguyên mọi thay đổi và đọc snapshot Git. Không checkout, stash, tạo worktree hoặc cập nhật index để phục vụ review này.

Nếu ref không có ở local, nêu ref thiếu và lựa chọn cần thiết. Không tự thay bằng branch cùng tên trên remote. Chỉ fetch khi người dùng yêu cầu/đã cho phép lấy branch; không pull, merge hoặc fetch tất cả remote. Khi chưa được phép, tiếp tục phần đọc độc lập có ý nghĩa và ghi giới hạn. Nếu chưa có diff hợp lệ, ghi BLOCKED cho phần review diff.

## Chọn baseline

```bash
git merge-base --all "$REVIEW_BASE_SHA" "$REVIEW_HEAD_SHA"
```

- **Một merge base:** mode mặc định; dùng commit đó làm `REVIEW_COMPARE_SHA`.
- **Không có merge base:** kiểm tra lịch sử nông/missing objects hoặc hai lịch sử độc lập. Yêu cầu bổ sung lịch sử hoặc xác định cách so sánh; không đổi sang diff hai tip để che thiếu dữ liệu.
- **Nhiều merge base:** không tự chọn dòng đầu; cần baseline/mode cụ thể trước khi chốt diff.
- **Người dùng chọn diff hai tip:** `REVIEW_COMPARE_SHA = REVIEW_BASE_SHA`; không cần merge base.

Ghi cả ref đầu vào lẫn SHA thực sự dùng. Giữ các SHA cố định suốt review, kể cả branch ref di chuyển giữa chừng. Diff mặc định tương đương `git diff base...head` khi merge base duy nhất; không dùng `git diff base..head` thay thế vì nó so sánh hai tip. Diff merge-base không mô phỏng kết quả merge vào base hiện tại. Nếu phát hiện tương tác riêng với thay đổi mới trên base, ghi rõ đó là ngữ cảnh tích hợp bổ sung; không trộn revision vào bằng chứng trước/sau.

## Đọc danh sách và hunk

```bash
git --no-pager diff --no-ext-diff --no-textconv --no-color --find-renames --name-status "$REVIEW_COMPARE_SHA" "$REVIEW_HEAD_SHA" --
git --no-pager diff --no-ext-diff --no-textconv --no-color --find-renames --stat "$REVIEW_COMPARE_SHA" "$REVIEW_HEAD_SHA" --
git --no-pager diff --no-ext-diff --no-textconv --no-color --find-renames --unified=40 "$REVIEW_COMPARE_SHA" "$REVIEW_HEAD_SHA" -- ":(literal)$REVIEW_PATH"
```

`--name-status` dùng để theo dõi mọi file, `--stat` chỉ là tổng quan. Đọc từng file/nhóm khi output lớn; tăng context có chọn lọc, không kết luận từ diff bị truncate. Với rename, đọc cả đường dẫn cũ và mới, cùng chỗ gọi/import bị ảnh hưởng. Không bật chế độ bỏ qua whitespace cho lượt đọc duy nhất vì whitespace có thể ảnh hưởng hành vi.

File generated, lockfile, binary, submodule không tự là N/A. Xác định tác động đến luồng đang review; đọc nguồn/schema/version liên quan nếu cần. Nếu không đọc được phần có ảnh hưởng, ghi chưa xác minh thay vì giả định an toàn.

## Đọc context ở đúng revision

```bash
git --no-pager show --no-ext-diff --no-textconv --format= "${REVIEW_HEAD_SHA}:${REVIEW_PATH}"
git --no-pager show --no-ext-diff --no-textconv --format= "${REVIEW_COMPARE_SHA}:${REVIEW_PATH}"
git grep -n -F -e 'changedSymbol' "$REVIEW_HEAD_SHA" -- src/
git ls-tree -r --name-only "$REVIEW_HEAD_SHA" --
```

Thay scope `src/` bằng thư mục có thật và hữu ích trong repo. Chọn path cũ khi đọc file rename ở bản trước; file thêm mới không có bản cũ, file xóa không có bản mới. Khi cần đánh số dòng, dùng công cụ đánh số trên nội dung blob nguyên vẹn; dòng báo cáo bắt đầu từ 1.

Chỉ dùng tìm kiếm trên working tree hoặc công cụ semantic gắn working tree khi đã xác nhận file liên quan khớp snapshot. HEAD hiện tại có thể khác branch được review; Serena có thể trả số dòng tính từ 0. Không lấy các vị trí đó gán trực tiếp cho `HEAD_SHA`.

Nếu diff rỗng, báo không có thay đổi trong mode/phạm vi đã chọn; không tạo finding từ lỗi có sẵn. Nếu người dùng đưa patch sẵn, dùng metadata thật trong patch, nêu phần context thiếu và không bịa SHA/merge base.
