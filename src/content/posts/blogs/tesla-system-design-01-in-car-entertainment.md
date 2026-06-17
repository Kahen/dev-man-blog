---
title: "特斯拉级系统设计面试题（一）：千万级车载娱乐系统后端 — 流媒体播放、流量节省与边缘调度"
published: 2026-06-17
description: 从特斯拉千万级车载娱乐场景出发，拆解流媒体播放流畅度、流量节省（百万级车辆月流量成本）、CDN 边缘调度三大核心挑战，给出可落地的架构方案与 Kotlin 代码实现。
tags: [系统设计, 面试, 车载系统, 流媒体, CDN, 边缘计算, 后端架构]
category: Architecture
lang: zh_CN
---

2024 年特斯拉披露过一个数据：全球超 600 万辆车每天产生约 2PB 车载数据，其中娱乐系统（Tesla Theater、Spotify、Apple Music、Netflix、YouTube、Steam 游戏）流量占比超过 35%。某次 OTA 升级后，欧美车主集中反馈"在线视频卡顿""夜间听歌耗流量"，后端团队排查两周才发现是 CDN 调度策略没考虑车机移动网络特性——同一辆车在不同基站间切换时，播放会话被反复重定向到不同边缘节点，导致 60% 以上的请求是"建连+断连"的无效开销。

车载娱乐系统不是"在车上装个 Netflix"，它是一道**"在 4G/5G 移动网络、CPU 算力受限、流量按 GB 计费"约束下的极致流媒体分发问题**。这道题是特斯拉、蔚来、小鹏、理想后端高级岗的常考点，背后的设计思想可以复用到任何"海量移动终端 + 高带宽 + 高成本流量"场景（顺丰车辆监控、外卖骑手终端、机场贵宾车机）。

---

## 核心考察点

面试官问这道题时，看的不是你懂不懂 HLS/DASH，而是看你能否在三层递进压力下保持架构清晰：

- **理解移动场景的特殊性**：基站切换、信号衰减、流量计费、车机 CPU 弱
- **端云协同设计**：什么放车机、什么放云端、什么放边缘
- **成本与体验的平衡**：流量是实打实的钱，节省 30% 流量就是节省 30% 成本
- **可观测与可降级**：弱网下不能直接挂掉，要优雅降级

> 面试答题的"骨架"：先答流量从哪来（接入层）、再答内容从哪来（分发层）、最后答状态怎么管（控制层）。三层都要落到具体技术选型，不能只画大饼。

---

## 题目重述

**题目**：设计特斯拉车载娱乐系统后端，支持千万辆车辆并发使用音乐、视频、游戏功能。需保证：

1. 流媒体播放流畅（首屏 < 1s，缓冲率 < 1%，切换无感知）
2. 节省车载流量（4G/5G 流量按 GB 计费，要省到极致）
3. 千万级车辆全球分布（不同国家、不同网络环境、不同合规要求）

请给出整体架构、核心数据流、关键模块设计。

---

## 标准回答（架构设计）

### 1. 整体架构：四层分层

```
┌─────────────────────────────────────────────────────────────┐
│                车机客户端 (Tesla OS / IVI)                   │
│  - 本地缓存 (LRU + 预下载)  - 自适应码率 (ABR)  - 弱网探测  │
└────────────────────────┬────────────────────────────────────┘
                         │ MQTT + HTTPS（控制面）
                         │ HTTPS（媒体面，HLS/DASH）
┌────────────────────────▼────────────────────────────────────┐
│  接入层 (Global Edge / API Gateway)                          │
│  - 全球 GSBL 调度  - TLS 终结  - 鉴权 / 限流                  │
└──────┬─────────────────────────────────────┬─────────────────┘
       │                                     │
┌──────▼──────────────┐         ┌────────────▼────────────────┐
│  控制面 (Control)   │         │  媒体面 (Media)               │
│  - 播放会话管理     │         │  - 多 CDN 边缘节点            │
│  - 偏好与推荐       │         │  - 内容预热 / 分片缓存         │
│  - 计费 / 配额      │         │  - 协议优化（QUIC/HTTP3）     │
└──────┬──────────────┘         └────────────┬─────────────────┘
       │                                     │
┌──────▼─────────────────────────────────────▼─────────────────┐
│  服务层 (Domain Services)                                    │
│  内容服务 │ 版权服务 │ 播放会话 │ 配额服务 │ 推荐服务         │
└──────┬───────────────────────────────────────────────────────┘
       │
┌──────▼───────────────────────────────────────────────────────┐
│  数据层                                                       │
│  MySQL (分库分表) │ Redis Cluster │ Elasticsearch │ ClickHouse│
│  Kafka (播放事件流) │ S3/OSS (内容冷存)                       │
└──────────────────────────────────────────────────────────────┘
```

