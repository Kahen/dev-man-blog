---
title: "特斯拉级系统设计面试题（三）：全球超充网络调度系统 — 空间索引、加权评分与利用率优化"
published: 2026-06-17
description: 从特斯拉全球 5 万 + 充电桩调度场景出发，拆解"就近分配 vs 全局最优"的核心矛盾，深度解析 H3/Geohash 空间索引、加权评分调度算法、Redis GEO 选址、MQTT 实时指令下发、动态负载均衡，给出可落地的架构方案与 Kotlin 代码实现。
tags: [系统设计, 面试, 充电桩, 调度系统, 空间索引, H3, Redis GEO, 后端架构]
category: Architecture
lang: zh_CN
---

2025 年国庆假期，国内某新势力车企的充电网络"趴窝"了：8000 多车主集中出游，App 推荐的充电桩要么"到现场发现全被占"，要么"导航过去发现是私桩"，要么"排队 2 小时还没轮到"。客服 24 小时接了 3 万通投诉电话，品牌口碑直接掉一个量级。后端复盘会上，TL 写了一份 30 页的反思报告，核心就一句话：**充电桩调度不是"找最近的桩"，而是"在动态变化的供需中找全局最优解"**。

这道题比想象中难得多。难点不在算法，而在**多目标优化 + 实时性 + 不确定性**：

- **车主端**：希望"最近 + 最快充上 + 最便宜"
- **运营商端**：希望"整体利用率最高 + 排队最短 + 单桩收益最大"
- **电网端**：希望"削峰填谷 + 区域负载均衡"
- **数据端**：充电桩状态实时变化（在线/离线/空闲/占用/故障），且不可控

它不是"找最近的桩"这种简单问题，而是**实时供需匹配 + 多目标优化 + 异常处理**的综合性工程问题。

---

## 核心考察点

- **空间索引**：H3 / Geohash / R-tree 的选型与权衡
- **多目标优化**：距离、等待时间、费用、利用率如何加权
- **实时性**：桩状态变化的实时反映（秒级）
- **限流与降级**：高峰期如何优雅降级
- **异常处理**：桩离线、状态不一致、位置漂移

> 面试误区：很多候选人直接答"用 Redis GEO 找最近 5 个桩，然后选第一个"——这只能拿到 60 分。要展示出**多目标评分、动态调整、降级策略**的完整思考。

---

## 题目重述

**题目**：设计特斯拉超级充电桩网络调度系统，支持：

1. **全球 5 万 + 充电桩**，分布在 50 + 国家、5000 + 站点
2. **百万级车主**实时查询"附近充电桩"和"立即充电"
3. **动态调度**：车主发起请求 → 系统推荐最优桩 → 导航 + 占位
4. **就近分配**：用户体感要好（距离近、等待少、速度快）
5. **整体利用率**：避免局部桩过热、局部桩闲置
6. **高可用**：充电桩偶发离线、网络不稳定，不能影响整体调度

请给出整体架构、核心数据模型、关键算法、典型问题处理。

---

## 标准回答（架构设计）

### 1. 整体架构：调度大脑 + 边缘触手

```
┌─────────────────────────────────────────────────────────────┐
│                  用户接入层                                   │
│   App/车机 │ H5 │ 客服系统 │ 第三方合作平台                   │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  API 网关层                                   │
│   鉴权 │ 限流 │ 参数校验 │ 灰度路由                           │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  调度服务层（核心）                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │ 桩状态服务    │  │ 推荐引擎      │  │ 占位/排队服务 │        │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │
│         └─────────────────┴─────────────────┘                │
│                   ┌──────────────┐                            │
│                   │ 调度大脑       │  (规则引擎 + 算法)        │
│                   └──────┬───────┘                            │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                  实时通信层                                   │
│  MQTT Broker (EMQ/VerneMQ) │ WebSocket (App/车机)            │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  桩端层                                       │
│  智能充电桩 │ 充电控制器 │ 电网网关                           │
└──────────────────────────────────────────────────────────────┘
```

**关键模块**：

| 模块 | 职责 | 关键指标 |
|------|------|----------|
| **桩状态服务** | 桩在线/离线/空闲/占用/故障状态聚合 | 状态延迟 < 3s |
| **推荐引擎** | 多目标评分 + 排序 | 推荐耗时 < 200ms |
| **占位/排队** | 锁桩位、排队叫号 | 公平性、容错性 |
| **调度大脑** | 规则引擎、动态限流、削峰填谷 | 全局利用率 |

