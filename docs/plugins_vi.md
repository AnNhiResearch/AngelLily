# Hệ thống Plugin

AngelLily không kèm sẵn **plugin nào** — cây thư mục nguồn bạn thấy chính là toàn bộ sản phẩm. Nhưng chính vì Lily quá nhỏ, plugin là cách mở rộng mạnh nhất: một plugin có thể đụng đến **mọi thứ**, kể cả các module mặc định.

Một plugin chỉ đơn giản là một package npm (hoặc một thư mục local) export mặc định một object thuần. Khi khởi động, AngelLily nạp mọi package được liệt kê trong `plugins.json`.

## Plugin có thể làm gì

| Năng lực | Loại | Biểu hiện |
|---|---|---|
| Lệnh cho người dùng | Chủ động (người dùng) | Thêm lệnh `/name` và `#name` vào chat |
| Công cụ cho LLM | Chủ động (LLM) | LLM tự gọi công cụ khi cần, giống hệt shell có sẵn |
| System prompt bổ sung | Bị động | Được nối vào system prompt của mọi phiên |
| Hooks | Cả hai | Chặn tin nhắn vào, biến đổi tin nhắn ra, viết lại lệnh shell |

## Cài đặt plugin

```bash
npm install angellily-plugin-example
```

Rồi thêm tên package vào `plugins.json` ở thư mục gốc:

```json
["angellily-plugin-example"]
```

Thư mục local cũng được (tiện khi đang phát triển plugin):

```json
["angellily-plugin-example", "./my-plugin"]
```

