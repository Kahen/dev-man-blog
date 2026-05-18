---
title: "渣打银行Java后端面试深度解析（二）：基础设施 — 分布式ID、Kafka可靠性与敏感数据安全"
published: 2026-05-18
description: 深入剖析银行系统基础设施的三大核心技术：分布式ID生成（雪花算法与美团Leaf）、Kafka消息可靠性保障、敏感数据加密与脱敏，覆盖国密SM4与KMS密钥管理，附完整代码示例。
tags: [面试, Java, 分布式ID, Kafka, 加密, 安全, 金融, 后端架构]
category: Architecture
lang: zh_CN
---

线上出过这么一个事故：某银行的交易流水号用的是数据库自增ID，结果分库分表后两个库产生了相同的ID，下游对账系统直接把两笔完全不同的交易匹配到了一起，导致一笔 50 万的转账被错误冲正。事后复盘，分布式 ID 生成方案选型有严重缺陷。

这篇文章就从这个场景出发，拆解银行系统底层基础设施中最核心的三个问题：分布式 ID 怎么生成、Kafka 消息怎么保证不丢、敏感数据怎么存。

---

## 一、分布式ID生成方案：全局唯一、趋势递增、可反解

### 1.1 银行交易流水号的要求

银行系统的交易流水号不同于普通互联网系统的ID，它有严格的要求：

1. **全局唯一**：在分布式系统中，所有节点生成的ID不能重复
2. **趋势递增**：生成的ID大致按时间递增，有利于数据库B+Tree索引的写入性能
3. **可反解业务信息**：能从流水号中解析出日期、机构号、交易类型等信息，方便运维排查和日志追踪
4. **高性能**：每秒需要支撑万级甚至更高的ID生成需求
5. **高可用**：ID生成服务不可宕机，否则整个交易系统停摆

常见方案的对比：

| 方案 | 唯一性 | 递增性 | 可反解 | 性能 | 复杂度 |
|------|--------|--------|--------|------|--------|
| UUID | 是 | 否 | 否 | 高 | 低 |
| 数据库自增 | 是 | 是 | 否 | 低 | 低 |
| Redis自增 | 是 | 是 | 否 | 中 | 中 |
| 雪花算法 | 是 | 趋势递增 | 可定制 | 高 | 中 |
| Leaf | 是 | 趋势递增 | 可定制 | 高 | 高 |

### 1.2 雪花算法（Snowflake）

Twitter的雪花算法生成一个64位长整型ID，结构如下：

```
 0 | 00000000 00000000 00000000 00000000 00000000 0 | 00000 00000 | 000000000000
符号位(1) |              时间戳(41)                   | 机器ID(10) |  序列号(12)
```

- **符号位**：固定为0（正数）
- **时间戳**：41位，可以使用约69年（以某个自定义纪元为起点）
- **机器ID**：10位，最多支持1024个节点
- **序列号**：12位，同一毫秒内最多生成4096个ID

```java
public class SnowflakeIdGenerator {

    // 自定义纪元：2024-01-01 00:00:00 UTC 的毫秒时间戳
    private static final long EPOCH = 1704067200000L;

    // 各部分的位数
    private static final long WORKER_ID_BITS = 10L;
    private static final long SEQUENCE_BITS = 12L;

    // 最大值
    private static final long MAX_WORKER_ID = (1L << WORKER_ID_BITS) - 1;  // 1023
    private static final long SEQUENCE_MASK = (1L << SEQUENCE_BITS) - 1;   // 4095

    // 左移位数
    private static final long WORKER_ID_SHIFT = SEQUENCE_BITS;           // 12
    private static final long TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS; // 22

    private final long workerId;
    private long sequence = 0L;
    private long lastTimestamp = -1L;

    public SnowflakeIdGenerator(long workerId) {
        if (workerId < 0 || workerId > MAX_WORKER_ID) {
            throw new IllegalArgumentException("Worker ID must be between 0 and " + MAX_WORKER_ID);
        }
        this.workerId = workerId;
    }

    public synchronized long nextId() {
        long currentTimestamp = System.currentTimeMillis();

        if (currentTimestamp < lastTimestamp) {
            // 时钟回拨！这是雪花算法的致命问题
            throw new RuntimeException("Clock moved backwards. Refusing to generate id for "
                + (lastTimestamp - currentTimestamp) + " milliseconds");
        }

        if (currentTimestamp == lastTimestamp) {
            // 同一毫秒内，序列号递增
            sequence = (sequence + 1) & SEQUENCE_MASK;
            if (sequence == 0) {
                // 序列号用完了，等待下一毫秒
                currentTimestamp = waitNextMillis(lastTimestamp);
            }
        } else {
            // 不同毫秒，序列号重置为0
            sequence = 0L;
        }

        lastTimestamp = currentTimestamp;

        return ((currentTimestamp - EPOCH) << TIMESTAMP_SHIFT)
             | (workerId << WORKER_ID_SHIFT)
             | sequence;
    }

    private long waitNextMillis(long lastTimestamp) {
        long timestamp = System.currentTimeMillis();
        while (timestamp <= lastTimestamp) {
            timestamp = System.currentTimeMillis();
        }
        return timestamp;
    }
}
```