### 2. 空间索引：H3 vs Geohash 选型

充电桩调度需要快速"找附近"，空间索引是关键。常见选择对比：

| 方案 | 原理 | 优点 | 缺点 | 适用 |
|------|------|------|------|------|
| **Geohash** | Z 阶曲线，字符串前缀 | 简单，字符串可前缀查询 | 边界突变（相邻区域不连续） | 简单场景 |
| **H3** | Uber 六边形网格 | 等面积、邻居规则 | 学习成本略高 | 复杂场景（推荐） |
| **R-tree** | 平衡树，PostGIS 内置 | 范围查询强 | 写开销大、分布式难 | 数据库内查询 |

**特斯拉的实践**：H3（六边形网格）。原因是：

- **等面积**：地球上每个 H3 单元面积相等，避免两极区域畸形
- **邻居规则**：每个 H3 单元的邻居是确定的，调度时"扩展范围"很简单
- **多分辨率**：H3 0-15 级，调度时"先粗后细"效率高

```kotlin
// H3 索引工具
@Component
class H3Index(
    private val h3: H3Core  // uber-h3 Java 绑定
) {
    companion object {
        // 城市级搜索用 7 级（约 5km²/单元）
        // 街区级搜索用 9 级（约 0.1km²/单元）
        // 实时定位用 10 级（约 0.03km²/单元）
        private const val DEFAULT_RESOLUTION = 9
        private const val SEARCH_RING_SIZE = 5  // 搜索 5 圈邻居
    }
    
    /**
     * 经纬度 → H3 Cell ID
     */
    fun geoToCell(lat: Double, lng: Double, resolution: Int = DEFAULT_RESOLUTION): String {
        return h3.latLngToCellAddress(lat, lng, resolution)
    }
    
    /**
     * H3 Cell → 经纬度
     */
    fun cellToGeo(cellId: String): Pair<Double, Double> {
        val geoCoord = h3.cellToLatLng(cellId)
        return geoCoord.lat to geoCoord.lng
    }
    
    /**
     * 环形扩展：获取 cellId 周围 k 圈的所有 cell
     */
    fun expandRing(cellId: String, k: Int): List<String> {
        return h3.gridDisk(cellId, k)  // 包含中心 + k 圈
    }
    
    /**
     * 父级 cell（向上聚合）
     */
    fun parent(cellId: String): String {
        return h3.cellToParent(cellId, cellId.resolution() - 1)
    }
}
```

### 3. 充电桩状态管理：分层存储

充电桩状态是"高频写、低频读、实时性要求高"的数据。设计要点：

```sql
-- 充电桩基础信息表（按 station_id 分 64 库 × 8 表）
CREATE TABLE charger (
    charger_id      VARCHAR(32)  NOT NULL,
    station_id      VARCHAR(32)  NOT NULL,
    station_name    VARCHAR(128) NOT NULL,
    lat             DECIMAL(10, 7) NOT NULL,
    lng             DECIMAL(10, 7) NOT NULL,
    h3_cell_res9    VARCHAR(16)  NOT NULL COMMENT 'H3 9 级 cell',
    h3_cell_res7    VARCHAR(16)  NOT NULL COMMENT 'H3 7 级 cell（区域聚合）',
    power_kw        DECIMAL(8, 2) NOT NULL COMMENT '额定功率',
    connector_type  VARCHAR(16)  NOT NULL COMMENT 'CCS/Tesla/GB/T',
    price_per_kwh   DECIMAL(8, 4) NOT NULL COMMENT '每度电费',
    region          VARCHAR(8)   NOT NULL,
    status          TINYINT      NOT NULL DEFAULT 0 COMMENT '0=离线 1=空闲 2=占用 3=故障',
    enabled         TINYINT      NOT NULL DEFAULT 1,
    last_heartbeat  DATETIME(3)  NULL,
    updated_at      DATETIME(3)  NOT NULL,
    PRIMARY KEY (charger_id),
    INDEX idx_h3_res9 (h3_cell_res9),
    INDEX idx_h3_res7 (h3_cell_res7),
    INDEX idx_station (station_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 充电桩实时状态表（高频写，Hash 结构）
-- 实际用 Redis Hash: charger:status:{chargerId} = {status, currentSessionId, ...}

-- 充电站聚合视图（缓存层）
-- 实际用 Redis String: station:summary:{stationId} = JSON
```

