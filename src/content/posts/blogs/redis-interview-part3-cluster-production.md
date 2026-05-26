---
title: Redis 高频面试题（三）：持久化、集群与生产实践
description: 系统梳理 Redis 生产级核心考点：RDB/AOF 持久化原理与混合持久化、过期键删除策略、八种内存淘汰算法、全内存设计原因、主从复制与哨兵机制、Pipeline 批量优化、Cluster 集群原理与脑裂问题、Java 客户端选型（Jedis/Lettuce/Redisson）。附生产配置模板与上线 Checklist。
published: 2026-05-26
tags: [Redis, 面试, 集群, 持久化, 主从复制, 生产实践, 后端]
category: Guides
lang: zh_CN
---

前两篇覆盖了基础架构和缓存实战，这一篇聚焦**生产环境最核心的三个维度**：数据不丢（持久化）、数据能扩（集群）、客户端怎么选。

每一道题都对应着线上真实踩过的坑。

---

## Q18：Redis 的持久化机制是什么？各自的优缺点？

> 此题与第一篇 Q9 互补，侧重点不同：Q9 讲"怎么做"，Q18 讲"怎么选"。

### RDB 详细分析

**触发方式：**

```bash
# 自动触发（redis.conf）
save 900 1
save 300 10
save 60 10000

# 手动触发
SAVE    # 阻塞式，生产禁用
BGSAVE  # fork 子进程，非阻塞
```

**fork 子进程的代价：**

```
父进程（继续处理请求）
  └── fork() → 子进程（写 RDB 文件）
                └── 写完成后退出
```

fork 的内存开销是 O(1)（Copy-on-Write），但 fork 本身的耗时与内存大小成正比。16GB 内存的实例 fork 可能需要 200ms+，期间父进程阻塞。

**优点：**
- 二进制紧凑，备份恢复快
- 适合灾难恢复（定期快照）
- 对主进程性能影响小（fork 子进程）

**缺点：**
- 两次快照之间数据可能丢失
- fork 大内存实例时阻塞
- 快照频率高时磁盘 IO 压力大

### AOF 详细分析

**三种刷盘策略：**

| 策略 | 安全性 | 性能 | 适用场景 |
|------|--------|------|---------|
| `always` | 最高（不丢数据） | 最低 | 金融级场景 |
| `everysec` | 高（最多丢 1 秒） | 平衡 | **生产推荐** |
| `no` | 低（由 OS 决定） | 最高 | 容忍数据丢失 |

**AOF 重写：**

AOF 文件会随着命令增加而膨胀，重写可以压缩文件：

```conf
# 触发条件
auto-aof-rewrite-percentage 100  # 比上次重写后增长 100%
auto-aof-rewrite-min-size 64mb   # 文件至少 64MB 才重写
```

重写过程：fork 子进程 → 子进程写新 AOF → 父进程缓存增量命令 → 子进程完成后追增增量命令。

### 混合持久化（Redis 4.0+，生产推荐）

```conf
aof-use-rdb-preamble yes
```

AOF 文件结构：
```
┌─────────────────────────────────┐
│  RDB 格式（全量快照，快速加载）  │
├─────────────────────────────────┤
│  AOF 格式（增量命令，数据安全）  │
└─────────────────────────────────┘
```

### 选型决策树

```
需要强持久化？
├── 是 → AOF（appendfsync=always）
├── 容忍少量丢失？
│   ├── 是 → RDB + AOF 混合持久化（推荐）
│   └── 否 → 纯 RDB（仅缓存场景）
```

---

## Q19：Redis 常见性能问题和解决方案

> 第二篇 Q15 覆盖了大 key、热 key、慢查询等基础问题，此处补充更深入的生产问题。

### 问题 1：内存达到上限

```bash
# 查看内存使用
127.0.0.1:6379> INFO memory
used_memory:4294967296
maxmemory:4294967296
maxmemory_policy:allkeys-lru
```

```conf
# 必须配置 maxmemory，否则 Redis 会耗尽系统内存被 OOM Kill
maxmemory 4gb
maxmemory-policy allkeys-lru
```

### 问题 2：连接数耗尽

