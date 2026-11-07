# Homglai Service Core

ระบบติดตามงานซ่อมเครื่องชงกาแฟ (Core Service Backend Monorepo) สำหรับบริหารจัดการรับเครื่อง ประเมินอาการ จัดคิวช่าง เสนอราคาอะไหล่ และแจ้งเตือนสถานะงานซ่อมแบบเรียลไทม์

---

## 1. สถานะปัจจุบันของโปรเจ็ค

* **Backend (`apps/api`):** ทำครบตามแผน 9 phase ของ SRS v2.2 และชุดทดสอบอัตโนมัติ 18 ชุดผ่านทั้งหมดบนฐานข้อมูล `*_test` ครอบคลุม:
  * ยืนยันตัวตนและสิทธิ์ตามบทบาท (RBAC)
  * รับเครื่องตามใบกระดาษ (เลขเล่ม/เลขที่ใบรับ, ประกัน, อุปกรณ์ที่ให้มา)
  * คิวช่างแบบจองงาน (`RESERVED`) แล้วกดรับงาน
  * ยืนยันราคาทางโทรศัพท์รายรายการ, ส่งงานซ่อม, ปุ่ม "ยังซ่อมอยู่", ปิดงานแบบ "ลูกค้าไม่ซ่อม", บันทึกรับเงิน
  * วันหยุดร้านและวันหยุดประจำสัปดาห์ของช่าง
  * ค้นหาสถานะสาธารณะแบบ whitelist (PDPA), SSE, ผูก LINE ต่อใบงาน
  * รูปถ่ายใบงาน (ลบอัตโนมัติ 30 วันหลังปิดงาน)
  * แจ้งเตือนพนักงานในเว็บ และงานเบื้องหลัง (เตือนไม่กดรับ, เตือนความคืบหน้า, ตาข่ายคืนงาน, ลบรูป)
* **ยังไม่เคยขึ้นระบบจริง:** ยังไม่ได้ทดสอบกับ LINE OA จริงผ่าน HTTPS และยังไม่มีหน้าเว็บ (ดูข้อ 12)
* **Database Package (`packages/db`):** Prisma Schema และ SQL Migrations 7 ชุด ทุกชุดเป็นแบบเพิ่มอย่างเดียวหรือ Safe 3-Step และมีเทสต์ย้ายข้อมูลเดิม
* **Frontend (`apps/web`):** ยังเป็น **Placeholder** (Next.js 15 Starter) แยก deploy ต่างหาก หน้าเว็บควรแสดงปุ่มตาม `allowedActions` ที่ API ส่งมา

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
* **รูปถ่าย:** `multer` (รับไฟล์ในหน่วยความจำ) + `sharp` (ตรวจชนิดไฟล์จากเนื้อจริง ตัด EXIF ย่อรูป)
* **งานเบื้องหลัง:** ตัวตั้งเวลาในตัว API server (`setInterval`) ไม่ต้องใช้ cron หรือ worker แยก

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