### 1.3 时钟回拨问题及解决方案

时钟回拨是雪花算法最致命的问题。当服务器的系统时间被手动调回（如NTP同步校时），雪花算法会生成重复的ID。

**为什么会出现时钟回拨？**
- NTP（网络时间协议）定期同步时钟，校正可能造成时间回退
- 人工手动调整服务器时间
- 虚拟机迁移导致时间变化
- 闰秒处理

**解决方案一：直接拒绝（简单但不友好）**
```java
if (currentTimestamp < lastTimestamp) {
    throw new RuntimeException("Clock moved backwards");
}
```

**方案二：等待时间追上来**
```java
if (currentTimestamp < lastTimestamp) {
    long offset = lastTimestamp - currentTimestamp;
    if (offset <= 5) { // 允许5ms以内的小回拨
        try {
            Thread.sleep(offset << 1); // 等待两倍的回拨时间
            currentTimestamp = System.currentTimeMillis();
            if (currentTimestamp < lastTimestamp) {
                throw new RuntimeException("Clock still backwards after wait");
            }
        } catch (InterruptedException e) {
            throw new RuntimeException(e);
        }
    } else {
        throw new RuntimeException("Clock moved backwards by " + offset + "ms");
    }
}
```

**方案三：预留扩展位，用扩展位记录回拨次数**
```
 0 | 时间戳(41) | 扩展位(2) | 机器ID(10) | 序列号(11)
```
每次检测到时钟回拨，扩展位+1。扩展位占2位，最多容忍3次连续回拨。

```java
private long epochPlus = 0L; // 回拨扩展位

public synchronized long nextId() {
    long currentTimestamp = System.currentTimeMillis();

    if (currentTimestamp < lastTimestamp) {
        epochPlus++;
        if (epochPlus > 3) {
            throw new RuntimeException("Too many clock backwards");
        }
    } else {
        epochPlus = 0;
    }
    // ... 使用 (currentTimestamp - EPOCH) | (epochPlus << 60) 来编码
}
```

**方案四：使用外部时钟源**
使用Falcon或类似的精确时间服务获取时间，而不是依赖系统时间。在银行系统中，通常有统一的时钟服务集群。

### 1.4 银行流水号的定制化扩展

标准雪花算法不能直接满足银行需求（可反解业务信息），需要定制化：

```java
/**
 * 银行定制化ID生成器
 *
 * 结构设计（64位）：
 * 符号位(1) + 日期偏移(13,支持22年) + 机构号(8,256个机构)
 * + 交易类型(4,16种交易) + 机器ID(6,64节点) + 序列号(12,4096/ms)
 *
 * 总计：1+13+8+4+6+12 = 44位（加上符号位45位）
 *
 * 剩余19位保留扩展使用
 */
public class BankIdGenerator {

    private static final long EPOCH = LocalDate.of(2024, 1, 1)
        .atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli();

    private static final long ORG_BITS = 8L;
    private static final long TX_TYPE_BITS = 4L;
    private static final long WORKER_BITS = 6L;
    private static final long SEQ_BITS = 12L;
    private static final long DATE_BITS = 13L;

    private static final long MAX_ORG = (1L << ORG_BITS) - 1;
    private static final long MAX_TX_TYPE = (1L << TX_TYPE_BITS) - 1;
    private static final long MAX_WORKER = (1L << WORKER_BITS) - 1;
    private static final long SEQ_MASK = (1L << SEQ_BITS) - 1;

    private final long orgCode;    // 机构号 0-255
    private final long txType;     // 交易类型 0-15
    private final long workerId;   // 节点ID 0-63
    private long sequence = 0L;
    private long lastTimestamp = -1L;

    public BankIdGenerator(long orgCode, long txType, long workerId) {
        this.orgCode = orgCode;
        this.txType = txType;
        this.workerId = workerId;
    }

    public synchronized long nextId() {
        long currentTimestamp = System.currentTimeMillis();
        long dayOffset = (currentTimestamp - EPOCH) / (24 * 3600 * 1000);

        if (currentTimestamp < lastTimestamp) {
            throw new RuntimeException("Clock moved backwards");
        }

        if (currentTimestamp == lastTimestamp) {
            sequence = (sequence + 1) & SEQ_MASK;
            if (sequence == 0) {
                currentTimestamp = waitNextMillis(lastTimestamp);
                dayOffset = (currentTimestamp - EPOCH) / (24 * 3600 * 1000);
            }
        } else {
            sequence = 0L;
        }

        lastTimestamp = currentTimestamp;

        return (dayOffset << (ORG_BITS + TX_TYPE_BITS + WORKER_BITS + SEQ_BITS))
             | (orgCode << (TX_TYPE_BITS + WORKER_BITS + SEQ_BITS))
             | (txType << (WORKER_BITS + SEQ_BITS))
             | (workerId << SEQ_BITS)
             | sequence;
    }

    /**
     * 反解ID，提取业务信息
     */
    public static Map<String, Object> decode(long id) {
        long seq = id & SEQ_MASK;
        long worker = (id >> SEQ_BITS) & MAX_WORKER;
        long tx = (id >> (WORKER_BITS + SEQ_BITS)) & MAX_TX_TYPE;
        long org = (id >> (TX_TYPE_BITS + WORKER_BITS + SEQ_BITS)) & MAX_ORG;
        long day = id >> (ORG_BITS + TX_TYPE_BITS + WORKER_BITS + SEQ_BITS);

        LocalDate date = LocalDate.ofEpochDay(day + LocalDate.of(2024, 1, 1).toEpochDay());

        Map<String, Object> info = new LinkedHashMap<>();
        info.put("date", date.toString());
        info.put("orgCode", org);
        info.put("txType", tx);
        info.put("workerId", worker);
        info.put("sequence", seq);
        return info;
    }

    private long waitNextMillis(long lastTs) {
        long ts = System.currentTimeMillis();
        while (ts <= lastTs) ts = System.currentTimeMillis();
        return ts;
    }
}
```