**Redis 存储设计**：

```kotlin
@Component
class ChargerStateCache(
    private val redisTemplate: RedisTemplate,
    private val h3Index: H3Index
) {
    companion object {
        // 单个桩状态
        private const val CHARGER_STATUS_KEY = "charger:status:%s"
        // 站内桩列表
        private const val STATION_CHARGERS_KEY = "station:chargers:%s"
        // H3 cell 内的桩集合
        private const val H3_CHARGERS_KEY = "h3:%s:chargers"  // h3:res9:cellId:chargers
        // H3 cell 内的空闲桩数量
        private const val H3_AVAILABLE_KEY = "h3:%s:available"
    }
    
    /**
     * 上报充电桩状态（桩端每 10 秒心跳）
     */
    fun reportStatus(chargerId: String, status: ChargerStatus) {
        val key = CHARGER_STATUS_KEY.format(chargerId)
        val data = mapOf(
            "status" to status.code,
            "currentSessionId" to (status.sessionId ?: ""),
            "lastHeartbeat" to Instant.now().toEpochMilli(),
            "lat" to status.lat,
            "lng" to status.lng
        )
        redisTemplate.opsForHash().putAll(key, data)
        redisTemplate.expire(key, Duration.ofMinutes(5))
        
        // 更新 H3 cell 索引
        if (status.status == Status.AVAILABLE) {
            redisTemplate.opsForSet().add(
                H3_CHARGERS_KEY.format(status.h3CellRes9),
                chargerId
            )
            redisTemplate.opsForValue().increment(
                H3_AVAILABLE_KEY.format(status.h3CellRes9)
            )
        } else {
            redisTemplate.opsForSet().remove(
                H3_CHARGERS_KEY.format(status.h3CellRes9),
                chargerId
            )
            redisTemplate.opsForValue().decrement(
                H3_AVAILABLE_KEY.format(status.h3CellRes9)
            )
        }
    }
    
    /**
     * 查询 cell 内的空闲桩
     */
    fun findAvailableChargersInCell(h3Cell: String): Set<String> {
        return redisTemplate.opsForSet().members(
            H3_CHARGERS_KEY.format(h3Cell)
        )?.toSet() ?: emptySet()
    }
}
```

### 4. 核心算法：多目标加权评分

"找最近的桩"是用户的直觉诉求，但**最合理的推荐不一定是最近的**。多目标评分模型：

