---
title: Redis 高频面试题（一）：基础架构与数据结构
description: 从生产事故切入，系统梳理 Redis 基础架构核心考点：大量 key 同时过期的隐患、实例容量上限、内存优化手段、过期时间配置、事务命令、与 Memcache 的本质区别、单线程模型、字符串最大容量、RDB 与 AOF 持久化机制。附面试答题模板与生产避坑清单。
published: 2026-05-26
tags: [Redis, 面试, 缓存, 数据结构, 持久化, 后端]
category: Guides
lang: zh_CN
---

很多团队第一次在生产环境大规模使用 Redis，都会踩同一个坑：

- 大促零点，缓存集体失效，数据库被打挂
- 内存报警频繁，却不知道哪些 key 在吃内存
- 以为 Redis 是"多线程"的，选型时做了错误假设

Redis 的面试题看似基础，但每一道背后都对应着真实的生产事故。这篇文章是系列第一篇，聚焦**基础架构与数据结构**，帮你把"背题"变成"能讲清楚为什么"。

---

## Q1：如果有大量的 key 需要设置同一时间过期，一般需要注意什么？

这是面试中最常见的"陷阱题"，考察的是对 Redis 过期删除机制的理解。

**核心风险：大量 key 同时过期会导致请求延迟抖动。**

Redis 的过期键删除是**惰性删除 + 定期删除**的混合策略。当大量 key 在同一时刻过期时：

1. **定期删除压力集中**：Redis 默认每 100ms 随机抽取 20 个 key 检查过期，如果同时过期的 key 数量巨大，单次定期删除可能耗时过长，阻塞主线程
2. **内存释放延迟**：过期键不会立即从内存释放，短时间内内存占用不会下降
3. **缓存雪崩风险**：如果这些 key 是缓存数据，同时失效会导致请求穿透到数据库

**生产实践：在过期时间上叠加随机抖动。**

```kotlin
// ❌ 危险：所有 key 在同一时刻过期
val ttl = 3600 // 1 小时整
redis.set("hot:item:$itemId", data, ttl)

// ✅ 安全：叠加随机抖动，打散过期时间
val baseTtl = 3600
val jitter = Random.nextInt(0, 300) // 0~5 分钟随机偏移
redis.set("hot:item:$itemId", data, baseTtl + jitter)
```

> **面试答题模板**：先指出风险（延迟抖动 + 雪崩），再给出解决方案（过期时间加随机值），最后补充 Redis 的删除策略作为理论支撑。

---

## Q2：一个 Redis 实例最多能存放多少 keys？List、Set、Sorted Set 最多能存放多少元素？

**理论上限：**

| 维度 | 上限 |
|------|------|
| 实例最大 key 数 | 2^32 ≈ 42.9 亿（32 位系统）/ 2^64（64 位系统） |
| List 最大元素数 | 2^32 - 1 ≈ 42.9 亿 |
| Set 最大元素数 | 2^32 - 1 ≈ 42.9 亿 |
| Sorted Set 最大元素数 | 2^32 - 1 ≈ 42.9 亿 |
| Hash 最大字段数 | 2^32 - 1 ≈ 42.9 亿 |

**实际瓶颈：内存。**

一个空 Redis 实例内存约 3MB，但每个 key 本身有约 100 字节的开销。假设服务器有 64GB 内存，实际可用约 50GB，按每个 key 平均 1KB 计算，大约能存放 5000 万个 key。

**生产建议：**

- 单个实例 key 数控制在**千万级**以内，超过后考虑分片或集群
- 大集合（百万级元素）会阻塞主线程，应拆分为多个小 key
- 使用 `MEMORY USAGE key` 命令查看单个 key 的内存占用

```bash
# 查看 key 内存占用
127.0.0.1:6379> MEMORY USAGE user:profile:10001
(integer) 2672

# 查看实例整体内存
127.0.0.1:6379> INFO memory
# Memory
used_memory:536870912
used_memory_human:512.00M
```

---

## Q3：都有哪些办法可以降低 Redis 的内存使用情况？

内存是 Redis 最核心的资源，以下是经过生产验证的优化手段：

### 1. 数据结构选择

```bash
# ❌ 浪费：每个字段一个 key
SET user:10001:name "Lance"
SET user:10001:age "28"
SET user:10001:city "Beijing"

# ✅ 节省：使用 Hash，ziplist 编码更紧凑
HSET user:10001 name "Lance" age "28" city "Beijing"
```

