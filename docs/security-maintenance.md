# 安全边界与依赖维护

## 订阅链接与后台登录

Shadowrocket 等客户端通过完整分享链接获取订阅，不需要后台登录 Cookie。`isPublic` 控制是否在公开列表展示，不改变持有分享链接的客户端读取权限。分享链接不是后台管理员会话，不能用于调用管理 API。

应将“持有分享链接可读取”和“未持有链接的人能否猜到链接”分开评估。公开配置可能包含分享路径前缀，因此不应仅依赖此前缀隐藏订阅；需要保密的链接应使用不可猜测的路径组件，短自定义 ID 属于容易传播、容易猜测的分享地址。调整凭据或链接格式前，需要评估现有客户端链接的兼容性。

## 管理操作的方法约束

以下操作只能通过 `POST` 调用，且保留后台认证与现有 CSRF 校验：

- `/api/migrate_to_d1`
- `/api/migrate_legacy_d1`
- `/api/migrate`
- `/api/cron/trigger`

其它方法在操作和存储访问前返回 `405 Method Not Allowed`，并设置 `Allow: POST`。带有效 Cookie 的跨站 `POST` 仍返回 `403`。GET/HEAD 导航不会触发迁移或手动同步。

## 依赖维护

生产镜像只包含编译后的前端、后端及 Node.js 原生适配层，不复制 `node_modules`。前端安全库和打包进后端的依赖仍需及时更新；开发依赖不在生产镜像中，也应修补其构建、测试和开发服务器风险。

本轮更新的安全基线：

| 依赖      | 版本基线 | 使用范围                   |
| --------- | -------- | -------------------------- |
| DOMPurify | 3.4.17   | 前端公告与自定义 HTML 清理 |
| js-yaml   | 4.3.2    | YAML 解析和输出            |
| Vue       | 3.5.45   | 前端运行时及构建工具链     |
| Vite      | 7.3.8    | 开发和构建                 |
| Vitest    | 4.1.12   | 测试                       |
| Happy DOM | 21.0.4   | 测试环境                   |
| esbuild   | 0.28.2   | Node.js 后端打包           |

保留 Vue Test Utils 的 2.4 系列，通过 `package.json` 的定向 `overrides` 将 `js-beautify` 使用的 `glob` 升至 14.0.4 及以上，将其 `editorconfig` 使用的 `minimatch` 升至 11.0.5 及以上。这两个包仅属于测试格式化依赖链；更新或移除覆盖配置时，需重新验证 Vue 组件测试、格式化和 EditorConfig 行为，避免引回已公告的拒绝服务问题。

Playwright 没有仓库内调用，已从开发依赖移除。DOMPurify、js-yaml、二维码、拖拽和压缩相关依赖存在实际调用，继续保留。

HTML 净化组件测试单独使用 jsdom 31；其它组件测试继续使用 Happy DOM。[DOMPurify 官方说明](https://github.com/cure53/DOMPurify#running-dompurify-on-the-server)不推荐与 Happy DOM 组合使用，因此净化测试需使用其推荐的 jsdom 环境，保留脚本与危险属性的拦截断言。jsdom 31 要求 Node.js 22.22.2+（22 系列），本项目 CI 和 Docker 使用 Node.js 22。

更新锁文件后检查：

```sh
npm ci --no-audit --no-fund
npm audit
npm run test:run
npm run test:node
npm run build
```

`npm audit` 的依赖告警不等于线上接口已经可被利用；还需结合代码调用、配置和部署方式评估。扫描结果只覆盖其数据库收录的已知问题，不构成无漏洞保证。