```bash
# 查看连接数
127.0.0.1:6379> INFO clients
connected_clients:10000

# 配置最大连接数
maxclients 10000
```

```kotlin
// 客户端必须使用连接池
val poolConfig = GenericObjectPoolConfig<Connection>().apply {
    maxTotal = 50        // 最大连接数
    maxIdle = 20         // 最大空闲连接
    minIdle = 5          // 最小空闲连接
    blockWhenExhausted = true
    maxWait = Duration.ofSeconds(3)
}
```

### 问题 3：主从复制延迟

```bash
# 查看复制延迟
127.0.0.1:6379> INFO replication
# Replication
role:slave
master_last_io_seconds_ago:5  # 超过 10 秒需告警
```

**解决：**
- 主从部署在同一机房，减少网络延迟
- 开启 `repl-diskless-sync yes`（无盘复制，适合 SSD）
- 设置 `min-replicas-to-write 1`（至少 1 个从节点同步才允许写入）

### 问题 4：AOF 文件损坏

```bash
# 修复 AOF 文件
redis-check-aof --fix appendonly.aof

# 修复 RDB 文件
redis-check-rdb dump.rdb
```

### 问题 5：CPU 单核打满

Redis 命令执行是单线程的，CPU 单核打满是正常现象。解决：

- 升级到更高主频的 CPU
- 部署多个 Redis 实例，分摊压力
- 使用集群模式水平扩展

---

## Q20：Redis 过期键的删除策略？

Redis 的过期键删除由两种策略协同工作：

### 1. 惰性删除（Lazy Free）

每次访问 key 时检查是否过期，过期则删除。

```c
// Redis 源码（简化）
robj *lookupKeyRead(redisDb *db, robj *key) {
    expireIfNeeded(db, key);  // 先检查过期
    return lookupKey(db, key);
}
```

### 2. 定时删除（Server Cron）

Redis 的 `serverCron` 函数（默认 100ms 执行一次）中调用 `activeExpireCycle()`：

```c
// 每次最多执行 25ms（避免阻塞）
#define ACTIVE_EXPIRE_CYCLE_DURATION 25

void activeExpireCycle(int type) {
    for (int i = 0; i < 20; i++) {
        key = getRandomKeyWithExpire();
        if (key is expired) deleteKey(key);
        if (elapsed > ACTIVE_EXPIRE_CYCLE_DURATION) break;
    }
}
```

### 3. 主动删除（UNLINK，Redis 4.0+）

```bash
# DEL：同步删除，大 key 会阻塞
DEL bigkey

# UNLINK：异步删除，不阻塞主线程
UNLINK bigkey
```

### 淘汰策略触发删除

当内存达到 `maxmemory` 时，根据 `maxmemory-policy` 主动淘汰 key。

> **面试要点**：三种删除方式各司其职——惰性删除负责"路过顺手删"，定时删除负责"定期扫垃圾"，淘汰策略负责"内存不够时腾空间"。

---

## Q21：Redis 的回收策略（淘汰策略）？

### 八种策略详解

```conf
# redis.conf
maxmemory-policy allkeys-lru
```

**策略分类：**

| 范围 | 策略 | 算法 | 说明 |
|------|------|------|------|
| 所有 key | `allkeys-lru` | LRU | 最近最少使用，最通用 |
| 所有 key | `allkeys-lfu` | LFU | 最少使用频率 |
| 所有 key | `allkeys-random` | 随机 | 随机淘汰 |
| 有过期时间 | `volatile-lru` | LRU | 只淘汰有过期的 |
| 有过期时间 | `volatile-lfu` | LFU | 只淘汰有过期的 |
| 有过期时间 | `volatile-random` | 随机 | 只淘汰有过期的 |
| 有过期时间 | `volatile-ttl` | TTL | 淘汰即将过期的 |
| 不淘汰 | `noeviction` | - | 写操作返回错误（默认） |

### LRU 实现（近似 LRU）

Redis 不是严格的 LRU，而是**采样 LRU**：

```c
// 随机采样 5 个 key，淘汰其中最久未使用的
#define LRU_SAMPLES 5

key = randomSample(5);
evict(key with oldest access time);
```

