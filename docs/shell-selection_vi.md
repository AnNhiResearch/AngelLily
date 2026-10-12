# Lựa chọn Shell

Tài liệu này giải thích cách Angel Lily quyết định shell nào sẽ chạy các lệnh do AI đề xuất, và điều gì xảy ra khi không tìm thấy shell phù hợp.

## Luật (Windows)

Luật cố định và xác định — không đoán, không dò môi trường:

| Ưu tiên | Shell | File thực thi | Khi nào |
| ------- | ----- | ------------- | ------- |
| 1 | PowerShell 7 | `pwsh.exe` | Được cài trên máy (kiểm tra qua `PATH`) |
| 2 | Windows PowerShell 5.1 | `powershell.exe` | Máy không có `pwsh.exe` |
| 3 | — | — | Không có cả hai → **khởi động thất bại, báo lỗi** |

- `cmd.exe` **không bao giờ** được dùng, trong mọi tình huống.
- Lệnh được thực thi với `-NoProfile` để profile cá nhân không can thiệp hay làm chậm.
- Nếu không tìm thấy file thực thi nào của PowerShell, bot từ chối khởi động và in ra (thông báo lỗi của hệ thống luôn bằng tiếng Anh):

```
No PowerShell found on this machine. Install PowerShell (pwsh.exe or powershell.exe) so the bot can run commands.
```

## Luật (Termux / macOS / Linux)

| Môi trường | Cách phát hiện | Shell dùng |
| ----------- | -------------- | ---------- |
| Termux | Biến môi trường `TERMUX_VERSION`, hoặc `PREFIX` chứa `com.termux` | `/bin/sh` |
| macOS | `process.platform === 'darwin'` | `/bin/sh` |
| Linux | mọi trường hợp còn lại | `/bin/sh` |

## Vì sao pwsh được ưu tiên khi cả hai đều có

PowerShell 7 là shell hiện đại, được bảo trì liên tục. Dùng nó bất cứ khi nào có sẵn để có:

- cú pháp hiện đại, nhất quán để AI viết lệnh;
- không phụ thuộc việc người dùng khởi động `npm start` từ terminal nào — lựa chọn không bao giờ đổi giữa các lần chạy trên cùng một máy.

Môi trường được chọn sẽ được báo lúc khởi động:

```
Shell environment: PowerShell 7 (pwsh) — PowerShell syntax
```

và được đưa vào system prompt của AI, để LLM luôn viết lệnh bằng đúng cú pháp.

## Các module liên quan

- `src/shell.ts` — phát hiện môi trường và thực thi lệnh (tài liệu này).
- `src/telegram.ts` — giao diện phê duyệt: mọi lệnh đề xuất đều được hiển thị cho người dùng với nút **Chạy / Hủy** trước khi thực thi (nhãn nút theo `BOT_LANGUAGE`).
- `src/ai.ts` — giao thức `<cmd>...</cmd>` mà LLM dùng để yêu cầu chạy lệnh.
