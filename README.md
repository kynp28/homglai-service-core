# Homglai Service Core

ระบบติดตามงานซ่อมเครื่องชงกาแฟ (Core Service Backend Monorepo) สำหรับบริหารจัดการรับเครื่อง ประเมินอาการ จัดคิวช่าง เสนอราคาอะไหล่ และแจ้งเตือนสถานะงานซ่อมแบบเรียลไทม์

---

## 1. สถานะปัจจุบันของโปรเจ็ค

* **Backend (`apps/api`):** ใช้งานได้สมบูรณ์ (Production-ready API) ครอบคลุมระบบยืนยันตัวตน (Authentication), สิทธิ์ตามบทบาท (RBAC), การจัดคิวช่างอัตโนมัติ (Queue Auto-assignment), วงจรเสนอราคาและสถานะงานซ่อม (State Machine), LINE Messaging API Webhook, และ Server-Sent Events (SSE) สำหรับ Live Tracking
* **Database Package (`packages/db`):** ใช้งานได้สมบูรณ์ มี Prisma Schema และ Versioned SQL Migrations รองรับ Safe 3-Step Migration
* **Frontend (`apps/web`):** ปัจจุบันเป็น **Placeholder** (Next.js 15 Starter) เตรียมไว้สำหรับการพัฒนาหน้าบ้านในลำดับถัดไป

---

## 2. Tech Stack

* **Backend Framework:** Express 4 + TypeScript 5
* **Database & ORM:** MySQL 8.0 (รันบน Docker) + Prisma ORM 6 (`@prisma/client: ^6.4.0`)
* **Monorepo Manager:** pnpm workspaces (`pnpm@10.5.2`)
* **Authentication & Security:** 
  * JSON Web Token (`jsonwebtoken`, อัลกอริทึม HS256, อายุ Token 12 ชั่วโมง)
  * รหัสผ่านแฮชด้วย `bcryptjs` (Salt 10 Rounds พร้อม Dummy Compare ป้องกัน Timing Attack)
  * `helmet` ป้องกัน HTTP Header ช่องโหว่ความปลอดภัย
  * `express-rate-limit` ป้องกัน Brute-force บน `/api/auth/login`
* **Data Validation:** Zod (`^3.24.2`) ตรวจสอบความถูกต้องของ Request Body และ Query Parameters
* **LINE Integration:** LINE Messaging API (ตรวจสอบ Webhook Signature ด้วย HMAC-SHA256, ส่งข้อความ Push & Reply)
* **Real-time Engine:** Server-Sent Events (SSE) สำหรับ Live Tracking ผ่าน Browser

---

## 3. โครงสร้างโฟลเดอร์

```text
homglai-service-core/
├── apps/
│   ├── api/                     # REST API Backend Server (Express + TypeScript)
│   └── web/                     # Web Application Frontend (Next.js 15 Placeholder)
├── packages/
│   ├── db/                      # Prisma Schema, Database Client และ SQL Migrations
│   └── typescript-config/       # ค่าคอนฟิก TypeScript กลางสำหรับ Monorepo
├── docker/                      # สคริปต์ Database Initialization
├── docker-compose.yml           # นิยาม MySQL 8 Services สำหรับ Development และ Testing
├── pnpm-workspace.yaml          # กำหนด Monorepo Workspaces
└── package.json                 # สคริปต์และ Dependencies ระดับ Root
```

* `apps/api`: ซอร์สโค้ดและสคริปต์ทดสอบของ REST API Backend
* `apps/web`: โครงสร้างหน้าบ้าน Next.js 15 (Placeholder)
* `packages/db`: ตัวจัดการฐานข้อมูล Prisma Client และ Migration Files
* `packages/typescript-config`: ไฟล์ตั้งค่า TypeScript พื้นฐานที่แชร์ระหว่าง Packages

---

## 4. ความต้องการเบื้องต้น (Prerequisites)

* **Node.js:** แนะนำเวอร์ชัน 20.x หรือ 22.x LTS (อิงตาม `@types/node: ^22.13.4`)
* **pnpm:** เวอร์ชัน `10.5.2` (กำหนดไว้ใน `packageManager` ของ `package.json`)
* **Docker & Docker Compose:** สำหรับรันคอนเทนเนอร์ฐานข้อมูล MySQL 8.0

---

## 5. วิธีติดตั้งและรันครั้งแรก ทีละขั้นตอน

### ขั้นที่ 1: ติดตั้ง Dependencies
เปิดเทอร์มินัลที่ Root ของโปรเจ็คแล้วรันคำสั่ง:
```bash
pnpm install
```

### ขั้นที่ 2: ตั้งค่า Environment Variables
คัดลอกไฟล์ `.env.example` ไปเป็น `.env` ใน `apps/api` และ `packages/db`:

* **บน Linux / macOS:**
  ```bash
  cp apps/api/.env.example apps/api/.env
  cp apps/api/.env.example packages/db/.env
  ```
* **บน Windows PowerShell:**
  ```powershell
  Copy-Item apps/api/.env.example apps/api/.env
  Copy-Item apps/api/.env.example packages/db/.env
  ```

