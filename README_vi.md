# AngelLily

Một Autonomous Agent siêu nhỏ gọn — được thiết kế để chạy ở bất cứ đâu, kể cả laptop chỉ có 4 GB RAM hay Android TV Box 1GB RAM, thông qua Termux .

## AngelLily là gì?

AngelLily là một autonomous agent theo tinh thần tương tự OpenClaw hay Hermes Agent, nhưng với ưu tiên hoàn toàn khác: **sự nhỏ gọn trên hết**.

Được viết bằng TypeScript và chạy dưới dạng một tiến trình Node.js duy nhất, siêu nhẹ, với duy nhất một dependency runtime (client OpenAI). Không dịch vụ nền, không plugin cài sẵn, không database, không lớp bộ nhớ lâu dài — chỉ có lõi agent.

## Tính năng

- **Chat Telegram với LLM.** Phản hồi streaming qua bất kỳ API tương thích OpenAI nào — đám mây hay chạy local — cấu hình bằng `OPENAI_BASE_URL` và `OPENAI_MODEL`.
- **Chỉ chủ nhân mới dùng được.** Người đầu tiên xác minh bằng `/verify`; mã OTP 6 số được in ra terminal (hiệu lực 60 giây) và phải gửi lại từ chính chat đó. Nhập sai 10 lần thì chat bị đưa vào blacklist. Không cần mật khẩu, không cần file cấu hình — ai đọc được terminal chính là chủ bot.
- **Chạy lệnh phải có người duyệt.** AI có thể đề xuất chạy lệnh shell, nhưng mọi lệnh đều hiện trong Telegram dưới dạng **Chạy / Hủy** và chỉ được thực thi sau khi được duyệt tường minh. Hook của plugin có thể sửa lệnh *trước khi* hiển thị, nên bạn luôn duyệt đúng những gì sắp chạy.
- **Chọn shell theo luật cố định.** PowerShell 7 → PowerShell 5.1 trên Windows (không bao giờ dùng `cmd.exe`), `/bin/sh` trên Termux, macOS và Linux. Môi trường được chọn được mô tả cho model để AI luôn viết lệnh đúng cú pháp — xem [docs/shell-selection_vi.md](docs/shell-selection_vi.md).
- **Plugin bên ngoài tùy chọn.** Nạp thêm lệnh và công cụ LLM cô lập trong một tiến trình Single Shared Runner — xem [docs/plugins_vi.md](docs/plugins_vi.md).
- **Persona chỉnh được.** System prompt nằm trong [.angellily/AGENTS.md](.angellily/AGENTS.md). Sửa file, khởi động lại — không cần đụng code. File nằm trong thư mục `.angellily/` để các AI coding agent (Trae, Copilot,…) không nhầm nó thành luật workspace của chúng.
- **Giao diện đa ngôn ngữ.** Các thông báo của bot (help, phê duyệt, lỗi) bằng tiếng Anh hoặc tiếng Việt qua `BOT_LANGUAGE`.
- **Bộ nhớ chỉ trong phiên.** Ngữ cảnh hội thoại nằm trong RAM của phiên hiện tại và bị xóa khi khởi động lại — không phình to theo thời gian.

## Triết lý thiết kế

- **Nhỏ gọn là ưu tiên số một.** Mọi tính năng phải chứng minh được cái giá của nó về RAM và độ phức tạp. Nếu không chạy được trên laptop 4 GB hoặc Android TV Box qua Termux, thì nó không thuộc về AngelLily.
- **Không kèm plugin.** Khác với OpenClaw, AngelLily không đi kèm bất kỳ plugin nào được cài sẵn. Cây thư mục nguồn bạn thấy chính là toàn bộ sản phẩm.
- **Không có bộ nhớ lâu dài (persistent memory).** Khác với Hermes Agent, AngelLily không giữ bộ nhớ giữa các phiên.
- **Một tiến trình, một dependency.** Một runtime, một điểm khởi chạy, một npm dependency.

## So sánh