**四层职责清晰分离**：

| 层级 | 职责 | 关键指标 |
|------|------|----------|
| **车机客户端** | 本地缓存、自适应码率、弱网降级 | 首屏时间、缓冲率、流量消耗 |
| **接入层** | 全球调度、TLS 终结、鉴权 | 接入延迟、握手成功率 |
| **控制面** | 播放会话、偏好、计费配额 | 会话一致性、配额准确 |
| **媒体面** | 内容分发、缓存、协议优化 | 命中率、首字节时间 |

> **关键设计原则**：**控制面与媒体面分离**。控制面走 MQTT 长连接（轻量、保持会话），媒体面走 HTTPS 短连接（拉流不保持状态）。这样移动网络切换时，只需重建媒体连接，控制面会话不受影响。

### 2. 媒体面：多 CDN + 边缘节点调度

车载娱乐最大的流量是视频（Netflix、YouTube、Steam）和音频（Spotify、Apple Music）。这部分流量有三个关键决策：

#### 2.1 自适应码率（ABR）算法

车机 CPU 弱、屏幕小、网络不稳定，不能简单用 Netflix 的"带宽探测 + 码率切换"那一套。特斯拉的做法是**客户端主导 + 服务端微调**：

```kotlin
// 车机端 ABR 决策（简化版）
class AdaptiveBitrateSelector(
    private val networkQuality: NetworkQualityMonitor
) {
    fun selectBitrate(availableProfiles: List<BitrateProfile>): BitrateProfile {
        val measuredBandwidth = networkQuality.estimatedBandwidthKbps()
        val rtt = networkQuality.rttMs()
        val packetLoss = networkQuality.packetLossRate()
        
        return availableProfiles
            .filter { it.isAudio || it.bitrateKbps <= measuredBandwidth * 0.8 }
            // 留 20% 带宽余量给心跳和上行
            .maxByOrNull { it.bitrateKbps }
            ?: availableProfiles.first()
    }
}

// 实际 ABR 决策还要考虑：
// 1. 过去 30 秒的平均带宽，而非瞬时值
// 2. 预测未来 10 秒的带宽变化（基站切换检测）
// 3. 内容类型（音乐 ≤ 320kbps，视频动态）
// 4. 用户偏好设置（"省流量模式"强制 128kbps 音频）
```

#### 2.2 预下载与本地缓存

车机有 256GB+ 存储，充分利用本地缓存是节省流量的关键。特斯拉的"驻车时预下载"功能是经典案例：

```kotlin
// 预下载策略服务
@Component
class PreDownloadService(
    private val contentRepo: ContentRepository,
    private val userPrefRepo: UserPreferenceRepository,
    private val cdnClient: CdnClient
) {
    companion object {
        // 触发时机：车辆挂 P 挡 + WiFi 连接 + 电量 > 50%
        private const val MAX_PRE_DOWNLOAD_GB = 10
        private const val WIFI_ONLY = true
    }
    
    /**
     * 夜间充电 + WiFi 时，预下载用户常听/常看的专辑/剧集
     */
    @Scheduled(cron = "0 0 2 * * *")  // 凌晨 2 点
    fun scheduleNightlyPreDownload() {
        val userId = SecurityContext.getCurrentUserId()
        val preferences = userPrefRepo.findByUserId(userId)
        
        // 推荐系统计算的"高概率播放"内容
        val candidates = recommendService.getHighProbabilityContent(userId, limit = 50)
        
        var downloadedGB = 0.0
        for (content in candidates) {
            if (downloadedGB >= MAX_PRE_DOWNLOAD_GB) break
            
            // 检查本地是否已存在（用 content hash 去重）
            if (localCache.exists(content.hash)) continue
            
            // 下载（优先用 WiFi + 闲时流量）
            if (WIFI_ONLY && !networkState.isWifi()) continue
            
            val sizeGB = content.sizeBytes / 1024.0 / 1024.0 / 1024.0
            cdnClient.downloadToLocal(content)
            downloadedGB += sizeGB
        }
    }
}

// 车机本地 LRU 缓存
class LocalMediaCache(
    private val maxSizeBytes: Long
) {
    private val cache = LinkedHashMap<String, MediaEntry>(16, 0.75f, true)
    
    fun put(key: String, entry: MediaEntry) {
        cache[key] = entry
        // 超出容量时淘汰最久未访问的
        var currentSize = cache.values.sumOf { it.sizeBytes }
        while (currentSize > maxSizeBytes) {
            val oldest = cache.entries.firstOrNull() ?: break
            cache.remove(oldest.key)
            currentSize -= oldest.value.sizeBytes
        }
    }
    
    fun get(key: String): MediaEntry? = cache[key]
}
```