**ข้อมูลสำหรับเดโม (ไม่บังคับ):** เพิ่มรายการอาการเสียของเครื่องชง/เครื่องบด/เครื่องปั่น และบัญชีหน้าร้าน 1 คน ช่าง 3 คน ทำซ้ำได้ ไม่ลบและไม่แก้ข้อมูลเดิม
```bash
SEED_DEMO_PASSWORD="<รหัสอย่างน้อย 12 ตัว>" pnpm --filter @homglai/api seed:demo
```
หลังจากนั้นแอดมินเพิ่ม/แก้รายการอาการได้เองผ่าน `/api/symptoms`

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
| `LINE_LOGIN_CHANNEL_ID` | สำหรับ LIFF | Channel ID ของ LINE Login ที่ LIFF ใช้ server ใช้ตรวจว่า access token ออกให้ช่องนี้ (`LINE_IDENTITY_VERIFIER=mock` ใช้ได้เฉพาะ `NODE_ENV=test`) | `1234567890` |
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
| `POST` | `/api/auth/login` | Public (Rate Limited) | เข้าสู่ระบบพนักงาน ตรวจสอบ Username/Password และคืนค่า JWT Token (จำกัด 10 ครั้งต่อ 15 นาทีต่อ IP) |
| `POST` | `/api/auth/change-password` | ทุก Role (Authenticated) | เปลี่ยนรหัสผ่านของตนเอง (ต้องระบุ `oldPassword` และ `newPassword` อย่างน้อย 12 ตัวอักษร) |
| `POST` | `/api/employees` | `ADMIN` | สร้างบัญชีพนักงานใหม่ (ระบุ username, name, password, role) |
| `GET` | `/api/employees` | `ADMIN` | ดึงรายชื่อพนักงานทั้งหมดในระบบ |
| `PATCH` | `/api/employees/:id` | `ADMIN` | แก้ไขข้อมูลพนักงาน เปลี่ยน Role หรือระงับการใช้งานชั่วคราว (`isActive: false`), ตั้งวันหยุดประจำสัปดาห์ `weeklyDayOff` (0=อาทิตย์…6=เสาร์, `null`=ไม่มี วันนั้นไม่นับเวลาเตือนของงานช่างคนนั้น) — ถ้าเป็นช่าง ใบงานที่ถืออยู่ทุกขั้น (ยกเว้น `COMPLETED`) กลับกองกลางหัวคิวและจ่ายต่อทันที |
| `POST` | `/api/employees/:id/reset-password` | `ADMIN` | รีเซ็ตรหัสผ่านพนักงานเป็นค่าใหม่ |
| `PATCH` | `/api/employees/:id/status` | `ADMIN`, เจ้าของบัญชี | อัปเดตสถานะการทำงานพนักงาน (`AVAILABLE`, `BUSY`, `OFFLINE`) พร้อมทริกเกอร์ระบบจัดคิวงานอัตโนมัติ (`assignedOrder` รวมงานที่จองไว้รอกดรับ, ช่างที่ `RESERVED` เปลี่ยนสถานะเองไม่ได้ ตอบ 409, ช่างจะไม่ได้รับ `trackingToken`) |
| `POST` | `/api/repairs` | `RECEPTIONIST`, `ADMIN` | สร้างใบสั่งซ่อมใหม่ (สถานะเริ่มต้น `NEW`) ตามใบกระดาษ บันทึกข้อมูลลูกค้า เครื่อง และอาการเสีย ถ้ามีช่างว่าง ระบบจองงานให้ช่างที่ว่างนานสุด (ช่าง `RESERVED` ได้แจ้งเตือนและต้องกดรับ) |
| `GET` | `/api/repairs` | ทุก Role (Authenticated) | ค้นหาและแบ่งหน้าใบสั่งซ่อม (รองรับ Query: `status`, `technicianId`, `search` สูงสุด 100 ตัวอักษร, `page`, `limit`; ค้นด้วยเลขใบงาน/เลขใบกระดาษ/เลขเล่ม/เบอร์/ชื่อลูกค้า; ช่างเห็นเฉพาะงานที่จ่ายให้ตนเอง ไม่เห็นงาน `NEW` ที่ยังไม่มีเจ้าของ; `awaitingAck=true` = งานที่จ่ายแล้วรอกดรับ พร้อม `assignedAt`, `waitingMinutes`; `needsProgressUpdate=true` = งานที่ต้องอัปเดต (นิ่งเกินกำหนดในเวลาทำการ) พร้อม `idleBusinessMinutes`) |
| `GET` | `/api/repairs/:id` | `ADMIN`, `RECEPTIONIST`, ช่างที่รับผิดชอบ | ดูรายละเอียดใบสั่งซ่อมแบบเจาะลึก (ช่างไม่ได้รับ `trackingToken`, ทุก Role ไม่ได้รับ `customer.lineUserId` แต่ได้ `customer.lineLinked`) พร้อม `payment` และ `allowedActions` = ปุ่มที่ผู้เรียกกดได้กับใบงานนี้ หน้าเว็บแสดงปุ่มตามรายการนี้เท่านั้น |
| `PATCH` | `/api/repairs/:id` | `RECEPTIONIST`, `ADMIN` | แก้ข้อมูลรับเครื่อง (ใบกระดาษ/ลูกค้า/เครื่อง/อาการ/ประกัน/อุปกรณ์ ฯลฯ) ห้ามแก้สถานะ/ช่าง/เลขใบงาน และห้ามแก้ใบงานที่ปิดแล้ว |
| `POST` | `/api/repairs/:id/accept` | ช่างที่ได้รับจ่าย, `ADMIN` (กดแทน) | กดรับงานที่จองไว้ (`NEW` → `INSPECTING`, ช่าง `RESERVED` → `BUSY`; งานที่ถูกส่งกลับจากช่างที่ลาออกจะกลับไปขั้นที่ค้าง) |
| `POST` | `/api/repairs/:id/release` | `ADMIN` | ปล่อยงานที่จองไว้แต่ยังไม่กดรับคืนกองกลาง (ช่างกลับ `AVAILABLE`) แล้วรันคิวใหม่ |
| `POST` | `/api/repairs/:id/complete` | ช่างที่ได้รับจ่าย, `ADMIN` | ส่งงานซ่อม (`REPAIRING` → `COMPLETED`) พร้อม `completionSummary` และเลือก `helperTechnicianIds` (ช่างผู้ช่วย ไม่บังคับ) ช่างกลับว่างและรับงานถัดไป; `outcome: NOT_REPAIRED` = ลูกค้าไม่ซ่อม ปิดได้จาก `INSPECTING`/`REPAIRING` แล้วส่งมอบคืนตามปกติ |
| `POST` | `/api/repairs/:id/still-working` | ช่างที่ได้รับจ่าย, `ADMIN` | ปุ่ม "ยังซ่อมอยู่" รีเซ็ตตัวจับเวลาเตือนความคืบหน้า |
| `PUT` | `/api/repairs/:id/helpers` | `RECEPTIONIST`, `ADMIN` | แก้รายชื่อช่างผู้ช่วยของใบงาน (บันทึกไว้ดูอย่างเดียว) จนกว่าจะส่งมอบ/ยกเลิก |
| `POST` | `/api/repairs/:id/images` | ตามประเภทรูป | อัปโหลดรูป (multipart: `files` หลายไฟล์ + `kind`) `INTAKE`/`RECEIPT_PAPER` = หน้าร้าน/แอดมิน, `DELIVERY`/`OTHER` = ช่างเจ้าของงาน/หน้าร้าน/แอดมิน รับเฉพาะ JPEG/PNG/WebP (ตรวจจากเนื้อไฟล์, HEIC → 415) ตัด EXIF/GPS ย่อด้านยาว ≤ `IMAGE_MAX_LONG_EDGE` เก็บเป็น JPEG ≤ `IMAGE_MAX_PER_KIND` รูปต่อประเภท ไฟล์เกิน `IMAGE_MAX_BYTES` → 413 |
| `GET` | `/api/repairs/:id/images` | `ADMIN`, `RECEPTIONIST`, ช่างที่รับผิดชอบ | รายการรูป (`id`, `kind`, `uploadedBy`, `createdAt`) ไม่มี path ของไฟล์ |
| `GET` | `/api/repairs/:id/images/:imageId` | `ADMIN`, `RECEPTIONIST`, ช่างที่รับผิดชอบ | ดาวน์โหลดรูป (`image/jpeg`, `Cache-Control: private, no-store`) รูปต้องเป็นของใบงานนั้น ไม่มีลิงก์สาธารณะ |
| `PUT` | `/api/repairs/:id/payment` | `RECEPTIONIST`, `ADMIN` | บันทึก/แก้ไขการรับเงิน (`amount`, `method` CASH/TRANSFER/OTHER, `note`) ของงาน `COMPLETED`/`DELIVERED` บันทึกอย่างเดียว ไม่บังคับ; ส่งพร้อม `PATCH /status` → `DELIVERED` ได้ด้วยฟิลด์ `payment` ระบบเตือน (ไม่บล็อก) ถ้ายังไม่บันทึกหรือยอดไม่ตรงกับยอดที่ต้องชำระ (รายการ APPROVED+COMPLETED) |
| `GET` | `/api/holidays` | ทุก Role | รายการวันหยุดพิเศษของร้าน (`from`, `to`) วันเหล่านี้ไม่นับเวลาเตือน |
| `POST` | `/api/holidays` | `ADMIN` | เพิ่มวันหยุดพิเศษ 1 วัน หรือช่วงติดกัน (`date`, `toDate` ≤31 วัน, `name`) วันที่ซ้ำตอบ 409 |
| `DELETE` | `/api/holidays/:id` | `ADMIN` | ลบวันหยุดพิเศษ |
| `POST` | `/api/repairs/:id/items` | `ADMIN`, ช่างที่รับผิดชอบ | เพิ่มรายการเสนอราคาอะไหล่/บริการ (เปลี่ยนสถานะใบซ่อมเป็น `WAITING_APPROVAL` อัตโนมัติ, ช่างไม่ได้รับ `trackingToken`) |
| `PATCH` | `/api/repairs/:id/items/:itemId/status` | `RECEPTIONIST`, `ADMIN`, ช่างที่ได้รับจ่าย | บันทึกผลยืนยันราคาทางโทรศัพท์รายรายการ (`APPROVED`/`REJECTED` + `note` ≤500) ระบบเก็บผู้กด เวลา ช่องทาง `PHONE` |
| `PATCH` | `/api/repairs/:id/items/:itemId/complete` | `ADMIN`, ช่างที่รับผิดชอบ | ทำเครื่องหมายรายการซ่อมที่อนุมัติแล้วว่าดำเนินการซ่อมเสร็จสิ้น (`COMPLETED`, ช่างไม่ได้รับ `trackingToken`) |
| `GET` | `/api/notifications` | ทุก Role (Authenticated) | แจ้งเตือนของตนเองในเว็บ (Query: `unreadOnly`, `page`, `limit`) |
| `PATCH` | `/api/notifications/:id/read` | เจ้าของแจ้งเตือน | ทำเครื่องหมายว่าอ่านแล้ว (ของคนอื่นตอบ 404) |
| `PATCH` | `/api/repairs/:id/status` | ทุก Role (ตามเงื่อนไข State Machine) | เปลี่ยนสถานะใบสั่งซ่อม (ช่างเปลี่ยนได้เฉพาะงานตนเอง และส่งมอบ/ยกเลิกไม่ได้ — เป็นหน้าที่หน้าร้าน/แอดมิน, ช่างไม่ได้รับ `trackingToken`, `ADMIN`/`RECEPTIONIST` ได้รับตามปกติ; ตีกลับ `COMPLETED`→`REPAIRING` (กดโดย `RECEPTIONIST`/`ADMIN` เท่านั้น ช่างกดไม่ได้): งานกลับเป็น `NEW` จองให้ช่างเดิมถ้าว่าง ไม่ว่างเข้าคิวลำดับแรก ช่างได้แจ้งเตือน "งานตีกลับซ่อมใหม่" และต้องกดรับ แล้วงานกลับไป `REPAIRING`) |
| `GET` | `/api/symptoms` | ทุก Role (Authenticated) | ดึงรายการหมวดหมู่อาการเสียและอาการเสียย่อยทั้งหมด |
| `POST` | `/api/symptoms/categories` | `ADMIN` | เพิ่มหมวดอาการ (`name` ≤100 ชื่อซ้ำตอบ 409) |
| `PATCH` / `DELETE` | `/api/symptoms/categories/:id` | `ADMIN` | เปลี่ยนชื่อหมวด / ลบหมวดที่ว่างแล้ว (ยังมีอาการอยู่ตอบ 409) |
| `POST` | `/api/symptoms` | `ADMIN` | เพิ่มอาการในหมวด (`name`, `categoryId`; ชื่อซ้ำในหมวดเดียวกันตอบ 409) |
| `PATCH` / `DELETE` | `/api/symptoms/:id` | `ADMIN` | เปลี่ยนชื่อ/ย้ายหมวด / ลบอาการที่ยังไม่เคยใช้ในใบงาน (ใช้แล้วตอบ 409 ให้เปลี่ยนชื่อแทน) |
| `POST` | `/api/tracking/search` | Public (Rate Limited) | ค้นหาสถานะด้วยเลขเดียว (`REP-YYMM-NNNN` หรือเลขใบรับเครื่องตัวเลข 1–10 หลัก ไม่รับเบอร์โทร) ตอบเฉพาะ whitelist: เลขใบงาน สถานะ ป้ายไทย วันรับเครื่อง ยี่ห้อ/รุ่น timeline ไม่พบทุกกรณีตอบ 404 body เดียวกัน จำกัด `PUBLIC_SEARCH_RATE_LIMIT_MAX` ครั้ง/15 นาที/IP |
| `POST` | `/api/tracking/subscribe-line` | Public (Rate Limited) | ลูกค้าผูกบัญชี LINE กับใบงาน (จาก LIFF) ด้วย `query`, `phone`, `lineAccessToken` server ตรวจ token กับ LINE เอง (`LINE_LOGIN_CHANNEL_ID`) ผิดทุกกรณีตอบข้อความเดียวกัน ผูกซ้ำได้ 1 บัญชีหลายใบงาน / 1 ใบงานหลายบัญชี จำกัด 10 ครั้ง/15 นาที/IP |
| `GET` | `/api/tracking/stream/:trackingToken` | Public | สตรีมสถานะงานซ่อมแบบเรียลไทม์ด้วย Server-Sent Events (SSE) โดยใช้ `trackingToken` ของใบสั่งซ่อม แต่ละ event มีแค่ `{ status, updatedAt }` |
| `POST` | `/api/webhook/line` | Public (ตรวจสอบ Signature) | รับ Webhook Event จาก LINE Messaging API สำหรับการผูกบัญชี LINE กับใบงาน (พิมพ์ `<เลขใบงานหรือเลขใบรับเครื่อง> <เบอร์โทร>` ผิดเกิน 5 ครั้ง/15 นาทีต่อบัญชีจะถูกพักไว้) และการกดปุ่มอนุมัติ/ปฏิเสธใบเสนอราคาผ่าน Postback (ปิดไว้ตาม `CUSTOMER_LINE_APPROVAL_ENABLED`) ลูกค้าที่ผูกไว้ได้ข้อความ LINE ทุกครั้งที่สถานะเปลี่ยน (ไม่มีราคา/รายการ) |