**为什么不是严格 LRU？** 严格 LRU 需要维护双向链表，每次访问都要移动节点，内存和 CPU 开销大。采样 LRU 用极小的开销达到近似效果。

### LFU 实现（Redis 4.0+）

LFU 记录每个 key 的访问频率，淘汰频率最低的：

```bash
# 查看 key 的 LFU 计数器
127.0.0.1:6379> OBJECT FREQ mykey
(integer) 5  # 被访问了 5 次
```

LFU 使用对数计数器，避免频率无限增长：访问频率随时间衰减，新 key 有机会竞争。

### 生产推荐

```conf
# 通用缓存场景
maxmemory-policy allkeys-lru

# 有明显热点数据（排行榜、热门商品）
maxmemory-policy allkeys-lfu
```

---

## Q22：为什么 Redis 需要把所有数据放到内存中？

### 核心原因：速度

```
内存访问延迟：~100ns
SSD 访问延迟：~100μs
HDD 访问延迟：~10ms

内存比 SSD 快 1000 倍
```

Redis 的设计目标是**亚毫秒级响应**，只有全内存才能实现。

### 架构设计的必然选择

Redis 是**数据结构服务器**，不是简单的 KV 缓存：

- Sorted Set 的范围查询需要内存中的跳表
- List 的两端操作需要内存中的双向链表
- Set 的交集并集需要内存中的哈希表

这些数据结构在磁盘上性能会下降几个数量级。

### 内存成本可控

- 2026 年内存价格：约 $3/GB（DDR4）
- 同等性能的 SSD 方案：需要复杂的分层存储架构
- Redis 支持集群水平扩展，内存可以分摊

### 持久化弥补内存易失

```
内存（快，易失）+ 持久化（慢，可靠）= 最佳组合
     ↓                    ↓
  实时读写            灾难恢复
```

> **面试要点**：全内存是 Redis 高性能的前提，持久化机制弥补了内存易失的缺陷，两者配合实现了速度与可靠性的平衡。

---

## Q23：Redis 的同步机制了解么？

### 主从复制（Replication）

**全量同步（首次连接）：**

```
Master                          Slave
  │                               │
  │  1. PSYNC ? -1               │  ← Slave 请求全量同步
  │  2. BGSAVE 生成 RDB          │
  │  3. 发送 RDB 文件 ──────────→│
  │  4. 发送缓冲区增量命令 ─────→│
  │                               │
  │  ←──── 后续增量同步 ─────────→│
```

**增量同步（断线重连）：**

```
Master                          Slave
  │                               │
  │  1. PSYNC <runid> <offset>   │  ← Slave 发送上次同步位置
  │  2. 判断 offset 是否在缓冲区  │
  │  3a. 在 → 发送增量命令 ─────→│  ← 增量同步
  │  3b. 不在 → 全量同步          │  ← 缓冲区溢出，退化为全量
```

**复制缓冲区：**

```conf
# 主节点配置
repl-backlog-size 64mb    # 复制缓冲区大小
repl-diskless-sync yes    # 无盘复制（适合 SSD）
```

### 哨兵机制（Sentinel）

```
        ┌──────────┐
        │ Sentinel │ ×3（奇数）
        └────┬─────┘
             │ 监控
    ┌────────┼────────┐
    │        │        │
┌───┴───┐ ┌──┴───┐ ┌──┴───┐
│Master │ │Slave │ │Slave │
└───────┘ └──────┘ └──────┘
```

**故障转移流程：**

1. **主观下线（SDOWN）**：单个 Sentinel 判断主节点不可达
2. **客观下线（ODOWN）**：多数 Sentinel 判断主节点不可达
3. **选举 Leader Sentinel**：Raft 算法选举
4. **提升从节点**：选一个从节点提升为主节点
5. **配置更新**：通知客户端新的主节点地址

```bash
# 哨兵配置
sentinel monitor mymaster 127.0.0.1 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 10000
sentinel parallel-syncs mymaster 1
```

> **面试要点**：主从复制是基础，哨兵解决自动故障转移，两者配合实现高可用。

---

## Q24：Pipeline 有什么好处，为什么要用 Pipeline？

### 问题：网络往返延迟