Mỗi phần tử còn có thể là một object với `package` (bắt buộc) và `worker` (tùy chọn, xem [Cô lập bằng worker](#cô-lập-bằng-worker-tùy-chọn)):

```json
["angellily-plugin-example", { "package": "./my-plugin", "worker": true }]
```

Quy tắc:

- Các package được nạp theo thứ tự trong danh sách, bằng `import()` động ngay trong cùng tiến trình — trừ khi chúng bật chế độ worker.
- Plugin nạp lỗi hoặc export object không hợp lệ sẽ **bị bỏ qua kèm cảnh báo** — một plugin hỏng không bao giờ làm sập bot.
- Trùng tên plugin: plugin đầu tiên thắng, plugin sau bị bỏ qua.

## Cấu trúc plugin

```ts
// index.js của package npm "angellily-plugin-example" (ESM)
export default {
  // Bắt buộc, duy nhất. Plugin đầu tiên dùng một tên sẽ thắng.
  name: 'example',

  // Bị động: nối vào system prompt của mọi phiên.
  systemPrompt: 'Khi người dùng hỏi về thời tiết, hãy dùng công cụ weather.',

  // Lệnh: chat có thể chạy /example và #example.
  commands: [
    {
      command: 'example',           // không có tiền tố / hay #
      description: 'Trả lại các đối số',
      run: (args, ctx) => `Args: ${args} (chat ${ctx.chatId})`,
    },
  ],

  // Công cụ cho LLM: model tự gọi khi cần, giống shell có sẵn.
  tools: [
    {
      name: 'weather',              // LLM gọi qua <tool name="weather">
      description: 'Tra thời tiết theo tên thành phố',
      approval: false,              // true = hỏi chủ nhân qua inline keyboard trước
      run: async (input, ctx) => `Thời tiết tại ${input}: nắng, 32°C`,
    },
  ],

  // Hooks chạm vào các module mặc định (đều đồng bộ).
  hooks: {
    onIncoming: (text, ctx) => text,          // trả về null để nuốt tin nhắn
    onOutgoing: (text, ctx) => text,          // biến đổi tin nhắn trước khi hiển thị
    onShellCommand: (command, ctx) => command // viết lại lệnh shell trước khi phê duyệt
  },
};
```

Export mặc định cũng có thể là một hàm factory không tham số; hàm sẽ được gọi và giá trị trả về được dùng làm plugin.

## Lệnh người dùng: `/name` và `#name`

- Lệnh được gọi dạng `/name args` hoặc `#name args`; `args` là phần sau từ lệnh (đã trim), rỗng nếu không có gì.
- Lệnh chỉ dành cho **chủ nhân đã xác thực**.
- Các lệnh có sẵn `/start`, `/clear` và luồng `/verify` được xử lý trước và luôn thắng. `/xxx` lạ vẫn hiện bảng hướng dẫn; `#xxx` lạ sẽ đi tiếp đến AI như tin nhắn thường.
- Chuỗi trả về được gửi thành một tin nhắn; Telegram HTML được thử trước và fallback sang văn bản thô (giống tin nhắn AI).
- Nếu `run` ném lỗi, thông báo lỗi được gửi lại — bot vẫn chạy tiếp.

## Công cụ cho LLM (chủ động, giống shell)

Khi có ít nhất một công cụ được đăng ký, system prompt của AI sẽ có thêm phần liệt kê các công cụ và cú pháp gọi:

```
<tool name="weather">Hà Nội</tool>
```

Luồng hoạt động giống hệt shell có sẵn:

1. LLM kết thúc câu trả lời bằng đúng một khối `<tool ...>`.
2. Nếu `approval: true`, chủ nhân nhận inline keyboard (Chạy/Hủy) với mô tả dễ đọc của yêu cầu — cùng giao diện phê duyệt như lệnh shell.
3. Kết quả (hoặc thông báo từ chối) được gửi lại cho LLM như tin nhắn tiếp theo và nó tiếp tục, tối đa 5 vòng công cụ.
4. Khối công cụ được cắt khỏi phần hiển thị, và khối bị cắt ngang (thiếu đóng) được cứu theo cách khoan dung như `<cmd>`.

Lỗi ném ra từ `run` được trả về cho LLM như đầu ra của công cụ (`Lỗi công cụ: ...`), nên model có thể thích nghi thay vì làm hỏng cuộc chat.

## System prompt bổ sung (bị động)

`systemPrompt` được trim và nối lại (theo thứ tự nạp) rồi đặt sau prompt gốc. Nhờ vậy plugin có thể thay đổi hành vi của model mà không đụng vào code — ví dụ ép một nhân cách, một ngôn ngữ, hay các quy tắc định dạng thêm.

## Hooks (chạm vào module mặc định)

Mọi hook là biến đổi **đồng bộ**, áp dụng theo thứ tự nạp — hãy giữ chúng nhẹ, chúng chạy với mỗi tin nhắn:

| Hook | Khi nào | Trả về |
|---|---|---|
| `onIncoming(text)` | Ngay khi tin nhắn đến, trước khi AI thấy | Văn bản mới, hoặc `null` để nuốt tin nhắn hẳn (không gọi AI, không trả lời) |
| `onOutgoing(text)` | Ở mỗi nhịp streaming, với phần trả lời tích lũy đến thời điểm đó, trước khi hiển thị | Văn bản mới (phải là hàm thuần từ đầu vào) |
| `onShellCommand(command)` | Sau khi LLM xin chạy lệnh shell, **trước** giao diện phê duyệt | Lệnh sẽ được hiển thị và thực thi |

Lưu ý:

- `onOutgoing` nhận phần trả lời *đã tích lũy* ở mỗi nhịp, nên đừng tự cộng dồn trạng thái theo nó — hãy coi như `f(text) => text`.
- `onShellCommand` chạy trước khi phê duyệt, nên chủ nhân luôn phê duyệt đúng cái sẽ chạy.
- Hooks không chạy cho lệnh plugin (những lệnh này bỏ qua AI) hay luồng `/verify`.
- Hooks chỉ dành cho plugin chạy trong tiến trình chính; xem [Cô lập bằng worker](#cô-lập-bằng-worker-tùy-chọn).

## Cô lập bằng worker (tùy chọn)

Mặc định plugin chạy bên trong tiến trình bot — một plugin xấu có thể làm sập hoặc treo cả bot. Plugin có thể chạy trong **worker thread** riêng: một thực thể V8 tách biệt với heap và event loop của riêng nó. Crash, rò rỉ bộ nhớ hay vòng lặp vô hạn bên trong worker không bao giờ làm sập bot.

Bật cho từng plugin trong `plugins.json`:

```json
[{ "package": "angellily-plugin-example", "worker": true }]
```

Chủ nhân cũng có thể **ép** mọi plugin vào worker — kể cả những plugin không tự nguyện — bằng cách đặt `FORCE_WORKER=1` trong `.env`. Hữu ích khi muốn dùng thử một plugin chưa tin hẳn.

Điều cần biết:

- **Không cần đổi code.** Plugin được nạp y như trước, chỉ khác là nằm trong worker.
- **Được hỗ trợ:** lệnh người dùng, công cụ cho LLM, và system prompt bổ sung.
- **Không hỗ trợ: hooks.** Hooks là biến đổi đồng bộ chạy ở mỗi nhịp streaming, không thể vượt qua ranh giới thread. Plugin worker có khai báo hooks sẽ nhận cảnh báo khi khởi động và hooks của nó bị bỏ qua; hooks vẫn là tính năng dành cho plugin trong tiến trình.
- **RPC.** Host nói chuyện với worker qua `postMessage`; mỗi lệnh gọi công cụ/lệnh người dùng chờ tối đa 60 giây rồi báo lỗi timeout.
- **Chi phí.** Mỗi worker tốn vài MB RAM — worker chỉ được tạo cho những plugin cần nó.

Nếu worker chết (crash, `process.exit`, bị hệ điều hành giết vì hết bộ nhớ), plugin bị đánh dấu là đã chết: cảnh báo được ghi một lần và mọi lệnh gọi sau đó trả về thông báo lỗi. Phần còn lại của bot, kể cả các plugin khác, không bị ảnh hưởng.

Cô lập bằng worker bảo vệ **uptime** của Lily, không bảo vệ dữ liệu của bạn — đây không phải sandbox bảo mật. Plugin vẫn chạy với đầy đủ quyền của Node.js bên trong thread của nó.

## Bảo mật

Plugin chạy bên trong tiến trình bot với đầy đủ quyền của Node.js — chúng có thể đọc file, mở kết nối mạng, và thực thi code trên máy. Chỉ cài plugin bạn tin tưởng, và nên xem qua mã nguồn của plugin trước khi thêm vào `plugins.json`. Với công cụ có tác dụng phụ, hãy ưu tiên `approval: true`. Chạy plugin ở [chế độ worker](#cô-lập-bằng-worker-tùy-chọn) giới hạn mức hư hại nó gây ra cho uptime của bot, nhưng không giới hạn những gì nó truy cập được.

## Module liên quan

- `src/plugins.ts` — trình nạp và registry (toàn bộ hệ thống)
- `src/plugin_worker.ts` — entry của worker: nạp plugin trong thread riêng và phục vụ qua RPC
- `src/ai.ts` — quảng bá công cụ trong system prompt, phân tích và chạy khối `<tool>`
- `src/telegram.ts` — điều phối lệnh plugin, chứa giao diện phê duyệt
- `src/main.ts` — nối tất cả lại với nhau