---

## 8. กฎของ RepairStatus และสถานะช่าง (State Machine)

### 8.1 สถานะใบงาน

```mermaid
stateDiagram-v2
    [*] --> NEW: เปิดใบงาน (หน้าร้าน/แอดมิน)
    NEW --> NEW: ระบบจองให้ช่างที่ว่างนานสุด (ช่าง RESERVED)
    NEW --> INSPECTING: ช่างกดรับงาน (POST /accept)
    NEW --> CANCELLED: ยกเลิก (หน้าร้าน/แอดมิน)

    INSPECTING --> WAITING_APPROVAL: ช่างเพิ่มรายการเสนอราคา
    INSPECTING --> REPAIRING: เริ่มซ่อม (ไม่ต้องเสนอราคา)
    INSPECTING --> COMPLETED: ปิดงาน "ลูกค้าไม่ซ่อม" (outcome NOT_REPAIRED)
    INSPECTING --> CANCELLED: ยกเลิก

    WAITING_APPROVAL --> REPAIRING: ยืนยันทางโทรศัพท์ครบ มีอนุมัติ ≥ 1 รายการ
    WAITING_APPROVAL --> INSPECTING: ทุกรายการถูกปฏิเสธ
    WAITING_APPROVAL --> CANCELLED: ยกเลิก

    REPAIRING --> WAITING_APPROVAL: พบอาการเพิ่ม เสนอราคาใหม่
    REPAIRING --> COMPLETED: ส่งงานซ่อม (POST /complete)
    REPAIRING --> CANCELLED: ยกเลิก

    COMPLETED --> DELIVERED: ส่งมอบ (หน้าร้าน/แอดมิน)
    COMPLETED --> NEW: งานตีกลับ (หน้าร้าน/แอดมิน) จองช่างแล้วรอกดรับ -> REPAIRING

    DELIVERED --> [*]
    CANCELLED --> [*]
```

