# DMIT 本机部署

本 fork 基于 MiSub main `4952c16fef2423b2881c8aeecc63647526f42bda`（2.7.0），开发分支为 `dev/node-flags-probe-copy`。

VPS 部署使用 Wrangler 编译 Pages Functions，由 Miniflare/workerd 在 DMIT 本机运行，不需要 Cloudflare 账号或云端存储。国旗沿用地区预览位置，CN 可识别，未知地区默认显示 🇨🇳；默认不向导出的节点名称注入旗帜。用户显式配置的转换/模板仍可添加旗帜。

手动节点复制为独立 ID，名称追加 ` copy`，保留原始连接参数和分组。复制后需保存；现有组合订阅不会自动增加复制节点。

检测通过鉴权后的 `POST /api/nodes/probe`，只接受已保存节点 ID 和与存储一致的链接。测量 MiSub 服务端到节点的 TCP 连接耗时（含 DNS），不验证代理协议认证、TLS 或中转出口，也不代表手机客户端延迟。连接 3 秒超时，每个 Worker 实例最多 10 个并发连接；UDP 协议不支持此项检测。连接失败不会显示成功延迟。

## 运行

- `/opt/misub/source`：固定版本源码及本部署层
- `/opt/misub/service.env`：管理员密码与 Cookie 密钥，权限 `0600`
- `/opt/misub/data`：本机 KV、D1、Cache 持久化，挂载至容器 `/data`
- `/opt/misub/backups`：更新前的数据、配置和源码备份
- `/opt/misub/compose.yaml`：运行配置，镜像标签固定为部署 commit

容器仅发布 `127.0.0.1:18787`，Nginx 提供 `https://sub.jiyax.com`。已有 `/sub/` 路径继续提供 S-UI；MiSub 使用自己的 Token 短路径。

```sh
cd /opt/misub
docker compose up -d
docker compose ps
```

更新前停止 MiSub，备份最新 `data`、`service.env`、`compose.yaml`、源码并记录旧镜像；构建成功后切换镜像，保留持久化目录、Token 和会话。只更新 MiSub，不改 Xray/x-ui/S-UI。失败时恢复旧 compose 与源码并启动旧镜像；无数据结构迁移时沿用最新数据。

本地构建：

```sh
npm ci --no-audit --no-fund
npm run test:run
npm run build
./node_modules/.bin/wrangler pages functions build functions --outdir deploy/dmit/build --compatibility-date 2024-04-01 --compatibility-flags nodejs_compat
```

`validate.py` 是首次空库部署的初始化脚本；已有真实数据环境不要运行它的 initialize/cleanup 模式。
