# Local Infra Control Center

Web UI nội bộ để vận hành một Docker Compose project trong Coder hoặc môi trường local. Control Center hiển thị trạng thái service, chạy lifecycle Compose, xem log, lưu lịch sử task và cung cấp công cụ cho MySQL/Redash, Datastore, Kafka, Spanner, Keycloak, MailHog, BigQuery, Docker và application service.

Project có thể dùng nguyên trạng với stack mẫu `local-infra` hoặc trỏ tới Compose project khác bằng cấu hình môi trường — không cần sửa mã nguồn cho các service Compose thông thường.

## Chức năng

- Overview trạng thái Docker, tài nguyên và các service/tool đã cấu hình.
- Start, stop, restart service Compose; Start all, Stop all và Restart unhealthy.
- Trang generic cho service Compose tùy biến: trạng thái, lifecycle và stream log.
- App Services: tạo, sửa, chạy và dừng process Go, Node hoặc Vue trong workspace.
- Docker Tools chỉ chạy catalog lệnh Docker đã duyệt.
- Spanner explorer: mở/thu gọn cột theo table, query read-only, chạy phần SQL đang chọn và lưu/mở lại SQL.
- Nhúng Keycloak Admin Console và MailHog Inbox qua reverse proxy cùng origin.
- BigQuery emulator explorer: xem dataset/table và chạy GoogleSQL read-only.
- Jira Workspace: dashboard, issue filters/detail, board, weekly report, resource links, cấu hình và sync Jira read-only.
- Task History có tìm kiếm, lọc trạng thái và xóa các task đã hoàn thành.

Các màn hình chuyên biệt MySQL, Datastore, Kafka, Kafka UI, Redash và Spanner cần endpoint tương ứng được cấu hình. Các service khác vẫn vận hành qua trang Compose Service chung.

## Yêu cầu

- Node.js 22+ và npm.
- Docker Engine, Docker Compose v2 và quyền truy cập Docker socket.
- Với stack mẫu: chạy Docker Compose trước khi mở Control Center.

## Chạy local

```bash
cp .env.example .env
npm install
npm run dev
```

Mở frontend tại `http://localhost:5173`; API chạy mặc định tại `http://127.0.0.1:3000`.

```bash
npm run typecheck
npm run build
npm run start
```

## Chạy bằng container Control Center

Control Center được tách sang Compose file riêng để thao tác Stop all không dừng chính giao diện. `WORKSPACE_HOST_PATH` phải là đường dẫn tuyệt đối của project trên Docker host, vì API gọi Docker Compose từ container qua Docker socket.

```bash
export WORKSPACE_HOST_PATH="$(dirname "$PWD")"
docker compose -f ../docker-compose.yml up -d
docker compose --project-name local-infra-control-center -f docker-compose.control-center.yml up --build -d
```

> Mount Docker socket có quyền tương đương root trên Docker host. Chỉ expose Control Center qua Coder proxy, VPN hoặc mạng nội bộ tin cậy.

## Dùng với Docker Compose project khác

Control Center đọc các biến môi trường dưới đây. Khi chạy qua `docker-compose.control-center.yml`, dùng `CONTROLLED_COMPOSE_PROJECT_NAME` để tránh trùng với project của chính Control Center; API bên trong vẫn nhận giá trị này là `COMPOSE_PROJECT_NAME`.

```dotenv
# .env hoặc biến môi trường của service control-center
CONTROLLED_COMPOSE_PROJECT_NAME=my-project
COMPOSE_FILE=/absolute/path/to/my-project/compose.yaml
WORKSPACE_DIR=/absolute/path/to/my-project
```

Khi chạy Control Center trong container, mount `WORKSPACE_DIR` và đặt `COMPOSE_FILE` theo đường dẫn **của Docker host** — chính là đường dẫn mà Docker daemon thấy. Ví dụ trong `docker-compose.control-center.yml`:

```yaml
services:
  control-center:
    environment:
      COMPOSE_PROJECT_NAME: my-project
      COMPOSE_FILE: /srv/my-project/compose.yaml
      WORKSPACE_DIR: /srv/my-project
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /srv/my-project:/srv/my-project
```

