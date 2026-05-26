---
title: Redis 高频面试题（二）：缓存实战与性能优化
description: 系统梳理缓存工程核心考点：雪崩/穿透/预热/更新/降级五大场景的成因与解法、冷热数据分层策略、单线程高性能原理、八种数据类型的适用场景、过期策略与八种内存淘汰算法、常见性能问题与解决方案、Lua 脚本保证原子性。附 Kotlin 代码示例与生产上线清单。
published: 2026-05-26
tags: [Redis, 面试, 缓存, 性能优化, 内存淘汰, 后端]
category: Guides
lang: zh_CN
---

缓存是 Redis 最核心的使用场景，也是事故高发区。

- 大促零点，缓存集体失效，数据库连接池耗尽
- 恶意请求不存在的 key，每次穿透打到数据库
- 热 key 导致单节点 CPU 打满，集群流量不均

这篇文章是系列第二篇，聚焦**缓存实战与性能优化**。每道题都对应一个真实的生产场景，帮你从"知道答案"升级到"能讲清楚为什么"。

---

## Q10：缓存雪崩、缓存穿透、缓存预热、缓存更新、缓存降级

这五个概念是缓存面试的必考点，也是生产中最常遇到的问题。

### 缓存雪崩

**现象**：大量缓存 key 在同一时刻失效，请求全部打到数据库，导致数据库过载甚至宕机。

**解法：**

```kotlin
// 1. 过期时间加随机抖动（最重要）
fun cacheWithJitter(key: String, data: String, baseTtl: Long) {
    val jitter = Random.nextLong(0, 300) // 0~5 分钟随机偏移
    redis.set(key, data, baseTtl + jitter)
}

// 2. 热点数据永不过期 + 后台异步更新
fun cacheHotData(key: String, data: String) {
    redis.set(key, data) // 不设 TTL
    // 后台定时任务每 30 秒刷新一次
}

// 3. 多级缓存兜底
fun getWithMultiLevel(key: String): String? {
    return localCache.get(key)           // L1: 本地缓存（Caffeine）
        ?: redis.get(key)                // L2: Redis
        ?: loadFromDb(key)?.also {       // L3: 数据库
            redis.set(key, it, 3600)
        }
}
```

### 缓存穿透

**现象**：请求查询的 key 在缓存和数据库中都不存在，每次都穿透打到数据库。常见于恶意攻击。

**解法：**

```kotlin
// 1. 缓存空值（最常用）
fun getUser(userId: String): User? {
    val cached = redis.get("user:$userId")
    if (cached == "NULL") return null  // 空值标记
    if (cached != null) return JSON.parse(cached)

    val user = db.selectUser(userId)
    if (user == null) {
        redis.set("user:$userId", "NULL", 300) // 空值缓存 5 分钟
        return null
    }
    redis.set("user:$userId", JSON.stringify(user), 3600)
    return user
}

// 2. 布隆过滤器（适合数据量大的场景）
val bloomFilter = BloomFilter.create(
    Funnels.stringFunnel(Charset.defaultCharset()),
    100_000_000,  // 预期元素数
    0.001         // 误判率 0.1%
)

fun getUserWithBloom(userId: String): User? {
    if (!bloomFilter.mightContain(userId)) {
        return null  // 一定不存在，直接返回
    }
    return getUser(userId)
}
```

### 缓存预热

**现象**：系统刚启动或缓存失效后，大量请求同时打到数据库。

**解法：**

```kotlin
// 启动时预加载热点数据
@Component
class CacheWarmer(
    private val redis: RedisClient,
    private val hotKeyRepository: HotKeyRepository
) : ApplicationRunner {

    override fun run(args: ApplicationArguments) {
        val hotKeys = hotKeyRepository.findTopN(1000)
        hotKeys.forEach { key ->
            val data = loadFromDb(key)
            redis.set(key, data, key.ttl)
        }
        log.info("缓存预热完成，共加载 ${hotKeys.size} 个热点 key")
    }
}
```

### 缓存更新

**策略对比：**

| 策略 | 一致性 | 实现复杂度 | 适用场景 |
|------|--------|-----------|----------|
| Cache Aside（旁路缓存） | 最终一致 | 低 | 读多写少，最常用 |
| Read/Write Through | 强一致 | 中 | 有缓存中间件支持 |
| Write Behind（异步写） | 最终一致 | 高 | 写多读少，容忍延迟 |

**Cache Aside 标准流程：**