```kotlin
data class ChargerScore(
    val chargerId: String,
    val distance: Double,        // km
    val driveTimeMin: Int,      // 开车时间
    val waitTimeMin: Int,       // 预计等待（前面排队）
    val queueLength: Int,       // 排队人数
    val pricePerKwh: Double,    // 单价
    val powerKw: Double,        // 充电功率
    val available: Boolean,
    val loadFactor: Double,     // 站点负载 0-1
    val score: Double           // 综合得分
)

@Service
class ChargerRecommender(
    private val h3Index: H3Index,
    private val stateCache: ChargerStateCache,
    private val routeService: RouteService,
    private val queueService: QueueService
) {
    companion object {
        // 评分权重（可配置，按用户偏好动态调整）
        private val DEFAULT_WEIGHTS = ChargerWeights(
            distance = 0.25,
            waitTime = 0.35,    // 等待时间权重最高
            price = 0.15,
            power = 0.15,       // 充电速度
            loadBalance = 0.10  // 利用率均衡
        )
    }
    
    /**
     * 多目标评分推荐
     */
    fun recommend(
        userLat: Double,
        userLng: Double,
        vehicleModel: String,
        requiredConnector: String,
        limit: Int = 10
    ): List<ChargerScore> {
        // 1. H3 空间检索：从用户位置向外扩展
        val candidates = searchCandidates(userLat, userLng, requiredConnector)
        
        // 2. 计算每个候选桩的多维度特征
        val scored = candidates.map { charger ->
            val distance = geoDistance(userLat, userLng, charger.lat, charger.lng)
            val driveTime = routeService.estimateDriveTime(userLat, userLng, charger.lat, charger.lng)
            val queueInfo = queueService.query(charger.chargerId)
            val waitTime = queueInfo.estimatedWaitMin
            val loadFactor = queueService.getStationLoad(charger.stationId)
            
            ChargerScore(
                chargerId = charger.chargerId,
                distance = distance,
                driveTimeMin = driveTime,
                waitTimeMin = waitTime,
                queueLength = queueInfo.length,
                pricePerKwh = charger.pricePerKwh,
                powerKw = charger.powerKw,
                available = charger.status == Status.AVAILABLE,
                loadFactor = loadFactor,
                score = 0.0  // 下面计算
            )
        }
        
        // 3. 加权评分
        val weights = getUserWeights(userId = SecurityContext.getCurrentUserId())
        return scored
            .filter { it.available || it.waitTimeMin < 30 }  // 过滤掉极不可用的
            .map { it.copy(score = calculateScore(it, weights)) }
            .sortedByDescending { it.score }
            .take(limit)
    }
    
    private fun calculateScore(c: ChargerScore, w: ChargerWeights): Double {
        // 归一化：每项除以最大值映射到 0-1
        val distanceNorm = 1.0 - (c.distance / 20.0).coerceAtMost(1.0)  // 20km 以内线性
        val waitNorm = 1.0 - (c.waitTimeMin / 60.0).coerceAtMost(1.0)  // 60min 以内线性
        val priceNorm = 1.0 - (c.pricePerKwh / 3.0).coerceAtMost(1.0)  // 3元/度以内
        val powerNorm = (c.powerKw / 250.0).coerceAtMost(1.0)         // 250kW 满速
        val loadNorm = 1.0 - c.loadFactor                              // 负载越低越好
        
        return c.distance * w.distance +
               c.waitTimeMin * w.waitTime +
               c.pricePerKwh * w.price +
               c.powerKw * w.power +
               c.loadFactor * w.loadBalance + 
               // ... 实际是各 norm * 权重再相加
               distanceNorm * w.distance +
               waitNorm * w.waitTime +
               priceNorm * w.price +
               powerNorm * w.power +
               loadNorm * w.loadBalance
    }
    
    /**
     * 空间检索：H3 网格由内向外扩展
     */
    private fun searchCandidates(
        lat: Double, lng: Double, connector: String
    ): List<Charger> {
        val cellId = h3Index.geoToCell(lat, lng, 9)
        val candidates = mutableSetOf<String>()
        
        // 由内向外扩展 5 圈（覆盖约 25km²）
        for (ring in 0..5) {
            val cells = h3Index.expandRing(cellId, ring)
            for (cell in cells) {
                val chargerIds = stateCache.findAvailableChargersInCell(cell)
                candidates.addAll(chargerIds)
                if (candidates.size > 200) break  // 限制候选数量
            }
            if (candidates.size > 200) break
        }
        
        // 过滤接口类型
        return candidates
            .mapNotNull { chargerRepo.findById(it) }
            .filter { it.connectorType == connector && it.enabled }
    }
}

// 评分权重
data class ChargerWeights(
    val distance: Double,
    val waitTime: Double,
    val price: Double,
    val power: Double,
    val loadBalance: Double
)
```

> **关键设计**：**权重可配置**。不同用户偏好不同——商务用户重速度（power 权重高），家庭用户重价格（price 权重高），夜猫子用户不在意距离（distance 权重低）。这些权重通过用户行为学习或显式设置动态调整。

### 5. 实时占位与排队

调度系统的"最后一公里"是"推荐了桩后怎么办"——必须解决并发占位问题：