## Catalog service động

`CONTROL_CENTER_SERVICES` là JSON array mô tả những service cần hiển thị và quản lý. Nếu để trống, ứng dụng dùng catalog `local-infra` mặc định. Khi giá trị được đặt, catalog này **thay thế** catalog mặc định.

Mỗi phần tử có các trường sau:

| Trường        | Bắt buộc | Ý nghĩa                                                        |
| ------------- | -------- | -------------------------------------------------------------- |
| `id`          | Có       | ID UI/API, lowercase, số và dấu `-`.                           |
| `label`       | Có       | Tên hiển thị.                                                  |
| `compose`     | Có       | Tên service trong Compose (`services.<tên>`).                  |
| `container`   | Không    | Tên/ID container cố định. Bỏ trống để tự tìm qua nhãn Compose. |
| `image`       | Không    | Chuỗi mô tả image trên Overview.                               |
| `ports`       | Không    | Mảng port để hiển thị.                                         |
| `runtimeMode` | Không    | `daemon` (mặc định) hoặc `one_off`.                            |

Ví dụ một project API + worker + Redis. Không đặt `container_name` vẫn hoạt động: Docker Compose tự gắn các nhãn `com.docker.compose.project` và `com.docker.compose.service`, Control Center dùng chúng để tìm container.

```yaml
# compose.yaml
services:
  api:
    image: ghcr.io/acme/orders-api:1.4
    ports: ['8080:8080']
  worker:
    image: ghcr.io/acme/orders-worker:1.4
  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
```

```dotenv
# Viết trên một dòng trong .env
CONTROL_CENTER_SERVICES=[{"id":"api","label":"Orders API","compose":"api","image":"ghcr.io/acme/orders-api:1.4","ports":["8080"],"runtimeMode":"daemon"},{"id":"worker","label":"Orders worker","compose":"worker","image":"ghcr.io/acme/orders-worker:1.4","runtimeMode":"daemon"},{"id":"redis","label":"Redis","compose":"redis","image":"redis:7-alpine","ports":["6379"],"runtimeMode":"daemon"}]
```

Với Control Center chạy qua `docker-compose.control-center.yml`, biến này đã được truyền vào container. Chỉ cần đặt nó trong `.env` trước khi chạy `docker compose up`. Sau khi đổi catalog hoặc Compose file, restart Control Center để nạp cấu hình mới.

Service `daemon` có thể Start/Stop/Restart, xem log và xuất hiện trong thao tác bulk. `one_off` chỉ hiển thị như tool on-demand; Control Center không chạy shell command tùy ý.

## Cấu hình endpoint của các màn hình chuyên biệt

Các giá trị bên dưới có sẵn trong `.env.example`; thay đổi theo port/hostname của project. Khi Control Center nằm cùng Docker network với target service, dùng hostname service Compose (ví dụ `mysql`, `kafka`, `spanner`) thay vì `localhost`.

| Nhóm          | Biến cấu hình                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web/API       | `PORT`, `HOST`, `ALLOWED_ORIGIN`, `TRUST_CODER_PROXY`, `CODER_ACTOR_HEADER`                                                                       |
| Task database | `TASK_DB_PATH`                                                                                                                                    |
| MySQL         | `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`                                                                      |
| Datastore     | `DATASTORE_EMULATOR_HOST`, `DATASTORE_PROJECT_ID`                                                                                                 |
| Kafka         | `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_UI_INTERNAL_URL`, `KAFKA_UI_OPEN_URL`                                                                           |
| Spanner       | `SPANNER_EMULATOR_HOST`, `SPANNER_PROJECT_ID`, `SPANNER_INSTANCE_ID`, `SPANNER_DATABASE_ID`                                                       |
| Redash        | `REDASH_INTERNAL_URL`, `REDASH_OPEN_URL`                                                                                                          |
| Keycloak      | `KEYCLOAK_INTERNAL_URL`, `KEYCLOAK_OPEN_URL`                                                                                                      |
| MailHog       | `MAILHOG_INTERNAL_URL`, `MAILHOG_OPEN_URL`                                                                                                        |
| BigQuery      | `BIGQUERY_API_ENDPOINT`, `BIGQUERY_PROJECT_ID`                                                                                                    |
| Jira          | `JIRA_TYPE`, `JIRA_BASE_URL`, `JIRA_INTERNAL_URL`, `JIRA_JQL`, `JIRA_ALLOWED_PROJECTS`, `JIRA_API_TOKEN`, `JIRA_EMAIL`, `JIRA_REQUEST_TIMEOUT_MS` |