กฎที่บังคับในโค้ด (`src/config/repair-status.ts`, `repair.service.ts`):
1. **เปลี่ยนเป็นสถานะเดิมไม่ได้:** ตอบ `409` และไม่บันทึก StatusLog ซ้ำ
2. **ตั้ง `INSPECTING` / `WAITING_APPROVAL` ตรงๆ ไม่ได้:** `INSPECTING` เกิดจากการกดรับงานเท่านั้น `WAITING_APPROVAL` เกิดจากการเพิ่มรายการเสนอราคาเท่านั้น
3. **ออกจาก `WAITING_APPROVAL` ไม่ได้ถ้ายังมีรายการ `PENDING`:** เมื่อบันทึกผลรายการสุดท้าย ถ้าอนุมัติอย่างน้อย 1 รายการ ระบบเปลี่ยนเป็น `REPAIRING` เอง ถ้าปฏิเสธทั้งหมดกลับเป็น `INSPECTING`
4. **ส่งงานซ่อม (`COMPLETED`):** ทำผ่าน `POST /complete` (ADMIN ที่ PATCH เป็น `COMPLETED` ก็ใช้เส้นทางเดียวกัน) ช่าง PATCH เองไม่ได้ ต้องมีสรุปงาน และทุกรายการ `APPROVED` ต้องทำเครื่องหมายเสร็จแล้ว ถ้า `outcome: NOT_REPAIRED` ปิดได้จาก `INSPECTING`/`REPAIRING` เมื่อไม่มีรายการรออนุมัติ หน้าสาธารณะไม่แสดงว่า "ซ่อมเสร็จ"
5. **งานตีกลับ (`COMPLETED` → `REPAIRING`):**
   * กดได้เฉพาะ `RECEPTIONIST` หรือ `ADMIN`
   * ใบงานกลับเป็น `NEW` และจองให้ช่างเดิมถ้าว่าง ถ้าไม่ว่างจะเข้าหัวคิว
   * ช่างได้แจ้งเตือนและต้องกดรับงาน แล้วงานจึงกลับไป `REPAIRING`