### 1.5 美团Leaf方案

美团开源的Leaf是分布式ID生成服务，提供两种模式：

**Segment模式（号段模式）**：

从数据库中批量申请一个号段（如1~1000），用完后再申请下一个号段。每次申请号段都需要更新数据库中的max_id字段。

```sql
-- Leaf的数据库表设计
CREATE TABLE leaf_alloc (
    biz_tag VARCHAR(128) NOT NULL COMMENT '业务标签',
    max_id BIGINT NOT NULL DEFAULT 1 COMMENT '当前已分配的最大ID',
    step INT NOT NULL DEFAULT 1000 COMMENT '每次申请的号段大小',
    description VARCHAR(256) DEFAULT NULL,
    update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (biz_tag)
) ENGINE=InnoDB;

-- 申请号段的SQL
UPDATE leaf_alloc SET max_id = max_id + step WHERE biz_tag = #{bizTag};
```

**双Buffer优化**：Leaf的核心优化是在当前号段消耗到一定比例（如10%）时，异步申请下一个号段。这样当前号段用完后，下一个号段已经准备好了，不需要等待数据库响应。

```
当前号段 [1, 1000] 使用到 900 时
    → 异步预申请下一个号段 [1001, 2000]
    → 当前号段用完时直接切换到新号段
    → 延迟接近于零
```

```java
public class SegmentBuffer {
    private String key;              // 业务标签
    private Segment[] segments;      // 双Buffer
    private volatile int currentPos; // 当前使用的Buffer位置（0或1）

    public class Segment {
        private volatile long value;     // 当前已使用到的ID
        private long maxId;              // 号段最大值
        private long step;               // 号段步长
        private volatile boolean loaded; // 是否已加载完成
    }

    public long getId() {
        Segment current = segments[currentPos];
        long id = current.value.incrementAndGet();

        if (id >= current.maxId) {
            // 当前号段用完，切换到另一个Buffer
            currentPos = 1 - currentPos;
            Segment next = segments[currentPos];
            if (!next.loaded) {
                // 下一个号段还没加载好（极端情况），阻塞等待
                synchronized (this) {
                    while (!next.loaded) {
                        try { wait(10); } catch (InterruptedException e) { /* */ }
                    }
                }
            }
            id = next.value.incrementAndGet();
        }

        // 当前号段消耗到一定比例，触发异步预加载
        if ((id - current.value.get()) > current.step * 0.1) {
            // 异步加载另一个Buffer
            asyncLoadNextBuffer();
        }

        return id;
    }
}
```

**Snowflake模式**：
Leaf也提供了Snowflake模式，使用ZooKeeper来分配workerId，避免手动配置：

```
Leaf启动 → 向ZK注册临时节点 → 获取workerId → 定期上报状态
```

**Segment vs Snowflake 对比**：