```kotlin
// 读：先查缓存，未命中查数据库并回填
fun readData(key: String): String {
    return redis.get(key) ?: loadFromDb(key).also {
        redis.set(key, it, 3600)
    }
}

// 写：先更新数据库，再删除缓存（不是更新缓存！）
fun writeData(key: String, data: String) {
    db.update(key, data)      // 1. 更新数据库
    redis.del(key)            // 2. 删除缓存（非更新）
}
```

> **为什么删除而不是更新缓存？** 并发写场景下，两个线程同时写，可能先写库的反而后更新缓存，导致脏数据。删除缓存让下次读请求回填，更安全。

### 缓存降级

**现象**：Redis 不可用时，系统如何保证可用性。

```kotlin
@Component
class CacheService(
    private val redis: RedisClient,
    private val db: DatabaseClient
) {
    fun getData(key: String): String {
        return try {
            redis.get(key) ?: loadAndCache(key)
        } catch (e: RedisException) {
            log.warn("Redis 不可用，降级到数据库", e)
            db.load(key)  // 降级：直接查数据库
        }
    }
}
```

---

## Q11：热点数据和冷数据是什么

**热点数据（Hot Data）**：访问频率高、QPS 集中的数据。

- 示例：秒杀商品库存、热门文章详情、明星用户资料
- 特点：占总数据量不到 20%，但可能贡献 80% 的访问量

**冷数据（Cold Data）**：访问频率极低的数据。

- 示例：一年前订单、注销用户数据、过期活动配置
- 特点：几乎不被访问，但占用内存

**分层策略：**

```kotlin
// 热点数据：本地缓存 + Redis 双保险
fun getHotData(key: String): String {
    return caffeineCache.get(key) {
        redis.get(key) ?: loadFromDb(key)
    }
}

// 冷数据：只存 Redis，设置较短 TTL
fun getColdData(key: String): String? {
    return redis.get(key) // 冷数据允许穿透到数据库
}
```

---

## Q12：单线程的 Redis 为什么这么快

这是面试最高频的问题之一，需要从多个层面回答：

### 1. 纯内存操作

Redis 的所有数据都在内存中，读写操作是内存级别的，天然比磁盘快 1000 倍以上。

### 2. 单线程避免上下文切换

多线程的 CPU 上下文切换（保存/恢复寄存器、切换页表）有开销。单线程完全避免了这个问题。

### 3. IO 多路复用（epoll/kqueue）

Redis 使用 **epoll**（Linux）或 **kqueue**（macOS）实现 IO 多路复用，单线程可以同时处理数千个连接：

```
客户端1 ──┐
客户端2 ──┼──→ epoll 事件循环 ──→ 单线程命令执行
客户端3 ──┘
```

### 4. 高效的数据结构

- SDS（Simple Dynamic String）：O(1) 获取长度，避免缓冲区溢出
- 跳表（Skip List）：Sorted Set 的底层实现，查找 O(log N)
- 压缩列表（Zip List）：小数据量时内存紧凑，顺序读取快
- 哈希表（Dict）：O(1) 查找，渐进式 rehash 避免阻塞

### 5. 渐进式操作

- **渐进式 rehash**：哈希表扩容时，每次操作只迁移一个桶，避免长时间阻塞
- **渐进式删除**：`UNLINK` 命令异步释放大 key 内存，不阻塞主线程

> **面试答题模板**：按"内存 → 单线程 → IO 多路复用 → 数据结构"的层次回答，每层一个关键词，简洁有力。

---

## Q13：Redis 的数据类型，以及每种数据类型的使用场景

| 类型 | 底层结构 | 典型场景 |
|------|---------|---------|
| String | SDS / int | 缓存、计数器、分布式锁、Session |
| Hash | ZipList / HashTable | 用户信息、商品详情、购物车 |
| List | QuickList | 消息队列、最新列表、时间线 |
| Set | IntSet / HashTable | 标签系统、共同好友、抽奖去重 |
| Sorted Set | SkipList + HashTable | 排行榜、延迟队列、范围查询 |
| Bitmap | String | 签到统计、在线状态、布隆过滤器 |
| HyperLogLog | 基数估计 | UV 统计、独立访客计数 |
| Stream | Radix Tree | 消息队列（类 Kafka）、事件溯源 |
| GEO | Sorted Set | 附近的人、地理位置搜索 |

**代码示例：**