`KAFKA_UI_OPEN_URL` và `REDASH_OPEN_URL` là URL mà browser người dùng có thể mở, thường là URL Coder proxy. Các biến `*_INTERNAL_URL` là URL API container dùng để health check trong Docker network.

Stack mẫu mở Keycloak tại port `8082` (tài khoản dev `admin` / `admin`), MailHog SMTP/UI tại `1025`/`8025`, và BigQuery REST/Storage gRPC tại `9050`/`9060`. BigQuery dùng emulator mã nguồn mở cho development, không phải service chính thức của Google Cloud.

## Jira Workspace

Mục **Jira Workspace** gom tất cả thao tác vào một màn hình với các tab Dashboard, Issues, Board, Reports, Resources và Settings. API không sinh issue mẫu: dashboard chỉ hiển thị issue đã đọc trực tiếp từ Jira qua REST API. MySQL giữ cache để làm báo cáo và cache được reconcile theo kết quả Jira thật sau mỗi lần sync.

### Kết nối Jira Cloud Free để test

Jira không chạy trong Docker của project. Để test bằng Jira thật mà không cần Data Center license, tạo một [Jira Cloud Free site](https://support.atlassian.com/jira-cloud-administration/docs/explore-jira-cloud-plans/), sau đó:

1. Tạo project thật với key `LOCAL` và tạo vài issue test trên Jira Cloud.
2. Tạo API token không scope/classic trong [Atlassian account security](https://id.atlassian.com/manage-profile/security/api-tokens) và lưu token ngay khi được hiển thị.
3. Điền URL site, email và token vào `.env`:

```dotenv
JIRA_TYPE=cloud
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_INTERNAL_URL=
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=<atlassian-api-token>
JIRA_JQL=project = LOCAL ORDER BY updated DESC
JIRA_ALLOWED_PROJECTS=LOCAL
```

4. Restart API/Control Center. Trong **Jira Workspace → Cấu hình**, chọn Jira Cloud, nhập đúng Base URL/JQL/allowlist, lưu, bấm **Test kết nối trực tiếp**, rồi **Sync Jira**.

`JIRA_INTERNAL_URL` có thể để trống khi backend truy cập được `JIRA_BASE_URL`. Token chỉ được gửi từ backend khi gọi Jira; frontend và MySQL không nhận token.

Để chuyển sang Jira khách hàng, đổi `JIRA_TYPE`, `JIRA_BASE_URL`, `JIRA_INTERNAL_URL` và `JIRA_API_TOKEN`; với Jira Cloud đặt thêm `JIRA_EMAIL`. Nếu database Control Center đã tồn tại, cập nhật Base URL, Team JQL và allowlist trong tab **Cấu hình**. Jira Data Center dùng PAT theo Bearer auth; Jira Cloud dùng email + API token theo Basic auth. Token không được nhận hoặc trả về qua API và không được lưu trong MySQL.

Sync hiện là read-only: Jira giữ status, assignee và workflow; MySQL chỉ giữ cache issue cùng report note, internal category, blocker/risk/highlight, resource link, lịch sử sync và audit log. CSV export có chặn ký tự mở đầu có thể kích hoạt công thức bảng tính.

## Bảo mật và giới hạn

- MySQL và Spanner chỉ chấp nhận một câu `SELECT` hoặc `WITH`.
- Docker Tools và gcloud chỉ chạy lệnh nằm trong catalog đã duyệt.
- Datastore mutation, SQL DDL/DML và Kafka offset reset chưa được bật.
- Task History chỉ xóa task đã hoàn thành; task queued/running được giữ lại.
- Không commit `.env`, password database, token hoặc đường dẫn hạ tầng nhạy cảm.