เปิดไฟล์ `apps/api/.env` เพื่อแก้ไขการตั้งค่า (ดูรายละเอียดในตาราง Environment Variables):
* กำหนด `MYSQL_ROOT_PASSWORD` เป็นรหัสผ่านที่ปลอดภัย
* ตรวจสอบ `DATABASE_URL` ให้ตรงกับรหัสผ่านที่กำหนด (เช่น `mysql://root:your-password@127.0.0.1:3306/homglai_db`)
* กำหนด `JWT_SECRET` ให้มีความยาวอย่างน้อย 32 ตัวอักษร

### ขั้นที่ 3: เปิดฐานข้อมูลด้วย Docker Compose
สั่งรัน MySQL Container โดยส่งค่า `MYSQL_ROOT_PASSWORD` (ระบบไม่อนุญาตให้เริ่มหากไม่ตั้งรหัสผ่าน):
```bash
MYSQL_ROOT_PASSWORD=your-secure-mysql-root-password docker compose up -d
```
คอนเทนเนอร์ที่ถูกสร้างขึ้น:
* `homglai-mysql`: พอร์ต `127.0.0.1:3306` (ฐานข้อมูลหลัก `homglai_db`)
* `homglai-mysql-test`: พอร์ต `127.0.0.1:3307` (ฐานข้อมูลสำหรับชุดทดสอบ `homglai_db_test`)

*(หมายเหตุ: ทุกพอร์ตผูกกับ `127.0.0.1` เท่านั้นเพื่อความปลอดภัย ไม่เปิดสู่ภายนอก)*

### ขั้นที่ 4: รัน Database Migration และสร้าง Admin บัญชีแรก (Bootstrap)
รันคำสั่ง Migrate โครงสร้างฐานข้อมูล:
```bash
pnpm --filter @homglai/db run db:deploy
```

สร้างบัญชีผู้ดูแลระบบ (Admin) บัญชีแรกผ่าน CLI:
```bash
pnpm --filter @homglai/api create-admin
```
ระบบจะแสดงแบบสอบถามผ่าน Command Line ให้กรอก:
1. Admin Username (อย่างน้อย 3 ตัวอักษร)
2. Admin Full Name (ชื่อ-นามสกุล)
3. Admin Password (อย่างน้อย 12 ตัวอักษร)

*(หมายเหตุ: สามารถกำหนดล่วงหน้าผ่าน Env `ADMIN_USERNAME`, `ADMIN_NAME`, `ADMIN_PASSWORD` ได้)*

### ขั้นที่ 5: บิลด์และเริ่มการทำงานของ API Server

* **โหมดพัฒนา (Development):**
  ```bash
  pnpm --filter @homglai/api dev
  ```
* **โหมดใช้งานจริง (Production Build & Start):**
  ```bash
  pnpm --filter @homglai/db build
  pnpm --filter @homglai/api build
  pnpm --filter @homglai/api start
  ```

เมื่อ Server เริ่มทำงานสำเร็จ:
* ตรวจสอบสถานะการเชื่อมต่อ: `GET http://localhost:4000/api/health` (ต้องตอบกลับ `{ "status": "ok", "database": "connected" }`)
* ดูเอกสาร API ผ่าน Swagger UI: `http://localhost:4000/api-docs` *(ปิดอัตโนมัติเมื่อ `NODE_ENV=production`)*

---

## 6. ตาราง Environment Variables