#### 2.3 协议优化：QUIC + HTTP3

移动网络下，TCP + TLS 1.3 的三次握手 + TLS 握手至少要 200-500ms。QUIC 把握手压缩到 1 RTT，配合 HTTP3 在弱网下表现远好于 HTTP/2：

```
HTTP/2 over TCP:
  Client → SYN → Server
  Server → SYN-ACK → Client      (1 RTT)
  Client → ACK → Server          (1.5 RTT)
  Client → TLS ClientHello → Server  (2 RTT)
  Server → TLS Finished → Client     (3 RTT)
  Client → HTTP Request → Server     (3.5 RTT)
  合计：3-4 RTT ≈ 200-500ms

QUIC (HTTP/3):
  Client → QUIC Initial (含 TLS ClientHello) → Server  (1 RTT)
  Server → QUIC Handshake + Response → Client         (2 RTT)
  合计：1-2 RTT ≈ 50-150ms
```

#### 2.4 CDN 选型与多 CDN 容灾

不要绑定单一 CDN。特斯拉的策略是：

| 区域 | 主 CDN | 备 CDN | 调度策略 |
|------|--------|--------|----------|
| 北美 | Cloudflare | Akamai | 80/20 灰度 |
| 欧洲 | Akamai | Cloudflare | 健康度优先 |
| 亚太 | 阿里云 | Cloudflare | 就近 + 质量 |
| 中国大陆 | 阿里云 + 腾讯云 | 蓝汛 | 强制 ICP 合规 |

```kotlin
// CDN 调度器
@Service
class CdnScheduler(
    private val healthCheckService: CdnHealthCheckService,
    private val metricsService: CdnMetricsService
) {
    /**
     * 基于实时健康度 + 用户位置 + 成本选择 CDN
     */
    fun selectCdn(userId: String, contentId: String, region: String): CdnEndpoint {
        val candidates = cdnConfig.cdns.filter { it.region == region && it.enabled }
        
        // 1. 过滤掉不健康的 CDN
        val healthy = candidates.filter { 
            healthCheckService.isHealthy(it.id) && metricsService.getErrorRate(it.id) < 0.01 
        }
        if (healthy.isEmpty()) {
            log.warn("No healthy CDN for region={}, falling back to default", region)
            return cdnConfig.getDefaultCdn(region)
        }
        
        // 2. 按综合评分排序：延迟 * 0.5 + 成本 * 0.3 + 错误率 * 0.2
        return healthy.minBy { endpoint ->
            val latency = metricsService.getAvgLatency(endpoint.id, region)
            val cost = endpoint.costPerGB
            val errorRate = metricsService.getErrorRate(endpoint.id)
            latency * 0.5 + cost * 0.3 + errorRate * 0.2
        }
    }
}
```

### 3. 控制面：MQTT 长连接 + 播放会话

车机和云端的"控制通道"用 MQTT 而非 HTTP 长轮询，原因：

- **MQTT 协议开销小**（2 字节固定头），适合 4G 网络
- **QoS 等级** 灵活（QoS 0/1/2），播放事件用 QoS 1，计费用 QoS 2
- **保持连接**，车机无需频繁建连
- **服务端推送**（云端可主动通知车机，比如"新剧集已发布"）