6. **ส่งมอบ / ยกเลิก:** เป็นหน้าที่ของหน้าร้านและแอดมิน ช่างทำไม่ได้ ตอนส่งมอบบันทึกรับเงินได้ (ระบบเตือน แต่ไม่บล็อก) และระบบตั้ง `closedAt`
7. **`DELIVERED` / `CANCELLED` เป็นสถานะสิ้นสุด:** เปลี่ยนต่อไม่ได้ และแก้ข้อมูลรับเครื่องไม่ได้

### 8.2 สถานะช่างและคิวงาน
* สถานะช่าง: `AVAILABLE` (ว่าง) → `RESERVED` (มีงานจองไว้ รอกดรับ) → `BUSY` (กำลังทำงาน) / `OFFLINE`
* **ลำดับงานในคิว:** งานที่ยังไม่มีช่างจ่ายตาม `queuePriority` ก่อน (งานตีกลับ และงานที่คืนจากช่างที่ออกไป อยู่หัวคิว) แล้วจึงตามลำดับเวลาเปิดใบงาน
* **การเลือกช่าง:** ระบบให้งานช่าง `AVAILABLE` ที่ว่างนานที่สุดก่อน (`availableSince`)
* **ช่างที่ `RESERVED`:** เปลี่ยนสถานะตัวเองไม่ได้ (ตอบ `409`) งานที่ไม่กดรับจะไม่ถูกย้ายไปช่างคนอื่นเอง ระบบเตือน ADMIN แทน ADMIN กดรับแทนหรือปล่อยงานคืน (`/release`) ได้
* **ปิดบัญชีหรือเปลี่ยนบทบาทช่าง:** ใบงานที่ช่างถืออยู่ทุกขั้น (ยกเว้น `COMPLETED`) กลับหัวคิวทันที และงานเบื้องหลังตรวจซ้ำเป็นตาข่ายสำรอง
* **ความปลอดภัยเมื่อมีคำขอพร้อมกัน:** ทุกการจองและการกดรับใช้ conditional update จึงไม่มีงานซ้อนหรือช่างซ้อน (ทดสอบใน `test:concurrency` และ `test:queue`)
* **ล็อกแถวใบงาน (`utils/order-lock.ts`):** ทำรายการเสร็จ, อัปโหลดรูป, บันทึกรับเงิน และแก้ช่างผู้ช่วย ล็อกใบงาน (`SELECT … FOR UPDATE`) ก่อนตรวจเงื่อนไข การกดพร้อมกันจึงทำทีละคน (ทดสอบใน `test:races`)

---

## 9. สิทธิ์ตามบทบาท (Role-Based Access Control & Data Privacy)

### สิทธิ์ของแต่ละบทบาท (ดูรายละเอียดราย endpoint ในข้อ 7)
* **`ADMIN`:**
  * ทำได้ทุกอย่าง รวมถึงจัดการพนักงาน วันหยุดร้าน และวันหยุดประจำสัปดาห์ของช่าง
  * กดรับงานแทนช่าง ปล่อยงานที่จองไว้คืนกองกลาง และส่งงานซ่อมแทนช่าง
  * เห็น `trackingToken`