| ชื่อตัวแปร | จำเป็นหรือไม่ | ความหมาย | ตัวอย่าง Placeholder |
| :--- | :---: | :--- | :--- |
| `PORT` | ไม่บังคับ | พอร์ตที่ API Server เปิดให้บริการ (Default: `4000`) | `4000` |
| `DATABASE_URL` | **จำเป็น** | URL เชื่อมต่อฐานข้อมูล MySQL สำหรับ API และ Prisma | `mysql://root:your-password@127.0.0.1:3306/homglai_db` |
| `JWT_SECRET` | **จำเป็น** | กุญแจลับสำหรับเซ็น JWT Token (บังคับความยาวอย่างน้อย 32 ตัวอักษร) | `your-at-least-32-character-jwt-secret-key-here` |
| `CORS_ORIGINS` | ไม่บังคับ | รายการ URL ต้นทางที่อนุญาตให้เรียก API คั่นด้วยจุลภาค (Default: `http://localhost:3000`) | `http://localhost:3000,http://localhost:4000` |
| `TRUST_PROXY` | ไม่บังคับ | ตั้งค่าการเชื่อถือ Reverse Proxy ของ Express (`true`, `false`, หรือจำนวน hop เช่น `1`, Default: `false`) | `false` |
| `LINE_CHANNEL_SECRET` | **จำเป็นสำหรับ Webhook** | Channel Secret จาก LINE Developers Console ใช้คำนวณ HMAC-SHA256 ตรวจสอบ Signature | `your-line-channel-secret` |
| `LINE_CHANNEL_ACCESS_TOKEN` | **จำเป็นสำหรับส่งข้อความ** | Channel Access Token สำหรับเรียก LINE Messaging API (Reply/Push) | `your-line-channel-access-token` |
| `PUBLIC_TRACKING_BASE_URL` | ไม่บังคับ | Base URL สำหรับลิงก์ติดตามงานซ่อมที่ส่งให้ลูกค้าใน LINE (ถ้าไม่ตั้ง จะไม่ส่งลิงก์ติดตาม แต่ส่งข้อความอื่นตามปกติ) | `https://example.com/tracking/` |
| `MYSQL_ROOT_PASSWORD` | **จำเป็นใน Docker** | รหัสผ่านผู้ใช้ root ของ MySQL (docker-compose บังคับต้องมี) | `your-secure-mysql-root-password` |
| `ALLOW_DESTRUCTIVE_TESTS` | ไม่บังคับ | แฟล็กอนุญาตให้สคริปต์ทดสอบลบข้อมูลใน DB (Default: `false`, **ห้ามเปิดบน Production เด็ดขาด**) | `false` |
| `SEED_DEFAULT_PASSWORD` | จำเป็นสำหรับ Test Runner | รหัสผ่านเริ่มต้นสำหรับพนักงานที่สร้างในสคริปต์ `seed:test` | `required-for-seed-test-script` |
| `TEST_DB_CONTAINER` | ไม่บังคับ | ชื่อคอนเทนเนอร์ฐานข้อมูลทดสอบ (Default: `homglai-mysql-test`) | `homglai-mysql-test` |
| `TEST_DB_USER` | ไม่บังคับ | ชื่อผู้ใช้สำหรับฐานข้อมูลทดสอบ (Default: `root`) | `root` |
| `TEST_DB_PASSWORD` | ไม่บังคับ | รหัสผ่านสำหรับฐานข้อมูลทดสอบ (Default: อ่านจาก `MYSQL_ROOT_PASSWORD` หรือ `root`) | `your-secure-mysql-root-password` |
| `TEST_DB_HOST` | ไม่บังคับ | โฮสต์ของฐานข้อมูลทดสอบ (Default: `127.0.0.1`) | `127.0.0.1` |
| `TEST_DB_PORT` | ไม่บังคับ | พอร์ตของฐานข้อมูลทดสอบ (Default: `3307`) | `3307` |
| `ACK_TIMEOUT_MINUTES` | ไม่บังคับ | นาทีที่ช่างไม่กดรับงานแล้วเริ่มเตือน ADMIN (Default: `60`) | `60` |
| `ACK_REMINDER_INTERVAL_MINUTES` | ไม่บังคับ | เตือน ADMIN ซ้ำทุกกี่นาทีเมื่อช่างยังไม่กดรับงาน (Default: `60`) | `60` |
| `PROGRESS_REMINDER_INTERVAL_MINUTES` | ไม่บังคับ | นาทีเวลาทำการที่ใบงานนิ่งแล้วถามช่างเรื่องความคืบหน้า (Default: `60`) | `60` |
| `PROGRESS_UNANSWERED_ADMIN_THRESHOLD` | ไม่บังคับ | ช่างไม่ตอบครบกี่รอบจึงแจ้ง ADMIN (Default: `3`) | `3` |
| `BUSINESS_HOURS_START` / `BUSINESS_HOURS_END` | ไม่บังคับ | เวลาทำการ (เวลาไทย, `HH:MM`, ทุกวัน) (Default: `08:00` / `17:30`) | `08:00` |
| `IMAGE_RETENTION_DAYS` | ไม่บังคับ | ลบรูปหลังใบงานปิดกี่วัน (Default: `30`) | `30` |
| `JOB_WORKER_INTERVAL_SECONDS` / `JOBS_ENABLED` | ไม่บังคับ | รอบการทำงานเบื้องหลัง (วินาที) และเปิด/ปิด (Default: `60` / `true`) | `60` |
| `CUSTOMER_LINE_APPROVAL_ENABLED` | ไม่บังคับ | เปิดให้ลูกค้าอนุมัติราคาผ่าน LINE (Default: `false`) | `false` |
| `PUBLIC_SEARCH_RATE_LIMIT_MAX` | ไม่บังคับ | จำนวนครั้งค้นหาสาธารณะต่อ IP ต่อ 15 นาที (Default: `30`) | `30` |
| `IMAGE_STORAGE_DIR` / `IMAGE_MAX_BYTES` / `IMAGE_MAX_PER_KIND` / `IMAGE_MAX_LONG_EDGE` | ไม่บังคับ | ที่เก็บรูปและข้อจำกัดรูป (Default: `./data/uploads` / `5242880` / `10` / `1600`) | `./data/uploads` |
| `NOTIFIER_DRIVER` | ไม่บังคับ | ช่องทางแจ้งเตือนพนักงาน ตอนนี้รองรับ `db` (แสดงในเว็บ) (Default: `db`) | `db` |

---

## 7. ตาราง API Endpoints ทั้งหมด

ทุก Endpoint ภายใต้ `/api` มีรายละเอียดและการจำกัดสิทธิ์ดังนี้:

