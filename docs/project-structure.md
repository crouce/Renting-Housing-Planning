# 项目目录规划

## 1. 组织方式

项目采用 pnpm workspace 管理的 TypeScript monorepo。地图供应商已确定为高德，当前先创建模块边界和文档；下一阶段初始化框架、依赖、高德适配器和运行脚本。

## 2. 目标目录树

```text
renting-assistance-service/
├─ apps/
│  ├─ web/                          # Next.js 前端
│  │  ├─ src/app/                  # 页面和路由
│  │  ├─ src/features/location/    # 地点搜索与选点
│  │  ├─ src/features/transit/     # 站点、线路与路线展示
│  │  ├─ src/features/reachability/# 可达性条件、进度与结果
│  │  ├─ src/components/map/       # 地图供应商 UI 封装
│  │  └─ src/lib/                  # HTTP 客户端、配置与工具
│  ├─ api/                          # 业务 API 服务
│  │  ├─ src/modules/places/       # 地点搜索
│  │  ├─ src/modules/transit/      # 站点和线路
│  │  ├─ src/modules/reachability/ # 可达性任务
│  │  ├─ src/modules/providers/    # 供应商装配与依赖注入
│  │  └─ src/platform/             # 数据库、缓存、日志和队列
│  └─ worker/                       # 异步计算进程
│     ├─ src/jobs/                  # 队列消费者
│     └─ src/services/              # 批量路线与结果持久化
├─ packages/
│  ├─ contracts/                    # API DTO、Schema 和共享类型
│  ├─ domain/                       # 领域实体、值对象和规则
│  ├─ map-provider/                 # 地图供应商统一接口与适配器
│  │  ├─ src/core/                  # Provider 接口和标准错误
│  │  └─ src/providers/amap/        # 高德 JS/Web 服务适配实现
│  ├─ transit-engine/               # 候选筛选和可达性算法
│  │  ├─ src/strategies/            # 等时圈、矩阵、逐站、图算法
│  │  └─ src/scoring/               # 边界、最远站点和后续评分
│  └─ shared/                       # 无业务归属的通用工具
├─ docs/
│  ├─ implementation-plan.md        # 总体实现方案
│  ├─ project-structure.md          # 本文档
│  ├─ map-api-checklist.md           # API 接入前确认事项
│  └─ amap-integration.md            # 高德接口与参数映射
├─ infra/
│  └─ docker/                       # 本地与部署容器配置
├─ tests/
│  ├─ integration/                  # 跨模块与真实适配器测试
│  └─ fixtures/maps/                # 脱敏后的供应商响应样例
├─ scripts/
│  └─ local-setup.mjs               # 本地浏览器初始化与自动启动助手
├─ start-local.cmd                  # Windows 双击启动入口
├─ ROADMAP.md
├─ README.md
├─ package.json                     # workspace 命令，初始化时创建
├─ pnpm-workspace.yaml              # workspace 声明，初始化时创建
├─ tsconfig.base.json               # TypeScript 基础配置
└─ .env.example                     # 无敏感值的环境变量模板
```

## 3. 依赖方向

```text
web ───────────────→ contracts
api ───────────────→ contracts + domain + map-provider
worker ────────────→ domain + map-provider + transit-engine
transit-engine ────→ domain + map-provider/core
map-provider ──────→ domain
```

约束：

- `domain` 不依赖 Web 框架、数据库或具体地图 SDK。
- `transit-engine` 不直接读取供应商原始 JSON。
- `web` 不持有地图服务端密钥。
- 具体供应商实现只能放在 `map-provider/src/providers`。
- 公共 DTO 从 `contracts` 导出，避免前后端各维护一份类型。

## 4. 初始化时首批文件

确认地图 API 和后端框架后，第一批实现文件建议为：

```text
packages/domain/src/coordinate.ts
packages/domain/src/transit-stop.ts
packages/domain/src/reachability.ts
packages/map-provider/src/core/map-provider.ts
packages/map-provider/src/core/provider-error.ts
packages/map-provider/src/providers/amap/index.ts
packages/contracts/src/reachability.ts
packages/transit-engine/src/reachability-engine.ts
apps/api/src/modules/places/routes.ts
apps/api/src/modules/transit/routes.ts
apps/api/src/modules/reachability/routes.ts
apps/web/src/features/location/
apps/web/src/features/reachability/
```

## 5. 暂不创建的内容

- 在高德 Key 配额和接口响应完成验证前，不创建未经样例校验的字段解析。
- 在配额和异步需求未验证前，不锁定队列框架。
- 在需要保存用户与收藏前，不提前设计完整用户系统。
- 房源抓取或第三方房源接入必须另行确认数据授权。