```kotlin
// String：分布式锁
redis.set("lock:order:$orderId", "1", nx = true, ex = 30)

// Hash：用户资料
redis.hset("user:$userId", mapOf(
    "name" to "Lance",
    "level" to "3",
    "coins" to "1000"
))

// List：最新 10 条消息
redis.lpush("msg:timeline:$userId", message)
redis.ltrim("msg:timeline:$userId", 0, 9) // 只保留最新 10 条

// Set：标签去重
redis.sadd("article:$articleId:tags", "Redis", "缓存", "面试")

// Sorted Set：实时排行榜
redis.zadd("rank:daily", mapOf("userA" to 95.5, "userB" to 88.0))
redis.zrevrange("rank:daily", 0, 9) // Top 10

// Bitmap：用户签到
redis.setbit("sign:$userId:$month", day - 1, 1)
redis.bitcount("sign:$userId:$month") // 本月签到天数

// HyperLogLog：UV 统计
redis.pfadd("uv:$date", userId)
redis.pfcount("uv:$date") // 当日 UV（误差约 0.81%）
```

---

## Q14：Redis 的过期策略以及内存淘汰机制

### 过期策略

Redis 采用**惰性删除 + 定期删除**的混合策略：

**1. 惰性删除（Lazy Expiration）**

每次访问 key 时检查是否过期，过期则删除。

```bash
# 读取时触发
127.0.0.1:6379> GET expired_key
(nil)  # 发现过期，立即删除
```

**优点**：不浪费 CPU
**缺点**：如果过期 key 从不被访问，会一直占用内存

**2. 定期删除（Periodic Expiration）**

Redis 每隔 100ms 随机抽取 20 个设置了过期时间的 key，删除其中过期的。

```c
// Redis 源码（简化）
activeExpireCycle() {
    for (i = 0; i < 20; i++) {
        key = randomKeyWithExpire();
        if (isExpired(key)) deleteKey(key);
        if (elapsedTime > 25ms) break;  // 最多执行 25ms
    }
}
```

**优点**：防止过期 key 堆积
**缺点**：随机抽取，可能漏删大量过期 key

### 内存淘汰策略

当内存达到 `maxmemory` 限制时，触发淘汰：

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| `noeviction` | 不淘汰，写入返回错误 | 不允许数据丢失（默认） |
| `allkeys-lru` | 所有 key 中淘汰最近最少使用 | 通用缓存，最推荐 |
| `allkeys-lfu` | 所有 key 中淘汰最少使用频率 | 访问频率差异明显 |
| `allkeys-random` | 随机淘汰所有 key | 所有 key 价值相同 |
| `volatile-lru` | 有过期时间的 key 中淘汰 LRU | 部分数据需要持久 |
| `volatile-lfu` | 有过期时间的 key 中淘汰 LFU | 部分数据需要持久 |
| `volatile-random` | 随机淘汰有过期时间的 key | 简单场景 |
| `volatile-ttl` | 淘汰即将过期的 key | 明确知道哪些数据快过期 |

```conf
# redis.conf
maxmemory 4gb
maxmemory-policy allkeys-lru
```

> **LRU vs LFU**：LRU 看"最近是否用过"，LFU 看"用了多少次"。LFU 适合有明显热点数据的场景，但对新 key 不友好（新 key 频率低容易被淘汰）。

---

## Q15：Redis 常见性能问题和解决方案

### 问题 1：大 Key

**现象**：单个 key 占用内存过大（String > 100KB，集合 > 10000 元素）。

**危害**：读取阻塞主线程、网络传输慢、内存碎片。

```bash
# 扫描大 key
redis-cli --bigkeys
```

**解决**：拆分、压缩、使用合适的数据结构。

### 问题 2：热 Key

**现象**：单个 key 的 QPS 远超其他 key，导致单节点过载。

```kotlin
// 解决：本地缓存 + 多副本
fun getHotKey(key: String): String {
    return caffeineCache.get(key) {
        redis.get(key)!!
    }
}

// 或者：在 key 后缀加随机数，分散到多个 key
val shard = Random.nextInt(0, 10)
redis.get("hot:$key:$shard")
```

### 问题 3：慢查询

```bash
# 查看慢查询
127.0.0.1:6379> SLOWLOG GET 10

# 常见慢命令
KEYS *           # → 用 SCAN 替代
SMEMBERS bigset  # → 用 SSCAN 替代
HGETALL bighash  # → 用 HSCAN 替代
```

### 问题 4：内存碎片

```bash
# 查看内存碎片率
127.0.0.1:6379> INFO memory
mem_fragmentation_ratio:1.55  # > 1.5 说明碎片严重

# 解决：开启内存碎片整理（Redis 4.0+）
activedefrag yes
```

### 问题 5：fork 阻塞

RDB 快照和 AOF 重写都需要 fork 子进程，大内存实例 fork 可能阻塞数百毫秒。

```conf
# 减少 fork 频率
save 900 1

# 使用 SSD（COW 更快）
# 控制单实例内存不超过 16GB（建议 8GB 以内）
```