| Method | Path | Role ที่เรียกได้ | คำอธิบาย |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Public | ตรวจสอบสถานะการทำงานของ Server และการเชื่อมต่อฐานข้อมูล |
| `POST` | `/api/auth/login` | Public (Rate Limited) | เข้าสู่ระบบพนักงาน ตรวจสอบ Username/Password และคืนค่า JWT Token (จำกัด 5 ครั้งต่อ 15 นาทีต่อ IP) |
| `POST` | `/api/auth/change-password` | ทุก Role (Authenticated) | เปลี่ยนรหัสผ่านของตนเอง (ต้องระบุ `oldPassword` และ `newPassword` อย่างน้อย 12 ตัวอักษร) |
| `POST` | `/api/employees` | `ADMIN` | สร้างบัญชีพนักงานใหม่ (ระบุ username, name, password, role) |
| `GET` | `/api/employees` | `ADMIN` | ดึงรายชื่อพนักงานทั้งหมดในระบบ |
| `PATCH` | `/api/employees/:id` | `ADMIN` | แก้ไขข้อมูลพนักงาน เปลี่ยน Role หรือระงับการใช้งานชั่วคราว (`isActive: false`) — ถ้าเป็นช่าง ใบงานที่ถืออยู่ทุกขั้น (ยกเว้น `COMPLETED`) กลับกองกลางหัวคิวและจ่ายต่อทันที |
| `POST` | `/api/employees/:id/reset-password` | `ADMIN` | รีเซ็ตรหัสผ่านพนักงานเป็นค่าใหม่ |
| `PATCH` | `/api/employees/:id/status` | `ADMIN`, เจ้าของบัญชี | อัปเดตสถานะการทำงานพนักงาน (`AVAILABLE`, `BUSY`, `OFFLINE`) พร้อมทริกเกอร์ระบบจัดคิวงานอัตโนมัติ (`assignedOrder` รวมงานที่จองไว้รอกดรับ, ช่างที่ `RESERVED` เปลี่ยนสถานะเองไม่ได้ ตอบ 409, ช่างจะไม่ได้รับ `trackingToken`) |
| `POST` | `/api/repairs` | `RECEPTIONIST`, `ADMIN` | สร้างใบสั่งซ่อมใหม่ (สถานะเริ่มต้น `NEW`), บันทึกข้อมูลลูกค้า, เครื่อง และอาการเสีย พร้อมจัดคิวช่างอัตโนมัติหากมีช่างว่าง |
| `GET` | `/api/repairs` | ทุก Role (Authenticated) | ค้นหาและแบ่งหน้าใบสั่งซ่อม (รองรับ Query: `status`, `technicianId`, `search` สูงสุด 100 ตัวอักษร, `page`, `limit`; ค้นด้วยเลขใบงาน/เลขใบกระดาษ/เลขเล่ม/เบอร์/ชื่อลูกค้า; ช่างเห็นเฉพาะงานที่จ่ายให้ตนเอง ไม่เห็นงาน `NEW` ที่ยังไม่มีเจ้าของ; `awaitingAck=true` = งานที่จ่ายแล้วรอกดรับ พร้อม `assignedAt`, `waitingMinutes`) |
| `GET` | `/api/repairs/:id` | `ADMIN`, `RECEPTIONIST`, ช่างที่รับผิดชอบ | ดูรายละเอียดใบสั่งซ่อมแบบเจาะลึก (ช่างไม่ได้รับ `trackingToken`, ทุก Role ไม่ได้รับ `customer.lineUserId` แต่ได้ `customer.lineLinked`) |
| `PATCH` | `/api/repairs/:id` | `RECEPTIONIST`, `ADMIN` | แก้ข้อมูลรับเครื่อง (ใบกระดาษ/ลูกค้า/เครื่อง/อาการ/ประกัน/อุปกรณ์ ฯลฯ) ห้ามแก้สถานะ/ช่าง/เลขใบงาน และห้ามแก้ใบงานที่ปิดแล้ว |
| `POST` | `/api/repairs/:id/accept` | ช่างที่ได้รับจ่าย, `ADMIN` (กดแทน) | กดรับงานที่จองไว้ (`NEW` → `INSPECTING`, ช่าง `RESERVED` → `BUSY`; งานที่ถูกส่งกลับจากช่างที่ลาออกจะกลับไปขั้นที่ค้าง) |
| `POST` | `/api/repairs/:id/release` | `ADMIN` | ปล่อยงานที่จองไว้แต่ยังไม่กดรับคืนกองกลาง (ช่างกลับ `AVAILABLE`) แล้วรันคิวใหม่ |
| `POST` | `/api/repairs/:id/items` | `ADMIN`, ช่างที่รับผิดชอบ | เพิ่มรายการเสนอราคาอะไหล่/บริการ (เปลี่ยนสถานะใบซ่อมเป็น `WAITING_APPROVAL` อัตโนมัติ, ช่างไม่ได้รับ `trackingToken`) |
| `PATCH` | `/api/repairs/:id/items/:itemId/status` | `RECEPTIONIST`, `ADMIN` | อนุมัติ (`APPROVED`) หรือปฏิเสธ (`REJECTED`) รายการซ่อมในฐานะตัวแทนลูกค้า |
| `PATCH` | `/api/repairs/:id/items/:itemId/complete` | `ADMIN`, ช่างที่รับผิดชอบ | ทำเครื่องหมายรายการซ่อมที่อนุมัติแล้วว่าดำเนินการซ่อมเสร็จสิ้น (`COMPLETED`, ช่างไม่ได้รับ `trackingToken`) |
| `GET` | `/api/notifications` | ทุก Role (Authenticated) | แจ้งเตือนของตนเองในเว็บ (Query: `unreadOnly`, `page`, `limit`) |
| `PATCH` | `/api/notifications/:id/read` | เจ้าของแจ้งเตือน | ทำเครื่องหมายว่าอ่านแล้ว (ของคนอื่นตอบ 404) |
| `PATCH` | `/api/repairs/:id/status` | ทุก Role (ตามเงื่อนไข State Machine) | เปลี่ยนสถานะใบสั่งซ่อม (ช่างเปลี่ยนได้เฉพาะงานตนเอง, ช่างไม่ได้รับ `trackingToken`, `ADMIN`/`RECEPTIONIST` ได้รับตามปกติ) |
| `GET` | `/api/symptoms` | ทุก Role (Authenticated) | ดึงรายการหมวดหมู่อาการเสียและอาการเสียย่อยทั้งหมด |
| `GET` | `/api/tracking/stream/:trackingToken` | Public | สตรีมสถานะงานซ่อมแบบเรียลไทม์ด้วย Server-Sent Events (SSE) โดยใช้ `trackingToken` ของใบสั่งซ่อม |
| `POST` | `/api/webhook/line` | Public (ตรวจสอบ Signature) | รับ Webhook Event จาก LINE Messaging API สำหรับการผูกบัญชี LINE ลูกค้า และการกดปุ่มอนุมัติ/ปฏิเสธใบเสนอราคาผ่าน Postback |

