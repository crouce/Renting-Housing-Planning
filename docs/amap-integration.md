# 高德地图接入方案

## 1. 已确定的供应商能力

项目使用：

- 高德 JS API：负责地图渲染、覆盖物和前端地图交互。
- 高德 Web 服务 API：负责地点提示、POI 查询、公交信息查询和公共交通路径规划。

Web 服务请求统一从后端发出，`AMAP_WEB_SERVICE_KEY` 不发送到浏览器。JS API 的 Key 和安全密钥通过前端环境变量加载，并在高德控制台配置域名白名单。

## 2. 首批使用的接口

| 业务能力 | 高德接口 | 用途 |
| --- | --- | --- |
| 输入提示 | `/v3/assistant/inputtips` | 搜索公司、学校、站点等候选地点 |
| POI 关键字搜索 | `/v5/place/text` | 获取地点详情和候选地点 |
| POI 周边搜索 | `/v5/place/around` | 查找地点附近的交通站点或住宅小区 |
| 公交站查询 | `/v3/bus/stopid`、`/v3/bus/stopname` | 获取站点与途经线路 |
| 公交线路查询 | `/v3/bus/lineid` | 获取详细站序和首末班时间 |
| 公交路径规划 | `/v5/direction/transit/integrated` | 计算指定起终点的公共交通方案 |
| 步行路径规划 | `/v5/direction/walking` | 需要独立校验接驳步行时使用 |

注意：高德当前文档同时存在 v3 和 v5 接口，适配器必须分别解析，不假设两者响应结构一致。

## 3. 公交路径规划参数映射

内部请求映射到高德公交路径规划：

| 内部字段 | 高德参数 | 说明 |
| --- | --- | --- |
| `origin` | `origin` | 经度在前、纬度在后，最多六位小数 |
| `destination` | `destination` | 经度在前、纬度在后，最多六位小数 |
| `originPoiId` | `originpoi` | 与 `destinationpoi` 成组传入 |
| `destinationPoiId` | `destinationpoi` | 与 `originpoi` 成组传入 |
| `originCityCode` | `city1` | 必填，使用 citycode |
| `destinationCityCode` | `city2` | 必填，使用 citycode |
| `strategy` | `strategy` | 第一版默认使用 8，即时间短模式 |
| `alternativeRoutes` | `AlternativeRoute` | 取值 1～10，第一版建议 3 |
| `includeNightBus` | `nightflag` | 默认 0 |
| `departureDate` | `date` | 请求日期 |
| `departureTime` | `time` | 请求时间 |

请求时设置 `show_fields=cost,navi,polyline`：

- `cost.duration` 是方案总耗时，单位为秒，并包含等车时间。
- `navi` 用于展示分段动作。
- `polyline` 用于在地图上绘制路线。

所有字符串数字都在适配器边界转换为内部数值类型，避免业务层重复解析。

## 4. 第一版可达性策略

当前基础公交路径规划文档描述的是单起点、单终点请求，没有提供公共交通矩阵或公共交通等时圈。因此 MVP 使用“候选站点 + 逐站点路径规划”：

1. 使用 POI 周边搜索和公交信息查询获取候选站点。
2. 依据父 POI、站点 ID、名称和坐标合并重复站点或出入口。
3. 将公司与候选站点组成起终点对。
4. 调用 `/v5/direction/transit/integrated` 获取方案。
5. 取最短的 `cost.duration`，筛选不超过时间预算的站点。
6. 计算地理最远、最接近时间上限和各方位边界站点。
7. 对请求结果按地点、方向、时间桶和策略缓存。

逐站请求必须受并发和配额控制。正式确定并发数前，需要查看高德控制台中该 Key 对应的 QPS 和每日配额。

## 5. 错误处理

所有 Web 服务响应先检查：

- `status` 是否为 `1`。
- `infocode` 是否为成功码。
- 结果集合是否存在且非空。

适配器将高德错误归一为：

- `INVALID_REQUEST`
- `AUTHENTICATION_FAILED`
- `RATE_LIMITED`
- `NO_RESULT`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_ERROR`

日志只记录接口类型、请求 ID、耗时、状态码和脱敏参数，不记录完整 Key。

## 6. 环境变量

开发者从 `.env.example` 复制并填写 `.env.local`。服务启动时只验证变量是否存在，不输出变量值。

```env
NEXT_PUBLIC_AMAP_JS_KEY=
NEXT_PUBLIC_AMAP_JS_SECURITY_CODE=
AMAP_WEB_SERVICE_KEY=
AMAP_API_BASE_URL=https://restapi.amap.com
AMAP_DEFAULT_CITY_CODE=
AMAP_DEFAULT_ADCODE=
```

`.env.local` 已由 `.gitignore` 排除，不得提交到版本库。

## 7. 官方文档

- 路径规划 2.0：https://lbs.amap.com/api/webservice/guide/api/newroute
- 搜索 POI 2.0：https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch
- 输入提示：https://lbs.amap.com/api/webservice/guide/api-advanced/inputtips
- 公交信息查询：https://lbs.amap.com/api/webservice/guide/api-advanced/bus-inquiry

## 8. 配置验证记录

2026-09-09 使用本地 `.env.local` 完成脱敏验证：

| 验证项 | 结果 |
| --- | --- |
| JS API 加载器 | HTTP 200，响应非空，未发现常见 Key 错误标记 |
| POI 2.0 关键字搜索 | 成功，返回 POI |
| 输入提示 | 成功，返回建议项 |
| 公交站关键字查询 | 成功，返回公交站 |
| 公交路径规划 2.0 | 成功，`status=1`、`infocode=10000` |
| 指定日期与时间的公交规划 | 成功，返回 1 个方案 |
| `show_fields=cost,navi,polyline` | 成功返回总耗时和路线分段 |

固定公交测试路线返回总耗时 1519 秒、2 个分段。该结果仅用于验证接口权限与响应解析，不能作为业务基准数据。

JS API 的安全密钥、域名白名单和实际地图初始化仍需在浏览器应用中做最终验证。

## 9. Web 应用接入记录

首个 Web 版本已经接入：

- `/api/amap/config`：向浏览器提供受域名白名单保护的 JS API 配置。
- `/api/amap/inputtips`：服务端代理地点输入提示，过滤无坐标结果。
- `/api/amap/stations`：在 300～3,000 米范围内查询公交、地铁和轻轨站点。
- `/api/amap/reachability`：按方向生成候选站点，对用户选定的接驳站点和线路节流调用公交路径规划，并返回预算内站点、最远点和最近未达标候选。
- 高德 JS API 2.0：加载地图、地点标记和站点标记。
- 前端通勤条件：方向、日期、时间和 20～90 分钟预算。
- 前端可达性结果：候选数量、有效路线、扫描半径、最远站点和地图分钟标记。
- 前端站点约束：附近范围三档选择、最多 3 个接驳站点选择，以及站点内具体线路选择。

本地构建不会把 `AMAP_WEB_SERVICE_KEY` 写入浏览器或构建产物；正式环境由托管服务注入该变量。