```
不使用 Pipeline：
客户端 → SET a 1    → 服务端（1 RTT）
客户端 ← OK         ← 服务端
客户端 → SET b 2    → 服务端（1 RTT）
客户端 ← OK         ← 服务端
客户端 → SET c 3    → 服务端（1 RTT）
客户端 ← OK         ← 服务端
总计：3 RTT
```

```
使用 Pipeline：
客户端 → SET a 1 → SET b 2 → SET c 3 → 服务端（1 RTT）
客户端 ← OK ← OK ← OK                          ← 服务端
总计：1 RRT
```

### 代码示例

```kotlin
// ❌ 不使用 Pipeline：N 次网络往返
for (i in 1..1000) {
    redis.set("key:$i", "value:$i")  // 每次 1 RTT
}

// ✅ 使用 Pipeline：1 次网络往返
val pipeline = redis.pipelined()
for (i in 1..1000) {
    pipeline.set("key:$i", "value:$i")  // 命令入队
}
pipeline.sync()  // 一次性发送，1 RTT
```

### 性能对比

| 场景 | 不使用 Pipeline | Pipeline（100 条） |
|------|----------------|-------------------|
| 1000 次 SET | ~1000 RTT | ~10 RTT |
| 延迟（跨机房 2ms） | ~2000ms | ~20ms |
| 吞吐量 | ~500 ops/s | ~50000 ops/s |

### 注意事项

- Pipeline 不是原子的，中间命令失败不影响其他命令
- 单次 Pipeline 命令数建议控制在 **100~500** 条，避免缓冲区溢出
- Pipeline 适合批量写入，不适合需要依赖前一条命令结果的场景

---

## Q25：是否使用过 Redis 集群，集群的原理是什么？

### Cluster 架构

```
┌─────────────────────────────────────────────┐
│              Redis Cluster                   │
│                                             │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │ Master1 │  │ Master2 │  │ Master3 │    │
│  │ 0-5460  │  │5461-10922│  │10923-16383│  │
│  │  ┌───┐  │  │  ┌───┐  │  │  ┌───┐  │    │
│  │  │S1 │  │  │  │S2 │  │  │  │S3 │  │    │
│  │  └───┘  │  │  └───┘  │  │  └───┘  │    │
│  └─────────┘  └─────────┘  └─────────┘    │
└─────────────────────────────────────────────┘
```

### 哈希槽（Hash Slot）

Redis Cluster 将整个键空间划分为 **16384 个槽**：

```python
# 计算 key 所属的槽
slot = CRC16(key) % 16384
```

```bash
# 查看 key 所属的槽
127.0.0.1:6379> CLUSTER KEYSLOT mykey
(integer) 12345
```

### 请求路由

```bash
# 客户端请求路由
请求 key="user:10001"
  → CRC16("user:10001") % 16384 = 7890
  → 槽 7890 在 Master2 上
  → 请求转发到 Master2
```

如果客户端连接的是错误的节点，服务端返回 `MOVED` 重定向：

```bash
-MOVED 7890 192.168.1.2:6379
```

### 集群扩容

```bash
# 添加新节点
redis-cli --cluster add-node 192.168.1.4:6379 192.168.1.1:6379

# 重新分配槽（在线迁移）
redis-cli --cluster reshard 192.168.1.1:6379
```

迁移过程中，对正在迁移的 key 请求返回 `ASK` 重定向（临时重定向，与 `MOVED` 不同）。

### Gossip 协议

集群节点间通过 Gossip 协议交换状态信息：

```
节点 A ──PING/PONG──→ 节点 B（交换已知节点列表）
节点 B ──PING/PONG──→ 节点 C
节点 C ──PING/PONG──→ 节点 A
```

每个节点每秒随机选择几个节点交换信息，故障检测约 15 秒。

---

## Q26：Redis 集群方案什么情况下会导致整个集群不可用？

### 1. 多数主节点同时故障

Redis Cluster 需要**半数以上主节点在线**才能正常服务。3 主节点集群，挂 2 个主节点即不可用。

```
3 主集群：最多容忍 1 个主节点故障
5 主集群：最多容忍 2 个主节点故障
```

### 2. 脑裂（Split-Brain）