---

## 8. กฎของ RepairStatus (State Machine & Quotation Rules)

สถานะของใบสั่งซ่อมถูกควบคุมอย่างเข้มงวดผ่าน State Machine เพื่อป้องกันข้อผิดพลาดในกระบวนการทำงาน:

```mermaid
stateDiagram-v2
    [*] --> NEW: เปิดใบซ่อม (Intake)
    NEW --> INSPECTING: ช่าง AVAILABLE รับงานเข้าคิว
    NEW --> CANCELLED: ยกเลิกงาน

    INSPECTING --> WAITING_APPROVAL: ช่างเพิ่มรายการเสนอราคา (addItem)
    INSPECTING --> REPAIRING: ช่างเริ่มซ่อม (กรณีไม่ต้องรออนุมัติ)
    INSPECTING --> CANCELLED: ยกเลิกงาน

    WAITING_APPROVAL --> REPAIRING: ลูกค้า/จนท. อนุมัติอย่างน้อย 1 รายการ
    WAITING_APPROVAL --> INSPECTING: รายการทั้งหมดถูก REJECTED
    WAITING_APPROVAL --> CANCELLED: ยกเลิกงาน

    REPAIRING --> WAITING_APPROVAL: พบอาการเพิ่ม ช่างเปิดรายการใหม่
    REPAIRING --> COMPLETED: ซ่อมเสร็จทุกรายการที่อนุมัติ
    REPAIRING --> CANCELLED: ยกเลิกงาน

    COMPLETED --> DELIVERED: ลูกค้ารับเครื่องกลับ (Receptionist)
    COMPLETED --> REPAIRING: งานตีกลับ/แก้ไข (Rework มอบหมายช่างว่าง)

    DELIVERED --> [*]: สถานะสิ้นสุด (Terminal State)
    CANCELLED --> [*]: สถานะสิ้นสุด (Terminal State)
```

### กฎและเงื่อนไขทางธุรกิจที่บังคับใช้ในโค้ด:
1. **ห้ามเปลี่ยนเป็นสถานะเดิม (Same-status Guard):** หากส่งสถานะเดิมที่ใบซ่อมเป็นอยู่แล้ว ระบบจะตอบกลับ `409 Conflict` และไม่บันทึก StatusLog ซ้ำ
2. **ห้ามเปลี่ยนเป็น `INSPECTING` หรือ `WAITING_APPROVAL` โดยตรง:** 
   * สถานะ `INSPECTING` จะเกิดขึ้นผ่านระบบคิวงานอัตโนมัติเมื่อช่างสถานะ `AVAILABLE` เท่านั้น
   * สถานะ `WAITING_APPROVAL` จะเกิดขึ้นอัตโนมัติเมื่อมีการเพิ่มรายการเสนอราคาผ่าน `POST /api/repairs/:id/items` เท่านั้น
3. **การออกจาก `WAITING_APPROVAL`:**
   * ห้ามเปลี่ยนสถานะออกจาก `WAITING_APPROVAL` ตราบใดที่ยังมีรายการซ่อมในสถานะรออนุมัติ (`PENDING`) ค้างอยู่ (จะตอบ `409 Conflict`)
   * เมื่อรายการสุดท้ายถูกตัดสิน: หากมีรายการได้รับอนุมัติ (`APPROVED`) อย่างน้อย 1 รายการ ระบบจะเปลี่ยนเป็น `REPAIRING` อัตโนมัติ แต่หากถูกปฏิเสธ (`REJECTED`) ทั้งหมด ระบบจะถอยกลับไป `INSPECTING` อัตโนมัติ