| 维度 | Segment（号段模式） | Snowflake模式 |
|------|---------------------|---------------|
| 递增性 | 严格递增 | 趋势递增 |
| 依赖 | MySQL | ZooKeeper |
| 性能 | 非常高（纯内存） | 非常高（纯计算） |
| 时钟敏感 | 不敏感 | 敏感（时钟回拨问题） |
| 运维复杂度 | 需维护DB | 需维护ZK |
| 适用场景 | 不需要时间信息 | 需要从ID中提取时间信息 |

**银行场景的推荐**：如果流水号需要包含时间信息（反解），用定制化雪花算法 + ZooKeeper/配置中心分配workerId；如果只需要全局唯一和递增，用Leaf的号段模式。

---

## 二、Kafka消息可靠性：如何保证消息不丢失？

### 2.1 银行场景的消息可靠性要求

在银行系统中，消息丢失可能导致：交易流水丢失、对账数据不完整、风控事件遗漏、账户余额不一致等严重后果。因此银行系统对消息可靠性有极高的要求——消息必须"恰好到达一次"（Exactly-Once），或者至少"至少到达一次"（At-Least-Once）+ 幂等消费。

### 2.2 Kafka消息丢失的三个环节

消息从生产到消费经过三个环节，每个环节都可能丢失消息：

```
生产者(Producer) → Kafka Broker(服务端) → 消费者(Consumer)
    ① 发送失败           ② 存储故障           ③ 消费失败
```

### 2.3 生产端：确保消息发送成功

**问题**：默认情况下，Kafka Producer使用异步发送（`send()`方法立即返回Future），如果发送失败（如网络抖动、Broker宕机），消息就丢了。

**解决方案一：同步发送（最安全但性能差）**
```java
// 同步发送，等待Broker确认
try {
    RecordMetadata metadata = producer.send(record).get(); // 阻塞等待
    log.info("Message sent to partition={}, offset={}", metadata.partition(), metadata.offset());
} catch (ExecutionException e) {
    // 发送失败，需要处理（重试或记录）
    log.error("Failed to send message", e);
}
```

**解决方案二：带回调的异步发送（推荐）**
```java
producer.send(record, (metadata, exception) -> {
    if (exception != null) {
        // 发送失败：记录到本地重试表，后续补偿发送
        log.error("Failed to send message to topic={}", record.topic(), exception);
        saveToRetryTable(record); // 持久化到本地数据库
    } else {
        log.info("Message sent: topic={}, partition={}, offset={}",
            metadata.topic(), metadata.partition(), metadata.offset());
    }
});
```

**解决方案三：Producer端重试配置**
```properties
# Producer配置
retries=3                          # 重试次数
retry.backoff.ms=100               # 重试间隔
delivery.timeout.ms=120000         # 发送超时时间
enable.idempotence=true            # 开启幂等性（关键！）
max.in.flight.requests.per.connection=5  # 幂等模式下最多允许5个未确认请求
```

**`acks`参数的配置**：
```properties
# acks参数决定Producer需要多少个Broker副本确认才算发送成功
acks=0    # 不等待确认，性能最高但可能丢消息（绝对不能用于银行场景）
acks=1    # 等待Leader确认，Leader挂了可能丢消息（不推荐银行场景）
acks=all  # 等待所有ISR副本确认（银行场景必须用这个！）
```

### 2.4 Broker端：确保消息持久化不丢

**问题**：即使Producer确认发送成功，如果Broker在消息同步到其他副本之前宕机，消息仍然会丢失。

**解决方案：配置副本因子和最小同步副本数**

```properties
# Broker端配置
default.replication.factor=3           # 副本因子：每个分区3个副本
min.insync.replicas=2                  # 最少2个副本同步成功才返回确认
unclean.leader.election.enable=false   # 禁止非ISR副本成为Leader（防止数据丢失）
```

**`acks=all`和`min.insync.replicas`的配合**：

```
场景：3个Broker，replication.factor=3，min.insync.replicas=2

正常情况：
  Broker1(Leader) ← 写入成功
  Broker2(Follower) ← 同步成功  → 返回Producer成功（ISR有2个同步成功）
  Broker3(Follower) ← 同步成功

Broker1宕机：
  Broker2(成为新Leader) ← 数据完整
  Broker3(Follower) ← 数据完整
  → 不丢数据

Broker2和Broker3同时宕机：
  ISR中同步副本 < min.insync.replicas(2)
  → Producer发送失败（返回NotEnoughReplicasException）
  → 不会丢数据（宁可不可用也不能丢数据）
```

**关键公式**：`acks=all` + `min.insync.replicas=2` + `replication.factor=3` 是银行场景的标准配置。这个组合保证了：
- 至少2个副本确认才算写入成功
- 任何一个Broker宕机都不会丢数据
- 两个Broker同时宕机时Producer会收到错误（而不是静默丢数据）