```kotlin
@Service
class ChargerBookingService(
    private val redisTemplate: RedisTemplate,
    private val stateCache: ChargerStateCache
) {
    companion object {
        // 桩位锁：lock:charger:{chargerId}
        private const val CHARGER_LOCK_KEY = "lock:charger:%s"
        // 排队队列：queue:{chargerId} (Sorted Set, score=时间戳)
        private const val QUEUE_KEY = "queue:%s"
        // 锁 TTL（秒）
        private const val LOCK_TTL = 600  // 10 分钟
    }
    
    /**
     * 占位 + 创建排队订单
     */
    fun book(chargerId: String, userId: Long, expectedArriveIn: Int): BookingResult {
        // 1. 抢锁（SET NX EX）
        val lockKey = CHARGER_LOCK_KEY.format(chargerId)
        val lockToken = UUID.randomUUID().toString()
        val acquired = redisTemplate.opsForValue()
            .setIfAbsent(lockKey, lockToken, LOCK_TTL.toLong(), TimeUnit.SECONDS)
        
        if (acquired != true) {
            return BookingResult.conflict()
        }
        
        try {
            // 2. 检查桩状态
            val status = stateCache.getStatus(chargerId)
            if (status != Status.AVAILABLE) {
                // 桩不空闲 → 排队
                val queueKey = QUEUE_KEY.format(chargerId)
                val now = System.currentTimeMillis()
                redisTemplate.opsForZSet().add(queueKey, userId.toString(), now.toDouble())
                
                val queueLength = redisTemplate.opsForZSet().zCard(queueKey) ?: 0
                return BookingResult.queued(queueLength, estimatedWaitMin = estimateWait(queueLength))
            }
            
            // 3. 桩空闲 → 占位
            stateCache.markOccupied(chargerId, userId)
            
            // 4. 设置占位过期（车主超时未到，自动释放）
            redisTemplate.opsForValue().set(
                "booking:${chargerId}",
                userId.toString(),
                Duration.ofMinutes(expectedArriveIn.toLong())
            )
            
            return BookingResult.success(chargerId)
        } finally {
            // 5. 释放抢锁（用 Lua 校验 token，避免误删）
            releaseLock(lockKey, lockToken)
        }
    }
    
    /**
     * 排队叫号：桩释放后通知下一位
     */
    fun onChargerReleased(chargerId: String) {
        val queueKey = QUEUE_KEY.format(chargerId)
        val nextUser = redisTemplate.opsForZSet().pop(queueKey) ?: return
        
        val userId = nextUser.value.toString().toLong()
        notifyService.push(userId, "CHARGER_READY", mapOf(
            "chargerId" to chargerId,
            "validFor" to 300  // 5 分钟内到达
        ))
    }
}
```

### 6. MQTT 实时指令下发

车机接收调度指令用 MQTT：

```kotlin
@Component
class ChargerCommandDispatcher(
    private val mqttClient: MqttClient
) {
    companion object {
        // 主题设计：
        // charger/{chargerId}/cmd    下行（云→桩）
        // charger/{chargerId}/status 上行（桩→云）
        private val CMD_TOPIC = "charger/%s/cmd"
    }
    
    /**
     * 下发开始充电指令
     */
    fun startCharging(chargerId: String, sessionId: String, maxKw: Double) {
        val payload = JacksonUtil.toJson(mapOf(
            "action" to "START_CHARGING",
            "sessionId" to sessionId,
            "maxPower" to maxKw,
            "timestamp" to Instant.now().toEpochMilli()
        ))
        
        val message = MqttMessage(payload.toByteArray()).apply {
            qos = 1  // 至少一次
            retained = false
        }
        
        mqttClient.publish(CMD_TOPIC.format(chargerId), message)
    }
    
    /**
     * 下发停止充电指令
     */
    fun stopCharging(chargerId: String, reason: String) {
        val payload = JacksonUtil.toJson(mapOf(
            "action" to "STOP_CHARGING",
            "reason" to reason,
            "timestamp" to Instant.now().toEpochMilli()
        ))
        
        mqttClient.publish(CMD_TOPIC.format(chargerId), MqttMessage(payload.toByteArray()).apply {
            qos = 1
        })
    }
}
```

### 7. 降级策略：高峰期怎么办

明星车主活动 / 节假日高峰时，推荐系统可能被打挂。降级策略：

```kotlin
@Component
class ChargerRecommenderDegradation(
    private val basicRecommender: ChargerRecommender
) {
    /**
     * 多级降级
     */
    fun recommendWithDegradation(req: RecommendRequest): List<ChargerScore> {
        return try {
            // Level 1: 完整多目标评分
            basicRecommender.recommend(req)
        } catch (e: TimeoutException) {
            log.warn("Recommender timeout, degrade to level 2")
            try {
                // Level 2: 简化的 H3 + 距离排序
                simpleDistanceRecommend(req)
            } catch (e2: Exception) {
                log.error("Recommender degraded to level 3")
                // Level 3: 静态兜底（App 端缓存的桩列表）
                fallbackStaticList(req)
            }
        }
    }
    
    private fun simpleDistanceRecommend(req: RecommendRequest): List<ChargerScore> {
        // 只按 H3 cell 匹配 + 距离排序，不做多目标
        val cellId = h3Index.geoToCell(req.lat, req.lng, 9)
        val chargers = stateCache.findAvailableChargersInCell(cellId)
        return chargers
            .map { chargerRepo.findById(it)!! }
            .sortedBy { geoDistance(req.lat, req.lng, it.lat, it.lng) }
            .take(10)
    }
    
    private fun fallbackStaticList(req: RecommendRequest): List<ChargerScore> {
        // 从 CDN 拉取预生成的车主所在城市 Top 50 桩
        return cdnClient.getFallbackList(req.region, req.city)
    }
}
```

