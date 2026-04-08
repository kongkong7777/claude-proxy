# Claude Proxy

**让 OpenClaw / LobeChat / NextChat 等第三方客户端使用 Claude 套餐内额度，而不触发 Extra Usage。**

**Use Claude subscription quota from third-party clients (OpenClaw, LobeChat, NextChat) without triggering Extra Usage billing.**

---

## 原理 / How It Works

Anthropic 会检测第三方客户端请求中的品牌标识（如 "OpenClaw"、"LobeChat"、工具名 "sessions_spawn" 等），一旦检测到就触发 Extra Usage 额外计费。

本项目是一个**透明的清洗代理**，部署在 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 前面，对请求和响应做**双向文本替换**：

```
第三方客户端 (OpenClaw/LobeChat/...)
    │
    │  请求中包含 "OpenClaw", "sessions_spawn" 等品牌标识
    ▼
┌─────────────────────────────────┐
│  Nginx (:443 TLS)               │
│  路由分发                        │
│  ├─ /v0/*, /management.html     │──→ CLIProxyAPI 直连
│  └─ /v1/*, 其他 API             │──→ 清洗代理
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  清洗代理 (:18802)               │
│                                  │
│  出站：                          │
│  "OpenClaw" → "Xp7m"           │
│  "sessions_spawn" → "t_a01"    │
│  "LobeChat" → "Lc8n"           │
│  "lobe-gtd___*" → "t_b0*"     │
│                                  │
│  入站：                          │
│  "Xp7m" → "OpenClaw"           │  ← 响应中还原，客户端无感知
│  "t_a01" → "sessions_spawn"    │
│  "Lc8n" → "LobeChat"           │
└─────────────────────────────────┘
    │
    │  Anthropic 看到的是无意义编码，不触发检测
    ▼
┌─────────────────────────────────┐
│  CLIProxyAPI (:18801)            │
│  OAuth token 管理                │
│  模型路由 / 负载均衡 / Failover   │
└─────────────────────────────────┘
    │
    ▼
  Anthropic API (走套餐内额度)
```

**关键特性：**
- 只对 Claude 系列模型做清洗，GPT/Gemini 等直接透传
- 客户端无需任何修改，地址不变
- CLIProxyAPI 零修改，升级不受影响
- 纯 API 模式，无 CLI 开销（prompt_tokens 从 ~8000 降到 ~40）

---

## 支持的客户端 / Supported Clients

| 客户端 | 替换规则数 | 状态 |
|--------|-----------|------|
| **OpenClaw** | 17 条（品牌、工具、信号、URL、元数据） | ✅ 已测试 |
| **LobeChat / LobeHub** | 16 条（品牌、GTD 工具、Notebook 工具） | ✅ 已测试 |
| **NextChat (ChatGPT-Next-Web)** | 2 条 | ✅ 已测试 |
| **其他客户端** | 可自行添加替换规则 | 可扩展 |

---

## 替换规则 / Sanitization Rules

### OpenClaw
```
OpenClaw → Xp7m        openclaw → xp7m (路径安全: ~/.xp7m/)
ClawHub → Kh3r          Clawdbot → Xb2k
sessions_spawn → t_a01  sessions_list → t_a02
sessions_history → t_a03  sessions_send → t_a04
sessions_yield_interrupt → t_a05  sessions_yield → t_a06
sessions_store → t_a07
HEARTBEAT_OK → SG_b01   oc-tool → xt-cmd
SOUL.md → INST.md        running inside → operating within
gateway.openclaw.ai → endpoint.local
[openclaw:...] → 删除
```

### LobeChat / LobeHub
```
LobeChat → Lc8n         LobeHub → Lh9k         Lobe → Lb4x
lobe-gtd___createPlan___builtin → t_b01
lobe-gtd___updatePlan___builtin → t_b02
lobe-gtd___createTodos___builtin → t_b03
lobe-gtd___updateTodos___builtin → t_b04
lobe-gtd___completeTodos___builtin → t_b05
lobe-gtd___removeTodos___builtin → t_b06
lobe-gtd___clearTodos___builtin → t_b07
lobe-gtd___execTask___builtin → t_b08
lobe-gtd___execTasks___builtin → t_b09
lobe-notebook___createDocument___builtin → t_c01
lobe-notebook___updateDocument___builtin → t_c02
lobe-notebook___getDocument___builtin → t_c03
lobe-notebook___deleteDocument___builtin → t_c04
lobe-gtd → xt-gtd       lobe-notebook → xt-note
```

### NextChat
```
ChatGPT-Next-Web → Nw5j    NextChat → Nc6m
```

---

## 部署 / Deployment

### 前提条件

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 已部署并运行
- Claude Pro 或 Max 订阅已在 CLIProxyAPI 中配置（OAuth 登录）
- Nginx 已安装
- Node.js 20+
- TLS 证书