```kotlin
// 播放会话管理
@Service
class PlaybackSessionService(
    private val sessionRepo: PlaybackSessionRepository,
    private val redisTemplate: RedisTemplate,
    private val mqttClient: MqttClient
) {
    /**
     * 开始播放会话
     */
    fun startSession(vehicleId: String, contentId: String, profileId: Long): PlaybackSession {
        // 1. 鉴权：检查车辆是否订阅了该内容
        val entitlement = entitlementService.check(vehicleId, contentId)
        require(entitlement.isAllowed) { "Vehicle $vehicleId has no entitlement for $contentId" }
        
        // 2. 检查配额（Premium 用户每月 4K 流量限制）
        if (entitlement.hasQuota) {
            val current = quotaService.getCurrentUsage(vehicleId)
            require(current < entitlement.quotaBytes) { "Quota exceeded" }
        }
        
        // 3. 创建会话（Redis 存储，TTL = 24h）
        val session = PlaybackSession(
            sessionId = UUID.randomUUID().toString(),
            vehicleId = vehicleId,
            contentId = contentId,
            profileId = profileId,
            startedAt = Instant.now(),
            bitrate = 0,  // 后续上报
            bytesConsumed = 0
        )
        sessionRepo.save(session)
        redisTemplate.opsForValue().set(
            "playback:session:${session.sessionId}",
            session,
            Duration.ofHours(24)
        )
        
        // 4. 通知 CDN 边缘节点预热（可选）
        cdnClient.notifyPreHeat(contentId, profileId)
        
        return session
    }
    
    /**
     * 上报播放进度（车机每 10 秒上报一次）
     */
    fun reportProgress(sessionId: String, progressSeconds: Int, bytesDelta: Long) {
        val session = sessionRepo.findById(sessionId) ?: return
        
        // 原子累加流量消耗
        val newBytes = session.bytesConsumed + bytesDelta
        sessionRepo.updateBytes(sessionId, newBytes)
        
        // 累加到用户月度配额
        quotaService.accumulateUsage(session.vehicleId, bytesDelta)
        
        // 发送埋点事件到 Kafka
        kafkaTemplate.send("playback-events", PlaybackEvent(
            sessionId = sessionId,
            vehicleId = session.vehicleId,
            contentId = session.contentId,
            bytesDelta = bytesDelta,
            progressSeconds = progressSeconds,
            timestamp = Instant.now()
        ))
    }
}
```

### 4. 数据层：分库分表 + 多级缓存

#### 4.1 核心表设计