---

## 追问深度

### Q1：充电桩状态不可信怎么办？

**答**：**心跳 + 状态机 + 主动探测**。

```kotlin
// 桩端心跳（每 10 秒）
@Scheduled(fixedDelay = 10000)
fun heartbeat() {
    mqttClient.publish("charger/$chargerId/status", MqttMessage(
        JacksonUtil.toJson(currentStatus).toByteArray()
    ).apply { qos = 1 })
}

// 云端心跳检测
@Scheduled(fixedDelay = 30000)
fun checkHeartbeat() {
    val cutoff = Instant.now().minus(Duration.ofMinutes(1))
    val deadChargers = chargerRepo.findByLastHeartbeatBefore(cutoff)
    
    for (charger in deadChargers) {
        // 主动探测：下发"查询状态"指令
        mqttClient.publish(CMD_TOPIC.format(charger.chargerId), 
            MqttMessage("""{"action":"QUERY_STATUS"}""".toByteArray()))
        
        // 探测超时仍未响应 → 标记离线
        scheduleMarkOffline(charger.chargerId, delay = 30)
    }
}
```

### Q2：调度算法如何做 A/B 测试？

**答**：**流量分桶 + 离线评估**。

```kotlin
// 流量分桶
@Component
class ChargerExperimentRouter {
    fun getWeightsForUser(userId: Long): ChargerWeights {
        val bucket = (userId % 100).toInt()
        return when {
            bucket < 50 -> DEFAULT_WEIGHTS_A      // 50% 流量
            bucket < 75 -> EXPERIMENT_WEIGHTS_B    // 25% 流量（新算法）
            else -> EXPERIMENT_WEIGHTS_C          // 25% 流量（备选）
        }
    }
}

// 离线评估：每天跑一次"如果当时用 B 算法会怎样"
@Scheduled(cron = "0 0 5 * * *")
fun evaluateExperiment() {
    val yesterdayLogs = chargerEventRepo.findYesterday()
    val resultsA = evaluateWeights(DEFAULT_WEIGHTS_A, yesterdayLogs)
    val resultsB = evaluateWeights(EXPERIMENT_WEIGHTS_B, yesterdayLogs)
    
    val improvement = (resultsB.totalScore - resultsA.totalScore) / resultsA.totalScore
    if (improvement > 0.05) {
        notifyService.send("Algorithm B improved by ${improvement * 100}%, consider promotion")
    }
}
```

### Q3：怎么避免"局部桩过热"？

**答**：**负载均衡权重 + 价格信号**。

```kotlin
// 站点负载评分（负载越高得分越低）
fun calculateLoadScore(stationId: String): Double {
    val totalChargers = stateCache.getStationChargerCount(stationId)
    val busyChargers = stateCache.getBusyChargerCount(stationId)
    val loadFactor = busyChargers.toDouble() / totalChargers
    
    return when {
        loadFactor < 0.5 -> 1.0  // 轻负载，加分
        loadFactor < 0.8 -> 0.7  // 中等
        loadFactor < 0.95 -> 0.3 // 接近满载
        else -> 0.0  // 已满，减分
    }
}

// 动态调价（削峰填谷）
fun adjustPrice(stationId: String, basePrice: Double): Double {
    val loadFactor = getLoadFactor(stationId)
    val isPeakHour = isCurrentPeakHour()
    
    return when {
        isPeakHour && loadFactor > 0.8 -> basePrice * 1.5  // 高峰涨价
        !isPeakHour && loadFactor < 0.3 -> basePrice * 0.7  // 闲时降价
        else -> basePrice
    }
}
```

### Q4：电网侧约束（电力容量限制）怎么考虑？

**答**：**站点级功率分配**。