网络分区导致出现两个"主集群"，各自接受写入，网络恢复后数据冲突。

```bash
# 防止脑裂的配置
min-replicas-to-write 1      # 主节点至少 1 个从节点在线才允许写入
min-replicas-max-lag 10      # 从节点复制延迟超过 10 秒视为离线
```

### 3. 槽未完全覆盖

如果某些槽没有分配给任何节点，访问这些槽的 key 会报错：

```bash
-CLUSTERDOWN The cluster is down
```

```bash
# 检查槽覆盖情况
redis-cli --cluster check 127.0.0.1:6379
```

### 4. 全量同步导致主节点阻塞

主从全量同步时 fork 子进程 + 网络传输，如果多个从节点同时全量同步，主节点可能过载。

### 5. 内存达到上限且策略为 noeviction

```conf
# 危险配置
maxmemory-policy noevervation  # 内存满时所有写操作报错
```

---

## Q27：Redis 支持的 Java 客户端都有哪些？官方推荐用哪个？

### 三大主流客户端对比

| 客户端 | 线程模型 | 支持集群 | 连接池 | 特点 |
|--------|---------|---------|--------|------|
| Jedis | 多线程 + 连接池 | ✅ | 需自行管理 | API 直观，社区活跃 |
| Lettuce | 单连接 + 事件驱动 | ✅ | 内置 | Spring Boot 默认，支持响应式 |
| Redisson | 多线程 | ✅ | 内置 | 功能最丰富，分布式锁/集合 |

### 代码示例

**Jedis：**

```kotlin
// 需要手动管理连接池
val pool = JedisPool("localhost", 6379)
pool.resource.use { jedis ->
    jedis.set("key", "value")
    val value = jedis.get("key")
}
```

**Lettuce（Spring Boot 默认）：**

```kotlin
@Service
class UserService(
    private val redisTemplate: RedisTemplate<String, String>
) {
    fun getUser(id: String): String? {
        return redisTemplate.opsForValue().get("user:$id")
    }
}
```

**Redisson（分布式锁/集合）：**

```kotlin
val redisson: RedissonClient = Redisson.create(config)

// 分布式锁
val lock = redisson.getLock("order:lock:$orderId")
try {
    lock.tryLock(10, 30, TimeUnit.SECONDS)
    // 业务逻辑
} finally {
    lock.unlock()
}

// 分布式集合
val set = redisson.getSet<String>("online:users")
set.add("user:10001")
```

### 官方推荐

**Spring Boot 2.0+ 默认使用 Lettuce**，原因：

1. 基于 Netty，支持异步和非阻塞 IO
2. 单连接支持多线程并发（减少连接数）
3. 原生支持 Redis Sentinel 和 Cluster
4. 支持响应式编程（Reactive Redis）

```kotlin
// Spring Boot 配置
@Configuration
class RedisConfig {
    @Bean
    fun redisTemplate(factory: LettuceConnectionFactory): RedisTemplate<String, String> {
        return RedisTemplate<String, String>().apply {
            connectionFactory = factory
            keySerializer = StringRedisSerializer()
            valueSerializer = GenericJackson2JsonRedisSerializer()
        }
    }
}
```

---

## 常见坑

- **集群槽未覆盖**：扩容后忘记迁移槽，部分 key 不可访问
- **Pipeline 过大**：单次发送上万条命令，导致服务端输出缓冲区溢出
- **主从复制风暴**：新从节点加入触发全量同步，主节点 fork 阻塞
- **脑裂写入**：未配置 `min-replicas-to-write`，网络分区时双主写入
- **客户端连接泄漏**：未正确关闭连接，耗尽 Redis 连接数

## 可执行 Checklist

- [ ] 是否部署了至少 3 主 3 从的 Cluster 集群？
- [ ] 是否配置了 `min-replicas-to-write 1` 防止脑裂？
- [ ] 是否禁用了危险命令（FLUSHALL、KEYS）？
- [ ] 是否配置了合理的 `maxclients`？
- [ ] 批量操作是否使用了 Pipeline？
- [ ] 客户端是否正确使用了连接池？
- [ ] 是否配置了监控告警（内存、连接数、复制延迟）？