### 2.5 消费端：确保消息被正确消费

**问题**：Consumer从Kafka拉取消息后，在处理完成之前如果Consumer崩溃，消息可能丢失（如果已经提交了offset）。或者Consumer处理成功但提交offset失败，导致消息被重复消费。

**解决方案一：关闭自动提交offset**
```properties
# Consumer配置
enable.auto.commit=false            # 关闭自动提交！
max.poll.records=500                # 每次最多拉取500条
session.timeout.ms=30000            # 会话超时
```

**解决方案二：手动提交offset（处理完才提交）**
```java
@KafkaListener(topics = "bank-transactions", groupId = "tx-processor")
public void consume(List<ConsumerRecord<String, String>> records, Acknowledgment ack) {
    try {
        for (ConsumerRecord<String, String> record : records) {
            // 业务处理
            processTransaction(record.value());
        }
        // 所有消息处理成功后，手动提交offset
        ack.acknowledge();
    } catch (Exception e) {
        // 处理失败，不提交offset，消息会被重新消费
        log.error("Failed to process messages", e);
        throw e; // 抛出异常，触发Consumer rebalance
    }
}
```

**解决方案三：消费端幂等（配合At-Least-Once）**

由于手动提交offset + 处理失败可能导致消息被重复消费，消费端必须实现幂等：

```java
@Component
public class TransactionConsumer {

    @Autowired
    private TransactionLogRepository txLogRepo;

    public void processTransaction(String message) {
        TransactionMessage tx = JsonUtil.fromJson(message, TransactionMessage.class);

        // 幂等检查：根据消息中的唯一业务ID判断是否已处理
        if (txLogRepo.existsByExternalId(tx.getExternalId())) {
            log.info("Transaction already processed: {}", tx.getExternalId());
            return; // 已处理过，跳过
        }

        // 处理交易
        doProcessTransaction(tx);

        // 记录处理标记（与业务操作在同一事务中）
        txLogRepo.save(new TransactionLog(tx.getExternalId(), "PROCESSED"));
    }
}
```

### 2.6 Kafka的Exactly-Once语义（EOS）

Kafka 0.11+引入了Exactly-Once语义（EOS），通过幂等Producer + 事务来实现：

```java
// Producer配置
enable.idempotence=true   // 开启幂等
transactional.id=bank-tx-producer-001  // 事务ID（全局唯一）

// 代码
producer.initTransactions();
try {
    producer.beginTransaction();
    producer.send(new ProducerRecord<>("topic1", key1, value1));
    producer.send(new ProducerRecord<>("topic2", key2, value2));
    producer.commitTransaction();
} catch (ProducerFencedException e) {
    producer.close(); // 另一个Producer使用了相同的transactional.id
} catch (KafkaException e) {
    producer.abortTransaction();
}
```

**Consumer端的EOS**：
```properties
# Consumer需要设置隔离级别为read_committed
isolation.level=read_committed
```

这样Consumer只能读到已提交事务的消息，避免读到中间状态。

### 2.7 银行场景的Kafka完整配置建议

```properties
# ===== 生产端 =====
acks=all
retries=3
retry.backoff.ms=100
enable.idempotence=true
max.in.flight.requests.per.connection=5
delivery.timeout.ms=120000
max.request.size=10485760  # 10MB

# ===== Broker端 =====
default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false
log.retention.hours=168  # 消息保留7天（银行可能更长）
log.retention.bytes=-1   # 不按大小删除

# ===== 消费端 =====
enable.auto.commit=false
isolation.level=read_committed
max.poll.records=500
session.timeout.ms=30000
```

### 2.8 消息可靠性监控

除了配置正确，还需要监控：

```java
@Component
public class KafkaHealthMonitor {

    // 监控Producer发送失败率
    @Scheduled(fixedDelay = 60000)
    public void checkProducerMetrics() {
        Map<MetricName, ? extends Metric> metrics = producer.metrics();
        double failedSendRate = getMetricValue(metrics, "failed-send-rate");
        if (failedSendRate > 0.01) { // 失败率超过1%
            alertService.sendAlert("Kafka Producer发送失败率异常: " + failedSendRate);
        }
    }

    // 监控Consumer Lag（消费延迟）
    @Scheduled(fixedDelay = 30000)
    public void checkConsumerLag() {
        Map<String, Map<Integer, Long>> lags = kafkaAdmin.getConsumerLag("bank-consumer-group");
        for (Map.Entry<String, Map<Integer, Long>> entry : lags.entrySet()) {
            long totalLag = entry.getValue().values().stream().mapToLong(Long::longValue).sum();
            if (totalLag > 10000) {
                alertService.sendAlert("Consumer Lag过大: topic=" + entry.getKey() + ", lag=" + totalLag);
            }
        }
    }
}
```