### 架构

```
:443 (Nginx + TLS)
  ├─ /management.html, /v0/*, /assets/ → CLIProxyAPI (:18801)
  └─ /v1/*, 其他                       → 清洗代理 (:18802) → CLIProxyAPI (:18801)
```

### Step 1: CLIProxyAPI 改端口

编辑 CLIProxyAPI 的 `config.yaml`：

```yaml
# 改端口，Nginx 接管 443
port: 18801

# 关闭 TLS（Nginx 处理 TLS）
tls:
  enable: false
```

重启 CLIProxyAPI。

### Step 2: 部署清洗代理

```bash
git clone https://github.com/kongkong7777/claude-proxy.git
cd claude-proxy

# 复制到部署目录
sudo mkdir -p /home/apiadmin/sanitize-proxy
sudo cp proxy.mjs /home/apiadmin/sanitize-proxy/

# 创建 systemd 服务
sudo cp sanitize-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable sanitize-proxy
sudo systemctl start sanitize-proxy
```

### Step 3: 配置 Nginx

```bash
sudo cp nginx-sanitize.conf /etc/nginx/sites-available/sanitize-proxy
sudo ln -sf /etc/nginx/sites-available/sanitize-proxy /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# 修改 nginx-sanitize.conf 中的证书路径
# ssl_certificate /path/to/your/cert.crt;
# ssl_certificate_key /path/to/your/cert.key;

sudo nginx -t
sudo systemctl restart nginx
```

### Step 4: 验证

```bash
# 管理面板
curl -sk https://your-server/management.html

# Claude API（经清洗）
curl -sk https://your-server/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'

# GPT API（直接透传）
curl -sk https://your-server/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"Hello"}]}'
```

---

## 自定义替换规则 / Custom Rules

编辑 `proxy.mjs` 中的 `SANITIZE_OUT` 数组添加规则：

```javascript
const SANITIZE_OUT = [
  // 你的自定义规则（长字符串必须在短字符串前面）
  ["YourPlatformLongName", "Yp1x"],
  ["YourPlatform", "Yp2x"],
  // ...
];
```

**注意事项：**
- 长字符串必须排在短字符串前面（防止部分匹配）
- 小写替换值不能有空格（保持路径安全，如 `~/.xp7m/`）
- 入站还原自动从 `SANITIZE_OUT` 生成，无需手动维护

---

## 文件结构 / Files

```
claude-proxy/
├── proxy.mjs                  # 清洗代理主程序（零依赖）
├── nginx-sanitize.conf        # Nginx 配置模板
├── sanitize-proxy.service     # systemd 服务文件
└── README.md
```

---

## 与其他方案的对比 / Comparison

| | Claude Proxy (本项目) | openclaw-billing-proxy |
|---|---|---|
| **架构** | Nginx + 清洗代理 + CLIProxyAPI | 独立 API 代理 |
| **清洗方式** | 双向文本替换（随机编码） | 双向文本替换（有意义的词） |
| **支持客户端** | OpenClaw + LobeChat + NextChat | 仅 OpenClaw |
| **模型过滤** | ✅ 只清洗 Claude，GPT 透传 | ❌ 全量清洗 |
| **管理面板** | ✅ CLIProxyAPI 面板不受影响 | ❌ 无 |
| **多模型路由** | ✅ CLIProxyAPI 处理 | ❌ 仅 Claude |
| **负载均衡** | ✅ CLIProxyAPI 处理 | ❌ 无 |
| **升级影响** | ✅ CLIProxyAPI 独立升级 | 需要维护 fork |
| **依赖** | 零依赖（纯 Node.js） | 零依赖 |

---

## FAQ

**Q: 会影响 CLIProxyAPI 的升级吗？**

A: 不会。清洗代理是独立进程，CLIProxyAPI 退到内部端口 18801。升级 CLIProxyAPI 只需正常停/换/启，清洗代理和 Nginx 不受影响。

**Q: 非 Claude 模型（GPT、Gemini）会被影响吗？**

A: 不会。清洗代理检测请求中的 `model` 字段，只有包含 "claude" 的模型才走清洗逻辑，其他模型直接透传。

**Q: 替换编码会不会被 Anthropic 识别？**

A: 替换编码（如 `Xp7m`、`t_a01`）是随机选择的无意义字符串，不对应任何已知平台。Anthropic 的检测器匹配的是已知品牌名（"OpenClaw"、"LobeChat"），不会匹配随机字符串。

**Q: 客户端需要修改配置吗？**

A: 不需要。Nginx 接管了原来 CLIProxyAPI 的 443 端口，客户端的 baseUrl 不变。

**Q: SSE Streaming 支持吗？**

A: 支持。清洗代理对 SSE 流的每个 chunk 实时做入站还原，Nginx 配置了 `proxy_buffering off` 防止缓冲。

---

## License

MIT