* **`RECEPTIONIST` (หน้าร้าน):**
  * เปิดและแก้ข้อมูลรับเครื่อง อัปโหลดรูปรับเครื่องและรูปใบกระดาษ
  * บันทึกผลยืนยันราคาทางโทรศัพท์
  * ส่งมอบ ยกเลิก กดงานตีกลับ บันทึกรับเงิน แก้รายชื่อช่างผู้ช่วย
  * เห็นทุกใบงานและเห็น `trackingToken`
* **`TECHNICIAN` (ช่าง):**
  * เห็นเฉพาะใบงานที่จ่ายให้ตนเอง (รวมงานที่จองไว้รอกดรับ) ไม่เห็นงานในกองกลางหรืองานของช่างคนอื่น
  * กดรับงาน เพิ่มรายการเสนอราคา บันทึกผลยืนยันทางโทรศัพท์ ทำเครื่องหมายรายการเสร็จ ส่งงานซ่อม กด "ยังซ่อมอยู่"
  * อัปโหลดรูป `DELIVERY`/`OTHER` ของงานตนเอง
  * ส่งมอบ ยกเลิก หรือกดงานตีกลับไม่ได้ และไม่ได้รับ `trackingToken`
* **Public (ลูกค้า):**
  * ค้นหาสถานะด้วยเลขใบงานหรือเลขใบรับเครื่อง
  * ดู SSE ด้วย `trackingToken`
  * ผูก LINE กับใบงานโดยยืนยันเบอร์โทร

### นโยบายความเป็นส่วนตัว (PDPA)
1. **ช่างไม่ได้รับ `trackingToken`:** `sanitizeForRole` ตัดฟิลด์นี้ออกทุกระดับชั้นของ response สำหรับ `TECHNICIAN`
2. **ไม่ส่ง `lineUserId` ออกทาง API ให้ใครเลย:** บัญชี LINE ผูกกับใบงาน (`OrderLineSubscription`) และ API ส่งเพียง `customer.lineLinked` (true/false)
3. **API สาธารณะ (`/api/tracking/*`) ใช้ whitelist:** ส่งเพียงเลขใบงาน สถานะ ป้ายไทย วันรับเครื่อง ยี่ห้อ/รุ่น และ timeline
   * ไม่มีชื่อ เบอร์ ที่อยู่ ช่าง ราคา รายการ หมายเหตุ token serial หรือรูป
   * ค้นไม่เจอทุกกรณีตอบ 404 body เดียวกัน
   * SSE ส่งแค่ `{ status, updatedAt }`
   * ข้อความ LINE ถึงลูกค้าไม่มีราคาหรือรายการ
4. **รูปถ่ายไม่มีลิงก์สาธารณะ:** ไม่ส่ง path ไฟล์ออกทาง API และลบอัตโนมัติ `IMAGE_RETENTION_DAYS` วันหลังปิดงาน (ดูหัวข้อรูปถ่าย)

---

## 10. การทดสอบระบบ (Automated Test Suites)

ชุดคำสั่งสำหรับรันการทดสอบทั้งหมดมีอยู่ใน `package.json` สามารถสั่งรันได้ดังนี้:

### คำสั่งรันชุดทดสอบ:
รันทั้งหมด (แนะนำ) — สร้าง/อัปเดตฐานข้อมูล `homglai_db_test`, build, seed, เปิด API ที่พอร์ต 4000 (`JOBS_ENABLED=false`) แล้วรัน 18 ชุดตามลำดับ:
```bash
pnpm --filter @homglai/api test:all
```

| # | คำสั่ง | ตรวจอะไร |
| :---: | :--- | :--- |
| 1 | `test:timezone` | เลขใบงาน YYMM ตามเวลาไทยแม้ server เป็น UTC |
| 2 | `test:business-hours` | นับนาทีเวลาทำการ ข้ามคืน วันหยุดร้าน วันหยุดช่าง |
| 3 | `test:config` | ค่า env ผิดรูปแบบ server ไม่ยอมสตาร์ท |
| 4 | `test:swagger` | ทุก route มี Swagger และ Swagger ไม่มี route ที่ไม่มีจริง |
| 5 | `test:migration` | Safe 3-step migration กับฐานข้อมูลเปล่าและข้อมูลเดิม ≥ 5 แถว |
| 6 | `test:smoke` | เส้นทางหลัก + 400/401/403/409, ซ่อน token, webhook signature |
| 7 | `test:concurrency` | เปิดงานพร้อมกัน 20 ใบ, แย่งคิว 20 รอบ, อนุมัติพร้อมกัน |
| 8 | `test:intake` | รับเครื่องตามใบกระดาษ, RepairItem v2, การมองเห็นของช่าง |
| 9 | `test:symptoms` | ADMIN จัดการหมวดและรายการอาการเสีย, ห้ามลบอาการที่ใช้ในใบงานแล้ว |
| 10 | `test:notifications` | แจ้งเตือนพนักงานและ `/api/notifications` |
| 11 | `test:queue` | จองงาน/กดรับ/ปล่อยงาน/คืนงานเมื่อช่างออก |
| 12 | `test:pricing` | ยืนยันราคาทางโทรศัพท์, ส่งงานซ่อม, ช่างผู้ช่วย, "ยังซ่อมอยู่" |
| 13 | `test:shop-rules` | เลขใบงาน, วันหยุด, ลูกค้าไม่ซ่อม, รับเงิน, `allowedActions` |
| 14 | `test:images` | อัปโหลด/ดาวน์โหลดรูป, สิทธิ์/IDOR, ลบรูปหมดอายุ |
| 15 | `test:jobs` | งานเบื้องหลังด้วยเวลาจำลอง |
| 16 | `test:races` | กดพร้อมกันบนใบงานเดียว: รายการเสร็จ, อัปรูปชนโควตา, รับเงินพร้อมงานตีกลับ, แก้ช่างผู้ช่วย |
| 17 | `test:e2e` | เส้นทางเต็มตามใบตัวอย่าง เล่ม 112 เลขที่ 5595 ตั้งแต่เปิดบิลจนลบรูป |
| 18 | `test:privacy` | ค้นหาสาธารณะ whitelist, SSE, ผูก LINE, rate limit (รันท้ายสุดเพราะใช้โควตาค้นหาจนหมด) |