---

## 三、敏感数据加密与脱敏：银行数据安全的基石

### 3.1 问题场景

银行系统存储大量用户敏感信息：手机号、身份证号、银行卡号、交易密码等。这些数据面临的安全威胁包括：数据库被拖库（SQL注入、内部人员泄露）、日志泄露、接口返回敏感数据。

**加密**和**脱敏**是两个不同的概念：
- **加密（Encryption）**：将明文转换为密文，通过密钥可以解密还原。用于数据存储。
- **脱敏（Masking）**：将敏感信息部分遮蔽，无法还原。用于数据展示。

### 3.2 数据库存储：加密方案

#### AES对称加密

AES（Advanced Encryption Standard）是对称加密算法，加密和解密使用相同的密钥。128/192/256位密钥长度。

```
明文 → AES加密（密钥K）→ 密文 → 存入数据库
密文 → AES解密（密钥K）→ 明文
```

```java
@Component
public class AESEncryptor {

    private static final String ALGORITHM = "AES/GCM/NoPadding";
    private static final int GCM_TAG_LENGTH = 128;
    private static final int GCM_IV_LENGTH = 12;

    // 密钥从KMS（密钥管理系统）获取，不硬编码在代码中
    @Autowired
    private KeyManagementService kms;

    public String encrypt(String plaintext, String keyAlias) {
        try {
            SecretKey key = kms.getKey(keyAlias); // 从KMS获取密钥
            byte[] iv = new byte[GCM_IV_LENGTH];
            SecureRandom.getInstanceStrong().nextBytes(iv);

            Cipher cipher = Cipher.getInstance(ALGORITHM);
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LENGTH, iv));

            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

            // IV + 密文，Base64编码存储
            byte[] combined = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(ciphertext, 0, combined, iv.length, ciphertext.length);

            return Base64.getEncoder().encodeToString(combined);
        } catch (Exception e) {
            throw new SecurityException("Encryption failed", e);
        }
    }

    public String decrypt(String ciphertext, String keyAlias) {
        try {
            SecretKey key = kms.getKey(keyAlias);
            byte[] combined = Base64.getDecoder().decode(ciphertext);

            byte[] iv = Arrays.copyOfRange(combined, 0, GCM_IV_LENGTH);
            byte[] encrypted = Arrays.copyOfRange(combined, GCM_IV_LENGTH, combined.length);

            Cipher cipher = Cipher.getInstance(ALGORITHM);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LENGTH, iv));

            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new SecurityException("Decryption failed", e);
        }
    }
}
```

**为什么选择AES-GCM而不是AES-CBC？**
- GCM（Galois/Counter Mode）提供认证加密（Authenticated Encryption），同时保证机密性和完整性
- CBC模式如果没有配合HMAC，可能遭受Padding Oracle攻击
- GCM的性能也不错（支持硬件加速）

**AES的适用场景**：
- 手机号、身份证号等字段加密存储（数据量中等）
- 整个表的敏感字段加密
- 数据库透明加密（TDE）

#### RSA非对称加密

RSA是非对称加密算法，使用公钥加密、私钥解密。

```
明文 → RSA加密（公钥）→ 密文 → 存储
密文 → RSA解密（私钥）→ 明文
```

**RSA的适用场景**：
- **密钥交换**：用RSA加密传输AES密钥（TLS/SSL的核心机制）
- **数字签名**：用私钥签名，公钥验证（交易签名、报文完整性）
- **少量数据加密**：如加密AES密钥本身

**RSA不适合大量数据加密**的原因：
- 加密速度比AES慢约1000倍
- 能加密的数据长度受密钥长度限制（2048位RSA最多加密245字节）
- 所以通常用RSA加密AES密钥，再用AES加密实际数据（混合加密方案）

```
混合加密方案：
1. 生成随机AES密钥K
2. 用AES密钥K加密数据 → 密文
3. 用RSA公钥加密AES密钥K → 加密后的密钥
4. 存储：密文 + 加密后的密钥
5. 解密：先用RSA私钥解密得到K，再用K解密密文
```

```java
public class HybridEncryptor {

    public EncryptedData encrypt(String plaintext, PublicKey rsaPublicKey) throws Exception {
        // 1. 生成随机AES密钥
        KeyGenerator keyGen = KeyGenerator.getInstance("AES");
        keyGen.init(256);
        SecretKey aesKey = keyGen.generateKey();

        // 2. 用AES加密数据
        byte[] iv = new byte[12];
        SecureRandom.getInstanceStrong().nextBytes(iv);
        Cipher aesCipher = Cipher.getInstance("AES/GCM/NoPadding");
        aesCipher.init(Cipher.ENCRYPT_MODE, aesKey, new GCMParameterSpec(128, iv));
        byte[] encryptedData = aesCipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

        // 3. 用RSA公钥加密AES密钥
        Cipher rsaCipher = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
        rsaCipher.init(Cipher.ENCRYPT_MODE, rsaPublicKey);
        byte[] encryptedKey = rsaCipher.doFinal(aesKey.getEncoded());

        return new EncryptedData(encryptedData, encryptedKey, iv);
    }
}
```