当 Hash/Set/Sorted Set 元素较少且值较小时，Redis 会使用 **ziplist/intset** 编码，内存占用可降低 50%~80%。

### 2. 配置 ziplist 阈值

```conf
# redis.conf
hash-max-ziplist-entries 512
hash-max-ziplist-value 64
set-max-intset-entries 512
zset-max-ziplist-entries 128
zset-max-ziplist-value 64
```

### 3. 开启内存压缩（Redis 7.0+）

```conf
# List 类型启用 quicklist 压缩
list-compress-depth 1
```

### 4. 设置合理的过期时间

不要让 key 无限增长，对临时数据务必设置 TTL。

### 5. 使用 32 位 Redis（仅限内存 < 4GB 场景）

32 位版本每个 key 的指针开销更小，但总内存不能超过 4GB。

### 6. 内存淘汰策略

```conf
# 内存达到上限时的行为
maxmemory 4gb
maxmemory-policy allkeys-lru
```

> **面试答题模板**：按"数据结构优化 → 编码优化 → 配置优化 → 淘汰策略"的层次回答，体现系统性思维。

---

## Q4：Redis key 的过期时间和永久有效分别怎么设置？

```bash
# 设置过期时间（秒）
SET session:abc123 "data" EX 3600
# 或
EXPIRE session:abc123 3600

# 设置过期时间（毫秒）
PSET session:abc123 "data" PX 3600000
# 或
PEXPIRE session:abc123 3600000

# 设置过期时间点（Unix 时间戳，秒）
EXPIREAT session:abc123 1748275200

# 设置过期时间点（Unix 时间戳，毫秒）
PEXPIREAT session:abc123 1748275200000

# 取消过期时间（设为永久）
PERSIST session:abc123

# 查看剩余生存时间（秒）
TTL session:abc123

# 查看剩余生存时间（毫秒）
PTTL session:abc123
```

**返回值说明：**

- `TTL` 返回 `-1`：key 存在且没有设置过期时间（永久有效）
- `TTL` 返回 `-2`：key 不存在

**生产注意：**

```kotlin
// ❌ 常见错误：先 SET 再 EXPIRE，非原子操作
redis.set("order:lock:$orderId", "1")
redis.expire("order:lock:$orderId", 30) // 如果这行失败，key 永不过期！

// ✅ 正确：使用原子操作
redis.set("order:lock:$orderId", "1", 30) // SET NX EX 原子操作
```

---

## Q5：Redis 事务相关的命令有哪几个？

Redis 事务的核心命令：

| 命令 | 作用 |
|------|------|
| `MULTI` | 开启事务，后续命令入队 |
| `EXEC` | 执行事务队列中的所有命令 |
| `DISCARD` | 取消事务，清空命令队列 |
| `WATCH` | 监视 key，实现乐观锁 |
| `UNWATCH` | 取消对所有 key 的监视 |

**基本用法：**

```bash
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> SET account:A 100
QUEUED
127.0.0.1:6379> SET account:B 200
QUEUED
127.0.0.1:6379> EXEC
1) OK
2) OK
```

**WATCH 实现乐观锁（CAS）：**

```bash
# 客户端 A
127.0.0.1:6379> WATCH balance
OK
127.0.0.1:6379> GET balance
"100"
# ... 计算新值 ...
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> SET balance 80
QUEUED
127.0.0.1:6379> EXEC
(nil)  # 如果 balance 被其他客户端修改，事务失败
```

> **面试要点**：Redis 事务**不保证原子性**（命令入队失败会跳过，不会回滚），这是与 MySQL 事务最大的区别。

---

## Q6：Memcache 与 Redis 的区别都有哪些？

这是经典的对比题，从多个维度回答：

| 维度 | Memcache | Redis |
|------|----------|-------|
| 数据类型 | 仅 String | String、Hash、List、Set、Sorted Set、Bitmap、HyperLogLog、Stream |
| 持久化 | 不支持 | RDB + AOF |
| 线程模型 | 多线程 | 单线程（6.0 后 IO 多线程） |
| 内存管理 | Slab 分配，无内存回收 | 支持多种淘汰策略 |
| 集群 | 客户端分片 | 原生 Cluster 集群 |
| 事务 | 不支持 | MULTI/EXEC（有限支持） |
| Lua 脚本 | 不支持 | 支持 |
| 发布订阅 | 不支持 | 支持 |
| 适用场景 | 简单 KV 缓存 | 缓存 + 数据结构服务 + 消息队列 |