```sql
-- 播放会话表（按月分表，vehicle_id 哈希分库）
CREATE TABLE playback_session_202606 (
    session_id      VARCHAR(64)  NOT NULL PRIMARY KEY,
    vehicle_id      VARCHAR(32)  NOT NULL,
    user_id         BIGINT       NOT NULL,
    content_id      VARCHAR(64)  NOT NULL,
    content_type    TINYINT      NOT NULL COMMENT '1=音频 2=视频 3=游戏',
    profile_id      BIGINT       NOT NULL COMMENT '码率档位 ID',
    bitrate_kbps    INT          NOT NULL DEFAULT 0,
    bytes_consumed  BIGINT       NOT NULL DEFAULT 0,
    started_at      DATETIME(3)  NOT NULL,
    ended_at        DATETIME(3)  NULL,
    duration_sec    INT          NOT NULL DEFAULT 0,
    region          VARCHAR(8)   NOT NULL COMMENT 'ISO 3166-1 alpha-2',
    INDEX idx_vehicle_started (vehicle_id, started_at),
    INDEX idx_content (content_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  PARTITION BY RANGE (TO_DAYS(started_at)) (
    PARTITION p20260601 VALUES LESS THAN (TO_DAYS('2026-07-01')),
    PARTITION p20260701 VALUES LESS THAN (TO_DAYS('2026-08-01')),
    -- ...
  );

-- 内容元数据表（按 content_id 分 64 库 × 16 表）
CREATE TABLE content (
    content_id      VARCHAR(64)  NOT NULL,
    title           VARCHAR(256) NOT NULL,
    content_type    TINYINT      NOT NULL,
    duration_sec    INT          NOT NULL,
    size_bytes      BIGINT       NOT NULL,
    bitrate_profiles JSON        NOT NULL COMMENT '码率档位 JSON',
    drm_key_id      VARCHAR(64)  NULL,
    region_rights   JSON         NOT NULL COMMENT '版权区域许可',
    available       TINYINT      NOT NULL DEFAULT 1,
    created_at      DATETIME(3)  NOT NULL,
    updated_at      DATETIME(3)  NOT NULL,
    PRIMARY KEY (content_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 用户配额表（按 user_id 分 16 库）
CREATE TABLE user_quota (
    user_id         BIGINT       NOT NULL,
    vehicle_id      VARCHAR(32)  NOT NULL,
    period          CHAR(7)      NOT NULL COMMENT 'YYYY-MM',
    bytes_used      BIGINT       NOT NULL DEFAULT 0,
    bytes_quota     BIGINT       NOT NULL COMMENT '月度配额',
    plan            VARCHAR(32)  NOT NULL COMMENT '套餐',
    updated_at      DATETIME(3)  NOT NULL,
    PRIMARY KEY (user_id, vehicle_id, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### 4.2 配额管理：Redis 原子计数

月度配额是高频写（每 10 秒一次上报），用 Redis 累加 + DB 异步持久化：

```kotlin
@Component
class QuotaService(
    private val redisTemplate: RedisTemplate,
    private val quotaRepo: UserQuotaRepository
) {
    companion object {
        // Redis Key: quota:{userId}:{vehicleId}:{period}
        // Value: 已用字节数
        private const val KEY_PREFIX = "quota"
        private const val PERSIST_INTERVAL_SECONDS = 30
    }
    
    /**
     * 累加流量消耗（Redis INCRBY，O(1) 原子操作）
     */
    fun accumulateUsage(vehicleId: String, bytesDelta: Long) {
        val userId = userContext.getUserId(vehicleId)
        val period = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy-MM"))
        val key = "$KEY_PREFIX:$userId:$vehicleId:$period"
        
        // 原子累加
        val newValue = redisTemplate.opsForValue().increment(key, bytesDelta)
        
        // 检查是否超额（首次超额时发送告警）
        val quota = quotaRepo.findQuota(userId, vehicleId, period)
        if (newValue != null && newValue > quota.bytesQuota && newValue - bytesDelta <= quota.bytesQuota) {
            alertService.sendQuotaExceededAlert(userId, vehicleId)
        }
        
        // 定期持久化到 DB（每 30 秒一次）
        schedulePersist(key, userId, vehicleId, period)
    }
}
```

### 5. 网络切换处理：移动场景的精髓

车辆行驶中会在 4G/5G 基站间频繁切换，这是车载娱乐系统最大的"杀手"。处理不好会出现：

- TCP 连接断开重连（HTTP/2 流被废弃）
- TLS 握手耗时（每次切换 200-500ms）
- CDN 边缘节点切换（命中率归零）

```kotlin
// 网络切换检测 + 会话迁移
class NetworkHandoverHandler(
    private val quicClient: QuicClient
) {
    /**
     * 监听基站切换事件（Android: NetworkCallback / iOS: NWPathMonitor）
     */
    fun onNetworkChanged(oldIps: List<String>, newIps: List<String>) {
        // 1. 触发 QUIC 连接迁移（保留连接，不重建）
        quicClient.migrateConnection(newIps)
        
        // 2. 检查当前播放是否受影响
        if (currentPlayback.isPlaying) {
            // 3. 暂停上报事件，避免后台写入堆积
            pauseEventReporting()
            
            // 4. 等待 QUIC 迁移完成
            quicClient.awaitMigrationComplete()
            
            // 5. 恢复上报，补齐断网期间的事件
            resumeEventReporting()
        }
    }
}
```

> **关键洞察**：QUIC 的连接迁移（Connection Migration）是这个场景的核心收益。TCP 时代，IP 变化意味着连接重建，HTTP/2 流废弃；QUIC 用 Connection ID 标识连接，IP 变化不影响逻辑连接。

---

## 追问深度

### Q1：播放卡顿怎么定位？

**答**：卡顿定位的三板斧：

1. **客户端埋点**：缓冲次数、缓冲时长、首字节时间、码率切换次数
2. **服务端日志**：CDN 命中率、边缘节点延迟、回源率
3. **网络质量**：RTT、丢包率、信号强度（车机上报）

```kotlin
// 卡顿检测上报
class StutterDetector {
    private var lastFrameTime = 0L
    private var stallCount = 0
    
