# Local Infra Control Center

Web UI nội bộ để vận hành một Docker Compose project trong Coder hoặc môi trường local. Control Center hiển thị trạng thái service, chạy lifecycle Compose, xem log, lưu lịch sử task và cung cấp công cụ cho MySQL/Redash, Datastore, Kafka, Spanner, Docker và application service.

Project có thể dùng nguyên trạng với stack mẫu `local-infra` hoặc trỏ tới Compose project khác bằng cấu hình môi trường — không cần sửa mã nguồn cho các service Compose thông thường.

## Chức năng

- Overview trạng thái Docker, tài nguyên và các service/tool đã cấu hình.
- Start, stop, restart service Compose; Start all, Stop all và Restart unhealthy.
- Trang generic cho service Compose tùy biến: trạng thái, lifecycle và stream log.
- App Services: tạo, sửa, chạy và dừng process Go, Node hoặc Vue trong workspace.
- Docker Tools chỉ chạy catalog lệnh Docker đã duyệt.
- Spanner explorer: mở/thu gọn cột theo table, query read-only, chạy phần SQL đang chọn và lưu/mở lại SQL.
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
export WORKSPACE_HOST_PATH="$PWD"
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.control-center.yml up --build -d
```

> Mount Docker socket có quyền tương đương root trên Docker host. Chỉ expose Control Center qua Coder proxy, VPN hoặc mạng nội bộ tin cậy.

## Dùng với Docker Compose project khác

Control Center đọc các biến môi trường dưới đây. Hai biến bắt buộc cho project khác là `COMPOSE_PROJECT_NAME` và `COMPOSE_FILE`.

```dotenv
# .env hoặc biến môi trường của service control-center
COMPOSE_PROJECT_NAME=my-project
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

| Nhóm          | Biến cấu hình                                                                               |
| ------------- | ------------------------------------------------------------------------------------------- |
| Web/API       | `PORT`, `HOST`, `ALLOWED_ORIGIN`, `TRUST_CODER_PROXY`, `CODER_ACTOR_HEADER`                 |
| Task database | `TASK_DB_PATH`                                                                              |
| MySQL         | `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`                |
| Datastore     | `DATASTORE_EMULATOR_HOST`, `DATASTORE_PROJECT_ID`                                           |
| Kafka         | `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_UI_INTERNAL_URL`, `KAFKA_UI_OPEN_URL`                     |
| Spanner       | `SPANNER_EMULATOR_HOST`, `SPANNER_PROJECT_ID`, `SPANNER_INSTANCE_ID`, `SPANNER_DATABASE_ID` |
| Redash        | `REDASH_INTERNAL_URL`, `REDASH_OPEN_URL`                                                    |

`KAFKA_UI_OPEN_URL` và `REDASH_OPEN_URL` là URL mà browser người dùng có thể mở, thường là URL Coder proxy. Các biến `*_INTERNAL_URL` là URL API container dùng để health check trong Docker network.

## Bảo mật và giới hạn

- MySQL và Spanner chỉ chấp nhận một câu `SELECT` hoặc `WITH`.
- Docker Tools và gcloud chỉ chạy lệnh nằm trong catalog đã duyệt.
- Datastore mutation, SQL DDL/DML và Kafka offset reset chưa được bật.
- Task History chỉ xóa task đã hoàn thành; task queued/running được giữ lại.
- Không commit `.env`, password database, token hoặc đường dẫn hạ tầng nhạy cảm.