### 3.3 国密SM4

SM4（国密四号算法）是中国国家密码管理局发布的分组密码标准，是中国自主可控的对称加密算法。

**SM4 vs AES**：

| 维度 | SM4 | AES |
|------|-----|-----|
| 密钥长度 | 128位 | 128/192/256位 |
| 分组长度 | 128位 | 128位 |
| 轮数 | 32轮 | 10/12/14轮 |
| 安全性 | 国密标准，合规要求 | 国际标准 |
| 性能 | 略慢于AES | 有硬件加速支持 |
| 使用场景 | 国内金融、政务系统 | 通用场景 |

```java
// 使用Bouncy Castle库实现SM4
import org.bouncycastle.jce.provider.BouncyCastleProvider;

public class SM4Encryptor {

    static {
        Security.addProvider(new BouncyCastleProvider());
    }

    private static final String ALGORITHM = "SM4/GCM/NoPadding";

    public String encrypt(String plaintext, byte[] key) {
        try {
            Cipher cipher = Cipher.getInstance(ALGORITHM, "BC");
            byte[] iv = new byte[16];
            SecureRandom.getInstanceStrong().nextBytes(iv);
            GCMParameterSpec spec = new GCMParameterSpec(128, iv);

            SecretKeySpec keySpec = new SecretKeySpec(key, "SM4");
            cipher.init(Cipher.ENCRYPT_MODE, keySpec, spec);

            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

            byte[] combined = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(ciphertext, 0, combined, iv.length, ciphertext.length);

            return Base64.getEncoder().encodeToString(combined);
        } catch (Exception e) {
            throw new SecurityException("SM4 encryption failed", e);
        }
    }

    public String decrypt(String ciphertext, byte[] key) {
        try {
            byte[] combined = Base64.getDecoder().decode(ciphertext);
            byte[] iv = Arrays.copyOfRange(combined, 0, 16);
            byte[] encrypted = Arrays.copyOfRange(combined, 16, combined.length);

            Cipher cipher = Cipher.getInstance(ALGORITHM, "BC");
            SecretKeySpec keySpec = new SecretKeySpec(key, "SM4");
            cipher.init(Cipher.DECRYPT_MODE, keySpec, new GCMParameterSpec(128, iv));

            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new SecurityException("SM4 decryption failed", e);
        }
    }
}
```

**在银行场景中，SM4的应用**：
- 中国银联的交易报文加密要求使用国密算法
- 与国内银行间的互联互通使用国密标准
- 国内金融监管要求关键系统使用国密算法
- 渣打银行在国内的系统也需要符合国密合规要求

### 3.4 数据脱敏

脱敏用于数据展示场景，如客服查询用户信息时，不需要看到完整的手机号和身份证号。

```java
@Component
public class DataMasker {

    /**
     * 手机号脱敏：138****1234
     */
    public String maskPhone(String phone) {
        if (phone == null || phone.length() < 7) return phone;
        return phone.substring(0, 3) + "****" + phone.substring(phone.length() - 4);
    }

    /**
     * 身份证脱敏：110***********1234
     */
    public String maskIdCard(String idCard) {
        if (idCard == null || idCard.length() < 8) return idCard;
        return idCard.substring(0, 3) + "*".repeat(idCard.length() - 7) + idCard.substring(idCard.length() - 4);
    }

    /**
     * 银行卡号脱敏：6222 **** **** 1234
     */
    public String maskBankCard(String cardNo) {
        if (cardNo == null || cardNo.length() < 8) return cardNo;
        return cardNo.substring(0, 4) + " **** **** " + cardNo.substring(cardNo.length() - 4);
    }

    /**
     * 姓名脱敏：张*明、欧阳**（保留姓氏）
     */
    public String maskName(String name) {
        if (name == null || name.length() < 2) return name;
        if (name.length() == 2) {
            return name.charAt(0) + "*";
        }
        return name.charAt(0) + "*".repeat(name.length() - 2) + name.charAt(name.length() - 1);
    }
}
```

**脱敏的实现方式**：

1. **注解式脱敏（推荐）**：在DTO/VO字段上标注脱敏规则，在序列化时自动脱敏