    fun onFrameDecoded() {
        val now = System.nanoTime()
        val delta = (now - lastFrameTime) / 1_000_000  // ms
        
        if (delta > STALL_THRESHOLD_MS) {  // 100ms
            stallCount++
            reportStall(delta)
        }
        lastFrameTime = now
    }
}
```

### Q2：CDN 成本怎么压？

**答**：三个层次：

1. **提高缓存命中率**：预热热门内容、LRU 策略优化、多 CDN 协同
2. **降级低优先级内容**：高清内容按需转码，老资源用低码率版本
3. **回源优化**：边缘节点合并请求、HTTP/2 多路复用

### Q3：弱网（< 2G/3G）下怎么办？

**答**：分级降级策略：

- **音频降级**：320kbps → 128kbps → 64kbps
- **视频降级**：4K → 1080p → 720p → 480p
- **暂停非关键流量**：停止后台预下载、暂停埋点上报
- **离线优先**：本地缓存的"已下载"内容优先播放

### Q4：版权合规（Netflix、Spotify 内容跨区域）怎么做？

**答**：

- 内容入库时打上 `region_rights` 标签（哪些国家可播）
- 车机请求时带 `region`（从 SIM 卡 MCC/MNC 推断）
- 服务端校验：内容.allowed_regions.contains(request.region)
- 不合规时返回 451（Unavailable For Legal Reasons）

### Q5：怎么做到秒级切换不卡顿？

**答**：在车机端做"预加载下一首/下一段"：

```kotlin
// 播放列表预加载
class PlaylistPreloader {
    fun preloadNext(currentTrack: Track) {
        val nextTrack = playlist.next(currentTrack)
        if (nextTrack != null && !localCache.exists(nextTrack.id)) {
            // 后台下载，缓冲 100% 后切换
            backgroundDownload(nextTrack, targetProgress = 1.0f)
        }
    }
}
```

---

## 常见坑

**1. 把车机当手机设计**：手机用户能接受 3 秒缓冲，车主不能（开车时分心）。设计时把"首屏时间 < 1s"当硬指标。

**2. 用 HTTP/2 over TCP**：4G 切换时 TCP 连接断流，HTTP/2 多路复用失效。换 QUIC 收益立竿见影。

**3. CDN 绑死一家**：单一 CDN 在区域性故障（比如 Cloudflare 2024 年那次大故障）时全军覆没。至少双 CDN。

**4. 本地缓存无限增长**：256GB 看着大，但 4K 电影一部 50GB，几部就满了。要做 LRU 淘汰 + 用户配额。

**5. 流量配额只在服务端校验**：车机端不做提示，车主跑到 90% 才知道。客户端要做"本月已用 X GB / 共 Y GB"实时显示。

**6. 弱网降级策略缺失**：3G 速度下还推 4K 视频，缓冲半小时不动。要做带宽自适应。

**7. 埋点上报反而消耗流量**：每 10 秒上报一次播放进度，一个月下来几十 MB 流量。要做"批量上报 + 压缩 + 错峰"。

**8. 内容冷热不分均匀缓存**：把所有内容都缓存，热门命中率被冷门拉低。要用 LFU + 预热双策略。

---

## 可执行 Checklist

设计评审时逐项打勾：

- [ ] 媒体面和控制面是否分离（媒体走 HTTPS，控制走 MQTT）
- [ ] 是否启用 QUIC / HTTP3
- [ ] 多 CDN 调度策略是否实现（不止一个 CDN）
- [ ] 车机端是否实现自适应码率（ABR）算法
- [ ] 是否有本地缓存策略（LRU + 预下载）
- [ ] 流量配额是否有 Redis 原子计数 + 异步持久化
- [ ] 基站切换时是否用 QUIC 连接迁移（非 TCP 重建）
- [ ] 弱网下是否有分级降级方案
- [ ] 版权合规校验是否覆盖（region_rights + 451 状态码）
- [ ] 卡顿检测埋点是否完整（首字节、缓冲、码率切换）
- [ ] CDN 缓存命中率监控是否接入（< 80% 告警）
- [ ] 流量消耗监控是否接入（月度配额 80% 告警）
- [ ] 跨区域容灾方案是否验证（至少一个区域故障可恢复）
- [ ] 弱网/断网压测是否做过（2G 模拟环境）

---

## 写在最后

车载娱乐系统的设计，**核心不是"音视频技术"，而是"移动场景的极致工程"**：

- 流量是钱：每 GB 成本在欧美 $5-15，车主心疼，特斯拉也心疼
- 网络是常态：4G/5G 切换、隧道、地下停车场、偏远地区，弱网是默认
- 车机是弱终端：CPU 比手机弱，不能无脑堆功能
- 合规是红线：版权、数据出境、GDPR、CCPA、PIPL，一个都不能少

把这四点想清楚，架构就稳了。后续 17 个系统设计题会逐一展开，每个都围绕"流量、数据、合规、体验"四个维度展开。

**下篇预告：第 2 篇 — 特斯拉车主积分管理系统（亿级车主积分、分布式事务、过期处理、实时一致性）**