---

## Q16：为什么 Redis 的操作是原子性的，怎么保证原子性的？

### 单命令原子性

Redis 的每条命令都是**单线程顺序执行**的，天然原子。

```bash
# INCR 是原子的，不会出现并发问题
127.0.0.1:6379> INCR counter
(integer) 1
```

### 多命令原子性

**方式一：MULTI/EXEC 事务**

```bash
MULTI
SET a 1
SET b 2
EXEC
```

注意：Redis 事务不保证原子性（命令错误不会回滚）。

**方式二：Lua 脚本（推荐）**

```lua
-- 秒杀扣减库存（原子操作）
local stock = tonumber(redis.call('GET', KEYS[1]))
if stock <= 0 then
    return -1  -- 库存不足
end
redis.call('DECR', KEYS[1])
return stock - 1
```

```kotlin
// Kotlin 调用 Lua 脚本
val script = """
    local stock = tonumber(redis.call('GET', KEYS[1]))
    if stock <= 0 then return -1 end
    redis.call('DECR', KEYS[1])
    return stock - 1
""".trimIndent()

val result = redis.eval(script, listOf("stock:item:10001"), emptyList())
```

Redis 执行 Lua 脚本时**不会被打断**，脚本内的所有操作作为一个整体执行。

**方式三：Redis 7.0 函数（Redis Functions）**

```lua
#!lua name=mylib
redis.register_function('deduct_stock', function(keys, args)
    local stock = tonumber(redis.call('GET', keys[1]))
    if stock <= 0 then return -1 end
    redis.call('DECR', keys[1])
    return stock - 1
end)
```

> **面试要点**：单命令天然原子；多命令用 Lua 脚本保证原子性；MULTI/EXEC 不保证原子性（无回滚）。

---

## Q17：Redis 事务

Redis 事务的本质是**命令队列**，而非传统数据库的 ACID 事务。

### 三个阶段

```
MULTI  →  命令入队（QUEUED）  →  EXEC（顺序执行）
```

### 两种错误

**1. 入队前错误（命令语法错误）**

```bash
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> SET key1 value1
QUEUED
127.0.0.1:6379> SET key2  -- 缺少参数
(error) ERR wrong number of arguments for 'set' command
127.0.0.1:6379> EXEC
(error) EXECABORT Transaction discarded because of previous errors.
# 整个事务被取消
```

**2. 执行时错误（命令逻辑错误）**

```bash
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> SET key1 value1
QUEUED
127.0.0.1:6379> INCR key1  -- key1 是字符串，INCR 会失败
QUEUED
127.0.0.1:6379> EXEC
1) OK
2) (error) ERR value is not an integer or out of range
# key1 已成功设置，INCR 失败但不影响其他命令
```

### WATCH 实现乐观锁

```bash
# 客户端 A
127.0.0.1:6379> WATCH mykey
OK
127.0.0.1:6379> GET mykey
"100"
# 此时客户端 B 修改了 mykey 为 200
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> SET mykey 150
QUEUED
127.0.0.1:6379> EXEC
(nil)  # 事务失败，因为 mykey 被其他客户端修改过
```

### Redis 事务 vs MySQL 事务

| 维度 | Redis 事务 | MySQL 事务 |
|------|-----------|-----------|
| 原子性 | 不保证（执行错误不回滚） | 保证（ROLLBACK） |
| 隔离性 | 单线程天然隔离 | 依赖隔离级别 |
| 一致性 | 无 | 有（约束 + 外键） |
| 持久性 | 依赖 AOF 配置 | redo log 保证 |

---

## 常见坑

- **缓存更新顺序错误**：先删缓存再写数据库，并发读可能回填旧数据
- **大 key 导致阻塞**：未拆分的大 String 读取时阻塞整个实例
- **KEYS * 扫全库**：生产环境禁用，用 SCAN 替代
- **热 key 未处理**：单节点过载但集群其他节点空闲
- **Lua 脚本死循环**：执行时间过长阻塞所有客户端（用 SCRIPT KILL 终止）

## 可执行 Checklist

- [ ] 是否实现了缓存空值，防止缓存穿透？
- [ ] 热点数据是否加了本地缓存（Caffeine/Guava）？
- [ ] 是否禁用了 KEYS * 命令（rename-command KEYS ""）？
- [ ] 是否对所有缓存 key 的过期时间加了随机抖动？
- [ ] 是否配置了 maxmemory 和淘汰策略？
- [ ] 多命令原子操作是否使用了 Lua 脚本？
- [ ] 是否定期用 `redis-cli --bigkeys` 扫描大 key？