ชุด 6–18 ต้องมี API ที่ test-runner เปิดไว้ จึงควรรันผ่าน `test:all`

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
   * ไฟล์ backup ของโฟลเดอร์รูปต้องไม่เก็บนานกว่า `IMAGE_RETENTION_DAYS` หลังปิดงาน
6. **โฟลเดอร์รูป (`IMAGE_STORAGE_DIR`) ต้องเป็น volume แยกจาก container:** ไม่อย่างนั้นรูปหายเมื่อสร้าง container ใหม่
7. **งานเบื้องหลัง:** เปิดไว้ (`JOBS_ENABLED=true`) อย่างน้อยหนึ่ง instance ถ้าปิดทุกตัว ระบบจะไม่เตือนและไม่ลบรูป รันหลาย instance ได้โดยไม่ส่งซ้ำ

---

## 12. สิ่งที่ยังไม่ได้ดำเนินการ (Pending Roadmap)

* **หน้าเว็บ (`apps/web`):** หน้าจอหน้าร้าน หน้าจอช่าง หน้าจอแอดมิน และหน้าติดตามสถานะ/LIFF ของลูกค้า ยังไม่ได้ทำ
* **ทดสอบกับ LINE OA จริง:** ปัจจุบันทดสอบด้วย signature จำลองและ mock verifier ยังต้องทดสอบ webhook จริงผ่าน HTTPS
* **แจ้งเตือนพนักงานทาง LINE:** ตอนนี้ `NOTIFIER_DRIVER` มีแค่ `db` (แสดงในเว็บผ่าน `/api/notifications`)
* **ลูกค้าอนุมัติราคาผ่าน LINE:** มีโค้ดอยู่แต่ปิดไว้ (`CUSTOMER_LINE_APPROVAL_ENABLED=false`) ร้านยืนยันทางโทรศัพท์
* **นโยบายระยะเก็บข้อมูลลูกค้า (ชื่อ เบอร์ ที่อยู่) ตาม PDPA (SRS 8.2):** รอร้านตัดสิน ตอนนี้ลบอัตโนมัติเฉพาะรูป
* **ช่อง "We are friends" ในใบกระดาษ (SRS 8.1):** รอสอบถามหน้าร้านว่าใช้ทำอะไร ยังไม่ได้เก็บในระบบ
* **CI/CD และ backup อัตโนมัติ:** ยังไม่มี pipeline รันเทสต์อัตโนมัติ และยังไม่มีการตั้งเวลา backup ฐานข้อมูลและโฟลเดอร์รูป

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
2. **ข้อความ `Unique constraint failed on the constraint: RepairOrder_jobNumber_key` ระหว่าง `test:shop-rules`:**
   * ตั้งแต่ Phase 5b เลขใบงานมาจากตารางตัวนับ (`JobNumberSequence`) ที่ล็อกแถวต่อเดือน เปิดงานพร้อมกันจึงได้เลขเรียงติดกันไม่ข้ามและไม่ชนกัน
   * ข้อความนี้มาจากเทสต์ที่ตั้งใจทำให้ตัวนับตามหลังข้อมูลจริง แล้วตรวจว่าระบบเลื่อนตัวนับและสร้างใบงานสำเร็จเอง ไม่ใช่ข้อผิดพลาด
3. **ข้อความ `[Image Purge] keeping record …: disk busy` และ `[LINE Customer Notify Error]: LINE down`:** มาจากเทสต์ที่จำลองว่าลบไฟล์ไม่ได้หรือ LINE ล่ม เพื่อตรวจว่าระบบไม่ล้ม


## รูปถ่ายใบงาน (Phase 7, SRS 2.3)