4. **เงื่อนไขการจบงาน (`COMPLETED`):** ใบสั่งซ่อมจะไม่สามารถเปลี่ยนสถานะเป็น `COMPLETED` ได้ หากยังมีรายการที่ `APPROVED` แต่ช่างยังไม่ได้ทำเครื่องหมายเป็น `COMPLETED` ผ่าน `PATCH /api/repairs/:id/items/:itemId/complete`
5. **งานตีกลับ/แก้ไขหลังซ่อม (`COMPLETED` -> `REPAIRING`):** ระบบจะพยายามล็อกตัวช่างคนเดิมหากมีสถานะเป็น `AVAILABLE` แต่ถ้าช่างคนเดิมไม่ว่าง ระบบจะค้นหาและล็อกช่างคนถัดไปที่ว่างทันที หากไม่มีช่างคนใดว่างเลย จะไม่อนุญาตให้เปิดงานและตอบกลับ `409 Conflict`
6. **สถานะสิ้นสุด (Terminal States):** สถานะ `DELIVERED` และ `CANCELLED` ถือเป็นสถานะสิ้นสุด ไม่อนุญาตให้เปลี่ยนสถานะต่อไปยังสถานะอื่นใดอีก

---

## 9. สิทธิ์ตามบทบาท (Role-Based Access Control & Data Privacy)

ระบบแบ่งบทบาทผู้ใช้งานออกเป็น 3 บทบาทหลัก พร้อมนโยบายรักษาความปลอดภัยข้อมูล:

### สิทธิ์ของแต่ละบทบาท:
* **`ADMIN` (ผู้ดูแลระบบ):**
  * สิทธิ์สูงสุดในการจัดการพนักงาน (สร้าง, แก้ไข, ระงับการใช้งาน, รีเซ็ตรหัสผ่าน)
  * สิทธิ์ในการจัดการใบสั่งซ่อมทุกขั้นตอน รวมถึงการอนุมัติรายการแทนลูกค้า และการแก้ไขสถานะ
  * สามารถมองเห็น `trackingToken` ของใบสั่งซ่อม
* **`RECEPTIONIST` (พนักงานต้อนรับ/หน้าร้าน):**
  * สิทธิ์ในการเปิดใบสั่งซ่อมใหม่ (`POST /api/repairs`)
  * สิทธิ์ในการค้นหาและดูรายการใบสั่งซ่อมทั้งหมด
  * สิทธิ์ในการอนุมัติหรือปฏิเสธรายการซ่อมแทนลูกค้าตามที่ได้รับมอบหมาย
  * สิทธิ์ในการส่งมอบเครื่องให้ลูกค้า (`COMPLETED` -> `DELIVERED`) หรือยกเลิกใบซ่อม (`CANCELLED`)
  * สามารถมองเห็น `trackingToken` เพื่อพิมพ์หรือส่งลิงก์ติดตามให้ลูกค้า
* **`TECHNICIAN` (ช่างซ่อม):**
  * สิทธิ์ในการอัปเดตสถานะตนเอง (`AVAILABLE`, `BUSY`, `OFFLINE`) เพื่อรับงานจากคิวอัตโนมัติ
  * สิทธิ์ในการเพิ่มรายการเสนอราคาอะไหล่ (`addItem`) และทำเครื่องหมายซ่อมเสร็จ (`completeItem`) เฉพาะใบงานที่ตนได้รับมอบหมาย
  * สิทธิ์ในการดูรายการใบสั่งซ่อมเฉพาะใบงานที่ตนได้รับมอบหมาย และใบงานเข้าใหม่ (`NEW`) เท่านั้น (ไม่สามารถดูงานของช่างท่านอื่นได้)

### นโยบายความเป็นส่วนตัวและการปกป้องข้อมูล (Privacy & Redaction):
1. **การซ่อน `trackingToken` จากช่างซ่อม (`TECHNICIAN`):**
   * ระบบมี Helper กลาง (`sanitizeForRole`) ทำการตรวจสอบและตัดฟิลด์ `trackingToken` ออกจาก Response ทุกระดับชั้น (Deep Redaction) สำหรับผู้เรียกที่มีบทบาท `TECHNICIAN` ในทุก Endpoint (`PATCH /status`, `POST /items`, `PATCH /items/:itemId/complete`, `PATCH /employees/:id/status`)
   * ป้องกันไม่ให้ช่างนำโทเคนติดตามไปเปิดดูหน้าของลูกค้า หรือส่งต่อให้บุคคลภายนอกโดยไม่ได้รับอนุญาต
