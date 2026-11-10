# DMIT 本机部署

本 fork 基于 MiSub main `4952c16fef2423b2881c8aeecc63647526f42bda`（2.7.0），开发分支为 `dev/node-flags-probe-copy`。

VPS 部署运行原生 Node.js HTTP 服务，使用 Node 内置 SQLite 和 TCP 接口。生产镜像不包含 node_modules、Miniflare 或 workerd，也不需要 Cloudflare 账号、运行时或云端存储。构建时将现有业务处理函数打包为 Node.js 模块；Cloudflare Pages 原有的部署方式仍可独立使用。

国旗沿用地区预览位置，CN 可识别，未知地区默认显示 🇨🇳；默认不向导出的节点名称注入旗帜。用户显式配置的转换/模板仍可添加旗帜。

手动节点复制为独立 ID，名称追加 ` copy`，保留原始连接参数和分组。复制后需保存；现有组合订阅不会自动增加复制节点。

检测通过鉴权后的 `POST /api/nodes/probe`，只接受已保存节点 ID 和与存储一致的链接。测量 MiSub 服务端到节点的 TCP 连接耗时（含 DNS），不验证代理协议认证、TLS 或中转出口，也不代表手机客户端延迟。连接 3 秒超时，每个 Worker 实例最多 10 个并发连接；UDP 协议不支持此项检测。连接失败不会显示成功延迟。

## 运行

- `/opt/misub/source`：固定版本源码及本部署层
- `/opt/misub/service.env`：管理员密码与 Cookie 密钥，权限 `0600`
- `/opt/misub/data/native.sqlite`：本地 SQLite，包含 KV（含 TTL/元数据）及原 D1 表；整个 data 目录挂载至容器 `/data`
- `/opt/misub/backups`：更新前的数据、配置和源码备份
- `/opt/misub/compose.yaml`：运行配置，镜像标签固定为部署 commit

容器仅发布 `127.0.0.1:18787`，Nginx 提供 `https://sub.jiyax.com`。已有 `/sub/` 路径继续提供 S-UI；MiSub 使用自己的 Token 短路径。`MISUB_PUBLIC_URL` 必须设置为对外访问的 HTTP(S) origin，服务依此生成安全 Cookie 和校验 CSRF，不信任请求中的 Host 或 X-Forwarded-Host。

```sh
cd /opt/misub
docker compose build
docker compose up -d
docker compose ps
curl -f http://127.0.0.1:18787/healthz
```

`GET/HEAD /healthz` 返回 204，由 Node.js 直接处理，不加载登录页、不读取业务存储，也不触发后台任务。Node 进程即为应用主进程，退出后由 `restart: unless-stopped` 自动恢复。默认 512 MiB 容器限制、128 MiB V8 老生代上限，容器不使用 swap，停止时最多等待 10 秒让请求和后台写入结束。

## 从旧 Miniflare 部署升级

先构建并验证新镜像，再停止旧 MiSub，备份整个 `data`（包括 SQLite 的 WAL 文件）、`service.env`、`compose.yaml` 和源码，记录旧镜像。保持原来的数据挂载、管理员密码及 Cookie 密钥，切换镜像后启动。只更新 MiSub，不改 Xray/x-ui/S-UI。

首次启动时，服务在一个事务内将旧 `kv/miniflare-KVNamespaceObject/*.sqlite` 的键及 `kv/MISUB_KV/blobs/` 内容导入 `native.sqlite`，跳过已过期键，并保留 TTL、元数据和系统 Cookie 密钥；同时导入旧 `d1/miniflare-D1DatabaseObject/*.sqlite` 中的业务表。旧文件只读，导入成功记录标记，后续重启不会覆盖新数据。缺少有效键的 blob、数据库损坏或存在多个 MiSub D1 数据库时启动失败，事务回滚；修复来源后可重试。

迁移后登录、订阅 Token、订阅组和已有会话应继续有效；先检查 `/healthz`、登录、订阅输出和重启后的数据，再完成切换。后续更新写入 `native.sqlite`，旧 Miniflare 文件不会同步更新。回滚到旧镜像必须恢复升级前的整份数据备份；切换后已有新数据时，先导出备份再处理回滚。

本地使用 Node.js 22.13+（Docker 已固定 Node 22 镜像），构建和测试：

```sh
npm ci --no-audit --no-fund
npm run test:run
npm run test:node
npm run build
npm run build:server
# 设置 MISUB_PUBLIC_URL、ADMIN_PASSWORD、COOKIE_SECRET、MISUB_DATA_DIR 后：
npm start
```

`validate.py` 是首次空库部署的初始化脚本；已有真实数据环境不要运行它的 initialize/cleanup 模式。

`npm run test:node` 使用真实 HTTP、SQLite 和本地 TCP 连接，覆盖旧存储导入及失败回滚、已有会话、数据保存、订阅输出、重启持久化、静态资源边界、流式上传和健康检查。