* รูปเก็บที่โฟลเดอร์ `IMAGE_STORAGE_DIR` (ค่าเริ่มต้น `apps/api/data/uploads`) โดยฐานข้อมูลเก็บเฉพาะ path แบบ relative และไม่มี API ใดส่ง path นี้ออกไป รูปไม่มี static serving ไม่อยู่ในหน้าค้นหาสาธารณะหรือ SSE
* **ตอน deploy โฟลเดอร์รูปต้องเป็นโวลุ่ม (volume) แยกจาก container** ไม่อย่างนั้นรูปจะหายเมื่อสร้าง container ใหม่ และโฟลเดอร์นี้ถูก ignore จาก git
* ระบบลบรูปอัตโนมัติเมื่อใบงานปิด (ส่งมอบ/ยกเลิก) ครบ `IMAGE_RETENTION_DAYS` วัน (ค่าเริ่มต้น 30 วัน นับจาก `closedAt` ไม่ใช่วันอัปโหลด) ใบงานที่ยังเปิดอยู่ไม่ถูกลบ การลบทำโดยงานเบื้องหลังวันละครั้งช่วง 02:00-02:59 เวลาไทย (ดูหัวข้องานเบื้องหลังด้านล่าง)
* **ไฟล์สำรอง (backup) ของโฟลเดอร์รูปต้องไม่เก็บไว้นานกว่าระยะเก็บเดียวกัน** (30 วันหลังปิดงาน) เพื่อให้เป็นไปตาม PDPA
* หลังรูปถูกลบแล้ว **จะไม่มีรูปสภาพเครื่องไว้พิสูจน์ย้อนหลัง** ใบกระดาษยังเป็นหลักฐานหลักของร้าน
* ระบบใช้ `multer` (รับไฟล์ในหน่วยความจำ) และ `sharp` (ตรวจชนิดไฟล์จากเนื้อจริง หมุนตาม EXIF ตัด metadata ย่อรูป และกันรูปที่ใหญ่ผิดปกติเกิน 50 ล้านพิกเซล)

## งานเบื้องหลัง (Phase 8, SRS 3.6)

API server ทำงานเบื้องหลังเองทุก `JOB_WORKER_INTERVAL_SECONDS` วินาที (ค่าเริ่มต้น 60) ไม่ต้องตั้ง cron แยก ปิดได้ด้วย `JOBS_ENABLED=false` (ชุดทดสอบปิดไว้แล้วเรียก `runJobsOnce(now)` เองด้วยเวลาจำลอง) ถ้ารอบก่อนยังไม่เสร็จ รอบถัดไปจะถูกข้าม ไม่ทำซ้อน และงานแต่ละตัวพังได้โดยไม่ล้มงานอื่นในรอบเดียวกัน

ลำดับงานในแต่ละรอบ:

1. **คืนงานที่ค้างกับพนักงานที่ไม่ใช่ช่างแล้ว** (ถูกปิดบัญชีหรือเปลี่ยนบทบาทตรงในฐานข้อมูล) กลับเข้าคิวด้วย service เดียวกับ Phase 4 และแจ้งสรุปให้ ADMIN
2. **งานที่จองให้ช่างแต่ยังไม่กดรับ** เกิน `ACK_TIMEOUT_MINUTES` แจ้ง ADMIN เป็นข้อความรวมฉบับเดียว และเตือนซ้ำทุก `ACK_REMINDER_INTERVAL_MINUTES` งานไม่ถูกย้ายไปช่างคนอื่น
3. **จ่ายงานจากคิว** ให้ช่างที่ว่าง
4. **ถามช่างว่า "ยังซ่อมอยู่ไหม?"**
   * เตือนเมื่องานที่รับแล้วไม่มีความเคลื่อนไหวครบ `PROGRESS_REMINDER_INTERVAL_MINUTES` นาที
   * นับเฉพาะเวลาทำการ `BUSINESS_HOURS_START`-`BUSINESS_HOURS_END` ไม่นับวันหยุดร้านและวันหยุดประจำสัปดาห์ของช่าง และนอกเวลาทำการไม่ส่งข้อความ
   * ช่างหนึ่งคนได้ข้อความเดียวต่อรอบแม้มีหลายงาน
   * งานที่ช่างไม่ตอบครบ `PROGRESS_UNANSWERED_ADMIN_THRESHOLD` รอบ แจ้ง ADMIN ครั้งเดียวต่อใบงาน
   * กด "ยังซ่อมอยู่" หรือมีความเคลื่อนไหวอื่นแล้วตัวนับเริ่มใหม่
5. **ลบรูปหมดอายุ** วันละครั้งช่วง 02:xx เวลาไทย

การเตือนทุกแบบใช้ compare-and-set ในฐานข้อมูล จึงรันหลาย instance พร้อมกันได้โดยไม่ส่งข้อความซ้ำ ส่วนการลบรูปทำซ้ำได้โดยไม่มีผลเสีย (ถ้า restart ช่วงตี 2 อาจรันซ้ำในวันเดียวกัน ซึ่งไม่เป็นปัญหา) เมื่อได้รับ SIGTERM/SIGINT server จะหยุดตัวตั้งเวลา รอรอบที่กำลังทำให้เสร็จ แล้วจึงปิดการเชื่อมต่อฐานข้อมูล