| | AngelLily | OpenClaw | Hermes Agent |
|---|---|---|---|
| Plugin / dịch vụ nền đi kèm | Không có | Kèm hệ sinh thái plugin lớn | Tùy |
| Bộ nhớ lâu dài | Không (chỉ ngữ cảnh trong phiên) | Một phần | Có |
| Dung lượng / tài nguyên | Chạy được trên laptop 4 GB RAM / Android TV Box qua Termux | Nặng hơn | Nặng hơn |
| Ngôn ngữ | TypeScript | TypeScript | — |

## Yêu cầu

- Node.js **24 LTS (khuyên dùng)** — bot nạp `.env` bằng cờ `--env-file` có sẵn, nên `process.env` được điền trực tiếp bởi Node (không cần gói dotenv)
- > ⚠️ **Chưa dùng Node.js 26+.** Node 26 đi kèm Undici 8, làm đổi dispatcher của `fetch` toàn cục và đã gây lỗi rep chậm / lệch thứ tự tin nhắn Telegram cho bot này. Hãy dùng Node 24 LTS cả trên Windows lẫn Termux.
- Một endpoint LLM API tương thích OpenAI
- Chỉ trên Windows: **PowerShell** (`pwsh.exe` hoặc `powershell.exe`) để có thể chạy lệnh

## Bắt đầu

### Option A: npm (nhanh nhất)

Cài đặt toàn cục và chạy từ thư mục dự án:

```sh
npm install -g @angellily/app
npx @angellily/app
```

Hoặc chạy một lần không cần cài:

```sh
npx @angellily/app
```

Cả hai phương thức đều tự động tìm `.angellily/AGENTS.md` / `.env` từ thư mục hiện tại. Tạo chúng trước:

```sh
# trong thư mục dự án
npx @angellily/app --init
```

`--init` sao bản `.angellily/AGENTS.md` và `.env.example` vào thư mục dự án. Sửa `.env`, thêm token, rồi chạy `npx @angellily/app`.

### Option B: từ nguồn

1. Clone:

   ```sh
   git clone https://github.com/AnNhiResearch/AngelLily.git
   cd AngelLily
   ```

2. Cài dependencies:

   ```sh
   npm install
   ```

3. Tạo file cấu hình:

   ```sh
   cp .env.example .env
   ```

   Trên Windows (PowerShell): `Copy-Item .env.example .env`

   Điền `TELEGRAM_BOT_TOKEN` (lấy từ [@BotFather](https://t.me/BotFather)) và `OPENAI_API_KEY`. Trỏ `OPENAI_BASE_URL` và `OPENAI_MODEL` tới nhà cung cấp bất kỳ nào tương thích OpenAI.

4. Build và khởi chạy:

   ```sh
   npm run build
   npm start
   ```

5. Ghép tài khoản Telegram: gửi `/verify` cho bot, đọc mã OTP 6 số trên terminal rồi gửi lại trong vòng 60 giây. Từ đây bạn là chủ bot — mọi người khác đều bị bỏ qua.

## Cấu hình

| Biến | Mặc định | Mô tả |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *(bắt buộc)* | Token bot từ @BotFather |
| `OPENAI_API_KEY` | *(bắt buộc)* | API key của nhà cung cấp LLM |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Endpoint tương thích OpenAI bất kỳ |
| `OPENAI_MODEL` | `gpt-4o-mini` | Tên model gửi lên API |
| `MAX_HISTORY` | `10` | Số tin nhắn giữ mỗi chat (cũ hơn bị bỏ) |
| `BOT_LANGUAGE` | `vi` | Ngôn ngữ giao diện: `en` hoặc `vi` |

## Tùy biến persona

Danh tính và luật ứng xử của bot nằm trong [.angellily/AGENTS.md](.angellily/AGENTS.md). Sửa file, khởi động lại bot — xong. Model hiện tại được chèn tự động để agent trả lời được câu hỏi về thứ đang vận hành nó.

## Tài liệu

- [docs/plugins_vi.md](docs/plugins_vi.md) — hệ thống plugin (bản Anh: [docs/plugins.md](docs/plugins.md))
- [docs/shell-selection_vi.md](docs/shell-selection_vi.md) — cách chọn shell (bản Anh: [docs/shell-selection.md](docs/shell-selection.md))

## Giấy phép

Phân phối theo [Giấy phép Apache 2.0](LICENSE).