2. **การปกป้อง `customer.lineUserId`:**
   * ข้อมูล `lineUserId` ของลูกค้าถือเป็นข้อมูลส่วนบุคคลอ่อนไหว (PII) API ทุก Endpoint (`POST /repairs`, `PATCH /status`, `GET /repairs/:id`, `PATCH /employees/:id/status`) จะ**ไม่ส่งฟิลด์ `customer.lineUserId` ออกมาใน Response ให้กับทุกบทบาท**
   * ระบบจะแปลงเป็นฟิลด์ boolean `customer.lineLinked` (`true` เมื่อลูกค้าผูกบัญชี LINE แล้ว, `false` เมื่อยังไม่ได้ผูก) เพื่อให้หน้าจอแสดงผลสถานะได้โดยไม่ต้องเปิดเผยรหัสผู้ใช้ LINE

---

## 10. การทดสอบระบบ (Automated Test Suites)

ชุดคำสั่งสำหรับรันการทดสอบทั้งหมดมีอยู่ใน `package.json` สามารถสั่งรันได้ดังนี้:

### คำสั่งรันชุดทดสอบ:
1. **รันชุดทดสอบทั้งหมดครบ 4 ชุด (แนะนำ):**
   ```bash
   pnpm --filter @homglai/api test:all
   ```
2. **รันเฉพาะการทดสอบ Timezone Rollover (1/4):**
   ```bash
   pnpm --filter @homglai/api test:timezone
   ```
   *ตรวจสอบการสร้างเลขที่ใบงาน YYMM ให้ตรงตามโซนเวลา `Asia/Bangkok` เสมอแม้เซิร์ฟเวอร์จะรันบน UTC*
3. **รันเฉพาะการทดสอบ Safe 3-Step Migration (2/4):**
   ```bash
   pnpm --filter @homglai/api test:migration
   ```
   *จำลองข้อมูลเดิม >= 5 แถว แล้วทดสอบรัน Migration แบบปลอดภัย ข้อมูลต้องไม่สูญหายและ Backfill สำเร็จ*
4. **รันเฉพาะการทดสอบ Comprehensive Smoke Tests (3/4):**
   ```bash
   pnpm --filter @homglai/api test:smoke
   ```
   *ทดสอบวงจร End-to-End ครบทั้ง 14 หมวด ทั้ง Positive และ Negative cases (400, 401, 403, 409)*
5. **รันเฉพาะการทดสอบ High-Concurrency & Contention (4/4):**
   ```bash
   pnpm --filter @homglai/api test:concurrency
   ```
   *ทดสอบเปิดงานพร้อมกัน 20 คำขอ (Job number collision handling), การแย่งชิงคิวงาน 20 รอบ, และ Race condition ในการอนุมัติไอเทม*

> [!CAUTION]
> **คำเตือนความปลอดภัยร้ายแรงเกี่ยวกับฐานข้อมูลทดสอบ:**
> **ห้ามชี้ `DATABASE_URL` ในการทดสอบไปยังฐานข้อมูลใช้งานจริง (Production) โดยเด็ดขาด**
> สคริปต์ทดสอบมีคำสั่งล้างข้อมูล (`deleteMany` และ Reset ข้อมูล Master Data) โค้ดมีระบบความปลอดภัย (`assertSafeDatabaseUrl` ใน `test-safety.ts`) ซึ่งจะ**ปฏิเสธการทำงานและสั่งหยุดระบบทันที** หากชื่อฐานข้อมูลใน `DATABASE_URL` ไม่ได้ลงท้ายด้วย `_test` (เช่น `homglai_db_test`)
> **ห้ามตั้งค่า `ALLOW_DESTRUCTIVE_TESTS=true` บนสภาพแวดล้อม Production หรือ Staging ที่มีข้อมูลจริงอย่างเด็ดขาด** ค่านี้อนุญาตให้ใช้เฉพาะใน CI หรือฐานข้อมูลชั่วคราวที่สร้างขึ้นมาเพื่อทิ้งเท่านั้น

---

## 11. ข้อควรระวังและแนวทางปฏิบัติเมื่อนำขึ้นระบบจริง (Production Hardening)

1. **บังคับใช้ HTTPS / TLS เสมอ:** ข้อมูลการเข้าสู่ระบบ, Token และ Webhook ต้องส่งผ่านช่องทางที่เข้ารหัส TLS 1.3 เสมอ
2. **การตั้งค่า Reverse Proxy (`TRUST_PROXY`):**
   * หากรันอยู่หลัง Nginx, Cloudflare, Traefik หรือ AWS ALB ที่ทำ TLS Termination และส่ง Header `X-Forwarded-For` ต้องตั้งค่า `TRUST_PROXY=1` (หรือ `true`)
   * หาก Server เปิดรับคำขอโดยตรงโดยไม่มี Proxy คั่น **ต้องตั้ง `TRUST_PROXY=false`** เพื่อป้องกันการปลอมแปลง IP Header ซึ่งส่งผลต่อ Rate Limiter และ Audit Log
3. **การผลัดเปลี่ยนกุญแจความลับ (Secret Rotation):**
   * ต้องสุ่มค่า `JWT_SECRET` ใหม่ที่มีความยาวอย่างน้อย 32 ตัวอักษรที่มีเอนโทรปีสูง
   * กำหนดรหัสผ่าน `MYSQL_ROOT_PASSWORD` ใหม่ที่รัดกุม
   * ตั้งค่า `LINE_CHANNEL_SECRET` และ `LINE_CHANNEL_ACCESS_TOKEN` จาก LINE Official Account จริง
   * ตั้งค่า `NODE_ENV=production` เพื่อปิดการเข้าถึง Swagger UI (`/api-docs`) โดยอัตโนมัติ
