# MiSub：bero 后端、DMIT 入口

部署与维护前先读 bero 的 `/srv/AGENTS.md`、本文件及 `/srv/nginx/README.md`。生产使用原生 Node.js 与 SQLite，应用版本固定为 `73b5c5c`，复用 `deploy/dmit/Dockerfile` 构建。容器仍为 64 MiB 软预留、512 MiB 硬上限，禁用 swap。

## 链路与目录

```text
sub.jiyax.com → 原 Cloudflare/DNS 配置 → DMIT Nginx
  → HTTPS 94.103.170.38:443（SNI 与证书校验：sub.jiyax.com）
  → bero Nginx → 127.0.0.1:18787 → MiSub
```

域名 DNS、管理员密码、Cookie 密钥、后台会话和分享链接沿用原配置。DMIT 上 `/sub/` 的 S-UI 路由保留原上游，只有 MiSub 的 `location /` 改到 bero。关闭公开页时，未登录首页仍按现有逻辑显示 404，后台登录入口为 `/login`。

| 路径                                            | 内容                                                       |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `/srv/misub/compose.yaml`                       | Docker Compose 项目，镜像 `local/misub:73b5c5c`            |
| `/srv/misub/.env`                               | 原管理员密码、Cookie 密钥与公开 origin；root:root 0600     |
| `/srv/misub/data/native.sqlite`                 | 全部业务数据、KV、会话版本；data 目录与文件归容器 UID 1000 |
| `/srv/misub/source`                             | 固定提交源码                                               |
| `/srv/misub/config`                             | 本部署 Nginx 配置副本                                      |
| `/etc/nginx/sites-available/sub.jiyax.com.conf` | bero 上游站点，由 sites-enabled 同名链接启用               |
| `/etc/nginx/conf.d/30-misub-origin.conf`        | TCP 来源白名单与不记录 URL 的访问日志格式                  |
| `/etc/letsencrypt/live/sub.jiyax.com/`          | bero 自行签发的证书与私钥，不复制 DMIT 私钥                |
| `/srv/backups/misub/migration-20261111`         | 迁移配置、数据和核对基线，仅 root 可读                     |

bero 上 MiSub 端口仅绑定回环。上游站点按原始 TCP 来源只允许 DMIT `179.253.230.8`，直接从其它主机访问返回 403；不接受 Cloudflare 或其它来源直接访问此上游。该来源认证与现有直接接收 Cloudflare 的站点不同，因此不复制它们的 `X-Origin-Auth` 密钥；转发到应用前仍清除该头。

bero 的 Nginx 只接受 DMIT 提供的 `X-Real-IP`，应用只信任本机代理；`CF-Connecting-IP` 保留现有校验链，后台按真实来源 IP 限流。DMIT 的 UFW 添加 `94.103.170.38` 来源白名单；bero 主机 UFW 未启用、INPUT 策略 ACCEPT，实际 HTTPS 链路已验证可达，不切换全机防火墙策略。固定来源限制落在 bero 的专用站点上，Docker 端口不对公网开放。

## 证书与日志

bero 使用现有 Cloudflare DNS-01 凭据 `/srv/certbot/credentials/cloudflare.ini` 为 `sub.jiyax.com` 签发证书。DNS A/AAAA 记录继续指向原入口。续期沿用 `certbot.timer` 和既有 `reload-nginx` deploy hook，不添加第二套调度。

DMIT 使用系统 CA bundle 验证上游证书和域名，禁止关闭 `proxy_ssl_verify`。证书续期检查：

```sh
certbot renew --cert-name sub.jiyax.com --dry-run --run-deploy-hooks
```

容器日志为 json-file，每份 10 MiB、保留 3 份。bero 的独立访问日志只记录来源、方法、状态、字节数和耗时，省略包含订阅凭据的路径与查询串。错误日志仅记录 critical 级别，避免上游错误附带请求 URL；文件日志沿用主机 Nginx logrotate。

## 更新与检查

```sh
cd /srv/misub
docker compose ps
curl -f http://127.0.0.1:18787/healthz
docker compose logs --tail 50 misub
nginx -t
```

先备份一致性 SQLite、`.env` 和配置，再在 source 中检出已验证的明确提交并构建独立镜像标签，更新 Compose 后启动。不要在已有数据上运行首次空库初始化脚本。除本地健康检查外，应从 DMIT 验证 HTTPS 上游，并从公网验证登录、原会话和免登录订阅。

## 备份、恢复与回退

迁移时先复制在线一致性快照验证候选容器，切换前停止 DMIT 旧容器，重新备份最终 SQLite，再停止候选并替换数据，启动 bero，最后检查并重载 DMIT Nginx。DMIT 旧容器禁用自动重启，保留原镜像、配置和数据供回退。

本地迁移备份保留 30 天；确认稳定且有独立恢复副本后再按目录清理，不自动删除旧数据库。迁移备份的加密异机副本与恢复密钥位置在服务器的恢复记录中说明；未配置新的周期性备份任务。

恢复仅针对 MiSub：停止容器，将一致性快照恢复为 `data/native.sqlite`，将旧库及其 WAL/SHM 一起移入独立备份目录，核对 `.env`，设置数据属主 UID/GID 1000 后启动并做功能验证。

DMIT 的原站点和 Compose 备份保存在 `/opt/misub/backups/migration-to-bero-20261111/`。若迁移后已经写入新数据，回退前先停止 bero，将它的最新一致性快照同步回 DMIT，再启动旧容器、恢复原 Nginx 站点并 `nginx -t && systemctl reload nginx`。不要直接启动 DMIT 旧数据库造成新数据丢失，也不要同时对两份数据库提供管理写入。
