# 对外 API 使用文档

用 API Key 免登录拉取指定邮箱的邮件，适合脚本自动获取验证码、集成到其他系统。

## 账号导入 API（自动化）

该接口用于让注册器或其他可信服务自动导入 Outlook 账号，不需要登录后台 Cookie。它与网页批量导入使用相同的格式。

### 启用

在 Worker 中配置独立 Secret：

```bash
pnpm exec wrangler secret put ACCOUNT_IMPORT_API_KEY
```

不要把这个 Secret 写入 `wrangler.toml`、前端代码、URL 或日志。

### 导入接口

```text
POST /api/import/accounts
```

鉴权只接受请求头：

```text
X-Import-Key: 你的 ACCOUNT_IMPORT_API_KEY
```

推荐直接提交 `Results/oauth2.txt` 的纯文本内容：

```bash
curl "https://你的域名/api/import/accounts" \
  -X POST \
  -H "Content-Type: text/plain; charset=utf-8" \
  -H "X-Import-Key: 你的导入密钥" \
  --data-binary @Results/oauth2.txt
```

也支持 JSON，可指定分组和备注：

```json
{
  "account_string": "abc@outlook.com----password----client_id----refresh_token",
  "group_id": 1,
  "remark": "自动注册"
}
```

每行格式为：

```text
邮箱----密码----client_id----refresh_token
```

返回示例：

```json
{
  "success": true,
  "data": { "total": 2, "imported": 1, "skipped": 1, "invalid": 0 },
  "message": "导入完成：新增 1 个，跳过 1 个，无效 0 个"
}
```

`skipped` 通常表示邮箱已存在；重复导入不会覆盖现有账号。

错误码：

| HTTP | code | 含义 |
|:----:|------|------|
| 401 | `UNAUTHORIZED` | 导入密钥缺失或错误 |
| 400 | `BAD_REQUEST` | 请求格式或账号字段无效 |
| 413 | `PAYLOAD_TOO_LARGE` | 内容超过 1 MB 或单次超过 100 个账号 |
| 503 | `IMPORT_DISABLED` | 尚未配置 `ACCOUNT_IMPORT_API_KEY` |

## 1. 启用 / 获取 API Key

登录后台 → **系统设置** → **对外 API** → 点「生成 API Key」。

- 生成后会显示完整 Key 和调用示例，点「复制」即可。
- 「重新生成」会让旧 Key **立即失效**；「停用」会关闭整个对外 API。
- Key 是明文存放在你自己的 D1 里，只有后台登录后能看到。

## 2. 接口

### 获取邮件列表

```
GET /api/external/emails
```

**鉴权**（二选一）：

- 请求头：`X-API-Key: <你的Key>`
- 或查询参数：`?key=<你的Key>`

**参数**：

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `email` | ✅ | 要查询的邮箱地址（必须是后台已添加的账号） |
| `folder` | ❌ | `inbox`(默认) / `junkemail` / `deleteditems` / `all`（收件箱+垃圾箱合并） |
| `top` | ❌ | 返回条数，默认 10，最大 50 |
| `keyword` | ❌ | 搜索关键词 |
| `includeBody` | ❌ | 传 `1` 时每封邮件额外返回 `body` 字段（完整纯文本正文，不截断） |

> **关于 `bodyPreview` 截断**：`bodyPreview` 是 Microsoft Graph 固定截断到 **255 字符**的预览字段，无法配置成不截断。需要完整正文时请加 `includeBody=1`，从返回的 `body` 字段取（响应体会相应变大，建议配合较小的 `top` 使用）。

## 3. 调用示例

**浏览器 / curl（查询参数方式）**

```bash
curl "https://你的域名/api/external/emails?email=abc@outlook.com&key=你的Key&folder=all&top=5"
```

**请求头方式（更安全，Key 不出现在 URL / 日志里）**

```bash
curl "https://你的域名/api/external/emails?email=abc@outlook.com" \
  -H "X-API-Key: 你的Key"
```

**取完整正文（不截断，验证测试方法）**

```bash
# 只取最新 1 封并带完整正文；对比 bodyPreview（最多 255 字符）与 body（完整）
curl "https://你的域名/api/external/emails?email=abc@outlook.com&top=1&includeBody=1" \
  -H "X-API-Key: 你的Key"
```

预期：返回的每个 item 里同时有 `bodyPreview`（预览，≤255 字符）和 `body`（完整纯文本正文）；不传 `includeBody` 时没有 `body` 字段。

**Python（取最新验证码的典型用法）**

```python
import re, requests

resp = requests.get(
    "https://你的域名/api/external/emails",
    params={"email": "abc@outlook.com", "folder": "all", "top": 5},
    headers={"X-API-Key": "你的Key"},
)
data = resp.json()
for mail in data["data"]["items"]:
    # 从主题或正文预览里提取 6 位数字验证码
    m = re.search(r"\b(\d{6})\b", mail["subject"] + " " + mail["bodyPreview"])
    if m:
        print("验证码:", m.group(1))
        break
```

## 4. 返回格式

成功（HTTP 200）：

```json
{
  "success": true,
  "data": {
    "email": "abc@outlook.com",
    "folder": "all",
    "count": 2,
    "items": [
      {
        "id": "AAQ...",
        "subject": "Your verification code is 123456",
        "from": { "name": "Microsoft", "address": "account@microsoft.com" },
        "receivedDateTime": "2026-06-08T08:00:00Z",
        "bodyPreview": "Use code 123456 to sign in...",
        "isRead": false
      }
    ]
  }
}
```

> 加 `includeBody=1` 时，每个 item 会多一个 `"body": "完整纯文本正文..."` 字段。

失败：

```json
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "API Key 无效" } }
```

## 5. 错误码

| HTTP | code | 含义 |
|:----:|------|------|
| 403 | `API_DISABLED` | 还没生成 API Key（去系统设置生成） |
| 401 | `UNAUTHORIZED` | Key 缺失或不正确 |
| 400 | `BAD_REQUEST` | 缺少 `email` 参数 |
| 404 | `NOT_FOUND` | 该邮箱不在后台账号列表里 |
| 400 | `DISABLED` | 该账号已被停用 |
| 502 | `TOKEN_FAILED` | 该账号 Token 失效，需在后台「重新授权」 |
| 502 | `GRAPH_ERROR` | 调用 Microsoft Graph 失败 |

## 6. 安全建议

- Key 等同于这些邮箱的读取权限，**不要写进前端代码或公开仓库**；优先用 `X-API-Key` 请求头而非 URL 参数（URL 会进日志/历史记录）。
- 怀疑泄露时，到系统设置点「重新生成」即可让旧 Key 立即作废。
- 接口只能读取**后台已添加**的邮箱，无法访问任意邮箱。