```java
public class UserVO {
    @MaskType(MaskType.PHONE)
    private String phone;

    @MaskType(MaskType.ID_CARD)
    private String idCard;

    @MaskType(MaskType.BANK_CARD)
    private String bankCard;
}

// 自定义Jackson序列化器
public class MaskingSerializer extends JsonSerializer<String> {

    @Override
    public void serialize(String value, JsonGenerator gen, SerializerProvider provider) throws IOException {
        MaskType maskType = // 从注解获取
        gen.writeString(DataMasker.mask(value, maskType));
    }
}
```

2. **SQL层面脱敏**：查询时使用数据库函数脱敏

```sql
SELECT CONCAT(LEFT(phone, 3), '****', RIGHT(phone, 4)) AS phone
FROM users WHERE id = ?
```

3. **数据库动态脱敏**：使用数据库自带的动态脱敏功能（如MySQL Enterprise的Data Masking插件）

### 3.5 密钥管理

加密方案的安全性完全依赖于密钥的安全性。银行系统的密钥管理：

1. **密钥不落盘**：密钥存储在硬件安全模块（HSM）中，应用程序通过API访问
2. **密钥轮换**：定期更换加密密钥（如每90天），旧密钥保留用于解密历史数据
3. **密钥分级**：主密钥（Master Key）加密数据密钥（Data Encryption Key），数据密钥加密实际数据
4. **密钥备份**：密钥分片存储，需要多人授权才能恢复

```
密钥层级：
  主密钥(MK) → 存储在HSM中
    → 加密 → 数据密钥1(DEK1) → 加密 → 用户表手机号字段
    → 加密 → 数据密钥2(DEK2) → 加密 → 用户表身份证字段
    → 加密 → 数据密钥3(DEK3) → 加密 → 交易表金额字段
```

---

## 常见坑

基础设施层面的坑往往更隐蔽，排查也更难：

- **雪花算法的 workerId 冲突**：手动配置 workerId，部署新节点时重复了，两个节点产生相同 ID。必须用 ZooKeeper 或数据库自增分配 workerId。
- **时钟回拨只做了"抛异常"**：线上 NTP 校时导致短暂回拨，直接抛异常导致整个 ID 生成服务不可用。应该有容忍阈值（5ms 以内等待恢复，超过才报错）。
- **Leaf 号段模式步长设置过小**：步长设为 100，高并发下一秒就用完了，又要去 DB 申请，DB 成了瓶颈。步长应该按业务峰值的 10 倍以上设置。
- **Kafka 只配了 acks=all 没配 min.insync.replicas**：acks=all 但 min.insync.replicas=1（默认），实际上只有 Leader 一个副本确认就返回了，Leader 宕机仍然丢数据。
- **Consumer 开了自动提交 offset**：消息还没处理完就提交了 offset，Consumer 崩溃后这条消息就丢了。银行场景必须手动提交。
- **加密密钥写死在代码里**：密钥硬编码在配置文件或代码中，代码泄露 = 数据泄露。必须用 KMS/HSM 管理密钥。
- **AES 用了 ECB 模式**：ECB 模式对相同明文产生相同密文，攻击者可以通过模式分析推断数据。必须用 GCM 或 CBC + HMAC。
- **脱敏规则和加密规则混淆**：脱敏是不可逆的遮蔽，用于展示；加密是可逆的，用于存储。把手机号脱敏后的结果存进数据库，数据就永远找不回来了。
- **日志里打印了明文敏感数据**：`log.info("处理用户 {}", user.getIdCard())` 这种写法会把身份证号写进日志文件，日志一旦泄露就是安全事故。

---

## Checklist

上线前逐项检查：

- [ ] 分布式 ID 的 workerId 通过 ZooKeeper/数据库自动分配，不手动配置
- [ ] 雪花算法有时钟回拨的容忍策略（小回拨等待恢复，大回拨告警+拒绝）
- [ ] Kafka Producer 配置了 `acks=all` + `min.insync.replicas=2` + `enable.idempotence=true`
- [ ] Kafka Consumer 关闭了自动提交 offset，业务处理完成后手动提交
- [ ] 消费端实现了幂等（通过唯一业务 ID 去重）
- [ ] 敏感字段（手机号、身份证、银行卡）使用 AES-256-GCM 加密存储
- [ ] 加密密钥存储在 KMS/HSM 中，不硬编码在代码或配置文件中
- [ ] 国内金融系统使用了 SM4 国密算法（满足合规要求）
- [ ] API 返回和日志输出中的敏感数据都做了脱敏处理
- [ ] 密钥轮换机制已就绪，旧密钥保留用于解密历史数据
- [ ] 监控覆盖：ID 生成失败率、Kafka 发送失败率/Consumer Lag、加解密耗时