```kotlin
// 站点总功率限制（可能受电网容量限制）
data class StationPowerLimit(
    val stationId: String,
    val totalCapacityKw: Double,    // 站点总容量
    val currentLoadKw: Double,      // 当前负载
    val availableKw: Double         // 可用功率
)

// 调度时考虑站点功率
fun hasEnoughPower(stationId: String, requestedKw: Double): Boolean {
    val limit = getStationPowerLimit(stationId)
    return (limit.currentLoadKw + requestedKw) <= limit.totalCapacityKw
}

// 充电功率动态调整
fun adjustChargingPower(chargerId: String, requestedKw: Double): Double {
    val stationId = chargerRepo.getStationId(chargerId)
    val limit = getStationPowerLimit(stationId)
    
    return if (limit.availableKw >= requestedKw) {
        requestedKw
    } else {
        // 功率不足，降速充电
        limit.availableKw
    }
}
```

### Q5：跨国调度有什么特殊考虑？

**答**：**数据本地化 + 跨境网络**。

- 桩数据存储在所属国家（数据主权）
- 跨境的 App 调用走专线 / CDN 中转
- 计费和支付遵守当地法规（欧盟 GDPR、美国 CCPA、中国 PIPL）
- 时区、货币、单位（km/mile）动态适配

---

## 常见坑

**1. 用 MySQL 算"附近 5km"**：SQL 算 `ST_Distance` 在亿级数据上慢到不可用。必须用空间索引（H3/Geohash/Redis GEO）。

**2. 桩状态同步延迟过长**：用 Kafka 异步处理时延迟可达 10-30 秒，用户到现场发现状态不对。要走 MQTT 实时通道。

**3. 推荐算法过度优化**：上线后才发现 80% 用户只关心距离和等待时间。简单加权 + 距离排序就很好，不要陷入"机器学习选桩"的过度设计。

**4. 没有处理桩离线**：网络抖动时桩状态变 OFFLINE，但实际可能没坏。要做"心跳重试 + 主动探测"，而不是直接标记故障。

**5. 高峰期没限流**：明星车主活动导致 App 端 QPS 暴增，调度服务被打挂。要做用户级 + 全局级限流。

**6. 占位并发没防住**：两个车主同时抢同一桩位，都"成功"了。必须用 Redis 分布式锁（SET NX EX）。

**7. 排队公平性没考虑**：先到先得还是 VIP 优先？规则要透明，不能让用户感觉"被插队"。

**8. 跨服务调用忘记幂等**：车主点"开始充电"时网络抖动重试，可能发了两次指令。桩端要做幂等（按 sessionId 去重）。

**9. 没考虑充电桩物理位置漂移**：GPS 定位有误差，桩坐标可能不准。要做地理围栏 + 实际到店校验。

**10. 调度策略写死在代码里**：运营想调整"距离权重"时找不到入口。要用规则引擎（DRL/Drools）或配置中心。

---

## 可执行 Checklist

- [ ] 空间索引方案选定（H3 推荐）
- [ ] 充电桩状态实时性保证（MQTT QoS 1 + 心跳）
- [ ] 离线桩检测机制（心跳超时 + 主动探测）
- [ ] 推荐算法有 A/B 测试框架
- [ ] 多目标权重可配置（运营可调）
- [ ] 高峰限流策略（用户级 + 全局级）
- [ ] 占位用分布式锁（防超占）
- [ ] 排队公平性规则明确
- [ ] 跨服务调用幂等（sessionId 去重）
- [ ] 站点功率限制考虑（电网容量）
- [ ] 多级降级方案（完整→简单→静态）
- [ ] 监控指标接入（推荐耗时、占位成功率、用户放弃率）
- [ ] 异常告警配置（推荐失败率、桩离线率）
- [ ] 容量评估完成（峰值 QPS、Redis 内存、H3 单元数）

---

## 写在最后

充电桩调度的核心不是"找最近的桩"，而是**在动态约束下做多目标实时优化**。它涉及的技术栈非常广：

- **空间索引**：H3、Geohash
- **实时通讯**：MQTT、WebSocket
- **规则引擎**：DRL、Drools
- **算法**：多目标评分、强化学习（高级）
- **基础设施**：Redis Cluster、Kafka、Flink

每一点都值得深挖。但更重要的是**从业务出发选技术**，不要为了"用 H3 而用 H3"，不要为了"上机器学习而上机器学习"。**先解决 80% 的简单问题，再优化 20% 的复杂问题**。

**下篇预告：第 4 篇 — 特斯拉车辆固件版本校验系统（签名验证、兼容性矩阵、灰度发布与回滚）**