**选型建议：**

- 纯 KV 缓存、多核利用率高 → Memcache
- 需要复杂数据结构、持久化、高可用 → Redis

---

## Q7：Redis 是单进程单线程的？

**准确说法：Redis 的核心命令处理是单线程的。**

Redis 6.0 之前的架构：

```
客户端请求 → 单线程事件循环 → 命令执行 → 返回结果
```

Redis 6.0 引入了 **IO 多线程**（默认关闭）：

```
客户端请求 → IO 多线程（读写网络）→ 单线程命令执行 → IO 多线程（写回网络）
```

**配置开启 IO 多线程：**

```conf
# redis.conf
io-threads 4
io-threads-do-reads yes
```

**为什么命令执行仍保持单线程？**

1. **避免锁竞争**：Redis 的数据结构不是线程安全的，加锁会抵消多线程收益
2. **保证原子性**：单线程天然保证命令的原子执行
3. **性能足够**：Redis 的瓶颈通常在网络 IO 而非 CPU

> **面试答题模板**：先澄清"单线程"的准确含义（命令处理单线程），再说明 6.0 的 IO 多线程改进，最后解释为什么命令执行不采用多线程。

---

## Q8：一个字符串类型的值能存储最大容量是多少？

**512MB。**

```bash
# Redis 字符串最大长度
127.0.0.1:6379> SET bigkey "x"  # 最大 512MB
```

**实际生产建议：**

- 单个 String 值控制在 **10KB** 以内
- 超过 100KB 的 String 会被视为大 key，需要拆分
- 大 key 的危害：
  - 读取阻塞主线程
  - 网络传输慢
  - 内存分配不连续

```kotlin
// ❌ 危险：存储大 JSON
redis.set("user:profile:$userId", largeJsonString) // 可能几百 KB

// ✅ 推荐：拆分为 Hash
redis.hset("user:profile:$userId", mapOf(
    "name" to user.name,
    "age" to user.age.toString(),
    "city" to user.city
))
```

---

## Q9：Redis 持久化机制

Redis 提供两种持久化方式：

### RDB（Redis Database）

**原理**：在指定时间点生成内存快照，保存到磁盘。

```conf
# redis.conf
save 900 1      # 900 秒内至少 1 个 key 变化
save 300 10     # 300 秒内至少 10 个 key 变化
save 60 10000   # 60 秒内至少 10000 个 key 变化
```

**优点：**
- 文件紧凑，适合备份和灾难恢复
- 恢复速度快（直接加载二进制文件）
- 对性能影响小（fork 子进程执行）

**缺点：**
- 可能丢失最后一次快照之后的数据
- fork 大内存实例时可能阻塞

### AOF（Append Only File）

**原理**：记录每一条写命令，重启时重放恢复。

```conf
# redis.conf
appendonly yes
appendfsync everysec  # 每秒刷盘（推荐）
# appendfsync always   # 每条命令刷盘（最安全，最慢）
# appendfsync no       # 由 OS 决定（最快，最不安全）
```

**优点：**
- 数据安全性高（最多丢 1 秒数据）
- 文件可读，可人工修复

**缺点：**
- 文件体积大
- 恢复速度慢
- 重写时也需要 fork

### 生产推荐：RDB + AOF 混合持久化（Redis 4.0+）

```conf
aof-use-rdb-preamble yes
```

AOF 文件前半部分是 RDB 格式（快速加载），后半部分是 AOF 格式（增量命令），兼顾恢复速度和数据安全。

---

## 常见坑

- **大量 key 同时过期**：忘记加随机抖动，导致缓存雪崩
- **大 key 无感知**：单个 String 超过 100KB 未拆分，拖慢整个实例
- **事务误用**：以为 Redis 事务能回滚，实际命令错误不会回滚
- **持久化配置不当**：只开 RDB 且 save 间隔太长，故障时数据丢失严重
- **永久 key 泄漏**：临时数据没设 TTL，内存持续增长直到 OOM

## 可执行 Checklist

- [ ] 所有缓存 key 的过期时间是否加了随机抖动（至少 ±5%）？
- [ ] 是否定期用 `MEMORY USAGE` 检查大 key？
- [ ] 临时数据是否都设置了 TTL？
- [ ] 是否开启了 AOF + RDB 混合持久化？
- [ ] `appendfsync` 是否设置为 `everysec`？
- [ ] 是否配置了 `maxmemory` 和淘汰策略？