4. **การสำรองข้อมูลและทดสอบการกู้คืน (Backup & Tested Restore):**
   * ก่อนการ Deploy Migration ทุกครั้ง ต้องสั่งทำ Database Snapshot / Dump เสมอ:
     ```bash
     mysqldump -u <user> -p -h <host> --single-transaction --quick --routines --triggers homglai_db > backup_$(date +%Y%m%d_%H%M%S).sql
     ```
   * ต้องทำการซ้อม Restore จากไฟล์ Backup บนเครื่องสำรองอย่างสม่ำเสมอ เพื่อให้มั่นใจว่าไฟล์สำรองสามารถกู้คืนได้จริงเมื่อเกิดภัยพิบัติ
5. **การปฏิบัติตามกฎหมายคุ้มครองข้อมูลส่วนบุคคล (PDPA):**
   * ระบบปฏิบัติตามหลัก Data Minimization โดยไม่เปิดเผย `lineUserId` ของลูกค้าผ่าน API
   * การจัดเก็บ Access Log ต้องไม่มีการบันทึก Header `Authorization`, รหัสผ่าน หรือ Request Body ที่มีข้อมูลส่วนบุคคลโดยไม่จำเป็น

---

## 12. สิ่งที่ยังไม่ได้ดำเนินการ (Pending Roadmap)

* **User Interface (UI):** โครงสร้างหน้าบ้านใน `apps/web` ยังเป็นเพียงโครงสร้างเริ่มต้น ต้องพัฒนาหน้าจอสำหรับพนักงานต้อนรับ, หน้าจอช่าง, และหน้าจอติดตามสถานะสำหรับลูกค้า
* **Automated CI/CD Pipeline:** การสร้าง GitHub Actions หรือ GitLab CI สำหรับรัน Lint, Build, และ Test Runner อัตโนมัติเมื่อมีการ Pull Request
* **ระบบสำรองข้อมูลอัตโนมัติตามเวลา (Automated Scheduled Backup):** การตั้ง Cron Job สำหรับ Snapshot ฐานข้อมูลและส่งออกไปยัง Cloud Storage (เช่น S3 หรือ GCS)
* **การทดสอบจริงกับ LINE OA ภายนอก:** ปัจจุบันระบบทดสอบผ่านการจำลอง Signature และ Mock Server ยังต้องทำการทดสอบ Live Webhook กับเซิร์ฟเวอร์ LINE จริงผ่าน Public HTTPS URL

---

## 13. ปัญหาที่ทราบและพฤติกรรมเฉพาะของระบบ (Known Issues & Behaviors)

1. **ข้อความ Authentication Failed ของ LINE API ระหว่างรันชุดทดสอบ:**
   * ในระหว่างรัน `test:smoke` จะมีข้อความแสดงในคอนโซล:
     ```text
     [LINE Reply API Error]: {
       message: 'Authentication failed. Confirm that the access token in the authorization header is valid.'
     }
     ```
   * **พฤติกรรมนี้เป็นเรื่องปกติ:** เกิดขึ้นเนื่องจากในสภาพแวดล้อมทดสอบใช้โทเคนจำลอง (`test-channel-access-token`) ซึ่งเมื่อส่งคำขอไปยังเซิร์ฟเวอร์ LINE จริงจะถูกปฏิเสธ โดยระบบ Backend ได้ครอบ `catch` ไว้เรียบร้อยแล้ว ไม่ส่งผลกระทบต่อกระบวนการทำงานหลักในฐานข้อมูลและ API
2. **การชนกันของเลขที่ใบสั่งซ่อมและการข้ามลำดับ Sequence ขณะเปิดงานพร้อมกัน (Concurrency Collision):**
   * ในการทดสอบเปิดใบสั่งซ่อมพร้อมกันจำนวนมากในเสี้ยววินาทีเดียวกัน (`test:concurrency`) จะมีข้อความแจ้งเตือน `Unique constraint failed on the constraint: RepairOrder_jobNumber_key` ปรากฏในคอนโซล
   * **พฤติกรรมนี้เป็นกลไกที่ถูกต้องของระบบ:** เนื่องจากระบบใช้หมายเลขใบงานรูปแบบ `REP-YYMM-XXXX` ซึ่งคำนวณจาก Sequence สูงสุดในขณะนั้น เมื่อเกิดคำขอพร้อมกัน Prisma Transaction จะตรวจพบการชนกัน และกลไก Retry Loop ใน `RepairService.createRepairOrder` จะทำการ Rollback และคำนวณ Sequence ถัดไปใหม่อัตโนมัติจนสำเร็จครบทุกรายการ (ผลลัพธ์คือทุกงานได้รับ Job Number ที่ไม่ซ้ำกันอย่างถูกต้อง แต่อาจมีหมายเลข Sequence บางลำดับถูกข้ามไปอันเนื่องมาจากการ Rollback)
