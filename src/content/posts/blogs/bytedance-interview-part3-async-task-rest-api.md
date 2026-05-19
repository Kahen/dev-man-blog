---
title: "字节跳动Java后端面试深度解析（三）：异步任务 REST API 完整方案 — 提交、查询、结果获取与自动清理"
published: 2026-05-19
description: 以AI视频描述生成等耗时任务为背景，设计一个完整的异步任务REST API方案，涵盖任务提交、状态查询、结果获取、任务去重和结果自动清理。
tags: [面试, Java, 异步任务, REST API, Redis, Spring Boot, 状态机]
category: Architecture
lang: zh_CN
---

用户上传一段 5 分钟的视频，请求 AI 生成描述。AI 处理耗时超过 2 分钟，HTTP 请求早就超时了。如果让用户一直等着，体验极差；如果用同步阻塞，线程池很快就会被耗尽。

这篇文章从这个场景出发，拆解一个生产级异步任务 REST API 的完整设计。

---

## 一、需求分析

### 1.1 核心需求

- **任务提交**：客户端提交任务，立即返回 taskId，不阻塞等待结果
- **状态查询**：客户端通过 taskId 轮询任务状态
- **结果获取**：任务完成后，客户端获取结果
- **任务去重**：相同请求在短时间内不重复处理
- **结果清理**：任务结果 24 小时后自动删除

### 1.2 状态机设计

```
PENDING(待处理) → PROCESSING(处理中) → COMPLETED(已完成)
       ↓                ↓                    ↓
   DUPLICATE(重复)  FAILED(失败)      EXPIRED(已过期)
```

```java
public enum TaskStatus {
    PENDING,     // 已提交，等待处理
    PROCESSING,  // 处理中
    COMPLETED,   // 已完成，可获取结果
    FAILED,      // 处理失败
    DUPLICATE,   // 与已有任务重复
    EXPIRED      // 结果已过期清理
}
```

---

## 二、数据模型设计

### 2.1 任务表结构

```sql
CREATE TABLE async_task (
    id              BIGINT PRIMARY KEY AUTO_INCREMENT,
    task_id         VARCHAR(36) NOT NULL UNIQUE,  -- UUID，对外暴露
    task_type       VARCHAR(50) NOT NULL,          -- 任务类型（如 VIDEO_DESCRIPTION）
    dedup_key       VARCHAR(128),                  -- 去重键（业务维度）
    request_payload JSON NOT NULL,                 -- 原始请求参数
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    result_payload  JSON,                          -- 任务结果
    error_message   TEXT,                          -- 失败原因
    progress        INT DEFAULT 0,                 -- 进度百分比 0-100
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at      TIMESTAMP,
    completed_at    TIMESTAMP,
    expires_at      TIMESTAMP,                     -- 结果过期时间
    retry_count     INT DEFAULT 0,
    version         INT DEFAULT 0,                 -- 乐观锁版本号

    INDEX idx_dedup_key (dedup_key),
    INDEX idx_status_created (status, created_at),
    INDEX idx_expires_at (expires_at)
);
```

### 2.2 Java 实体

```java
@Entity
@Table(name = "async_task")
public class AsyncTask {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "task_id", unique = true, nullable = false)
    private String taskId;

    @Column(name = "task_type", nullable = false)
    private String taskType;

    @Column(name = "dedup_key")
    private String dedupKey;

    @Column(name = "request_payload", columnDefinition = "JSON")
    @JdbcTypeCode(SqlTypes.JSON)
    private Map<String, Object> requestPayload;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private TaskStatus status = TaskStatus.PENDING;

    @Column(name = "result_payload", columnDefinition = "JSON")
    @JdbcTypeCode(SqlTypes.JSON)
    private Map<String, Object> resultPayload;

    @Column(name = "error_message")
    private String errorMessage;

    @Column(columnDefinition = "INT DEFAULT 0")
    private int progress = 0;

    @Column(name = "created_at")
    private LocalDateTime createdAt = LocalDateTime.now();

    @Column(name = "started_at")
    private LocalDateTime startedAt;

    @Column(name = "completed_at")
    private LocalDateTime completedAt;

    @Column(name = "expires_at")
    private LocalDateTime expiresAt;

    @Column(name = "retry_count")
    private int retryCount = 0;

    @Version
    private int version; // 乐观锁

    // 状态流转方法
    public void startProcessing() {
        this.status = TaskStatus.PROCESSING;
        this.startedAt = LocalDateTime.now();
    }

    public void complete(Map<String, Object> result) {
        this.status = TaskStatus.COMPLETED;
        this.resultPayload = result;
        this.progress = 100;
        this.completedAt = LocalDateTime.now();
        this.expiresAt = LocalDateTime.now().plusHours(24);
    }

    public void fail(String errorMessage) {
        this.status = TaskStatus.FAILED;
        this.errorMessage = errorMessage;
        this.completedAt = LocalDateTime.now();
        this.expiresAt = LocalDateTime.now().plusHours(24);
    }

    public boolean isExpired() {
        return expiresAt != null && LocalDateTime.now().isAfter(expiresAt);
    }
}
```

---

## 三、REST API 设计

### 3.1 接口定义

```java
@RestController
@RequestMapping("/api/v1/tasks")
public class AsyncTaskController {

    private final AsyncTaskService taskService;

    /**
     * 提交异步任务
     * POST /api/v1/tasks
     */
    @PostMapping
    public ResponseEntity<TaskSubmitResponse> submitTask(
            @Valid @RequestBody TaskSubmitRequest request) {

        TaskSubmitResponse response = taskService.submitTask(request);

        if (response.isDuplicate()) {
            // 去重命中，返回已有任务信息
            return ResponseEntity.status(HttpStatus.CONFLICT)
                .header("X-Task-Deduplicated", "true")
                .body(response);
        }

        // 202 Accepted：任务已接受，正在处理
        URI taskLocation = ServletUriComponentsBuilder.fromCurrentRequest()
            .path("/{taskId}")
            .buildAndExpand(response.getTaskId())
            .toUri();

        return ResponseEntity.accepted()
            .location(taskLocation)
            .body(response);
    }

    /**
     * 查询任务状态
     * GET /api/v1/tasks/{taskId}
     */
    @GetMapping("/{taskId}")
    public ResponseEntity<TaskStatusResponse> getTaskStatus(
            @PathVariable String taskId) {

        TaskStatusResponse response = taskService.getTaskStatus(taskId);

        return switch (response.getStatus()) {
            case COMPLETED -> ResponseEntity.ok(response);
            case PENDING, PROCESSING -> ResponseEntity.status(HttpStatus.OK)
                .header("Retry-After", "3")
                .body(response);
            case FAILED -> ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(response);
            case EXPIRED -> ResponseEntity.status(HttpStatus.GONE).body(response);
            default -> ResponseEntity.ok(response);
        };
    }

    /**
     * 获取任务结果
     * GET /api/v1/tasks/{taskId}/result
     */
    @GetMapping("/{taskId}/result")
    public ResponseEntity<TaskResultResponse> getTaskResult(
            @PathVariable String taskId) {

        TaskResultResponse result = taskService.getTaskResult(taskId);

        if (result.isExpired()) {
            return ResponseEntity.status(HttpStatus.GONE)
                .body(result);
        }
        if (result.getStatus() != TaskStatus.COMPLETED) {
            return ResponseEntity.status(HttpStatus.ACCEPTED)
                .header("Retry-After", "5")
                .body(result);
        }
        return ResponseEntity.ok(result);
    }

    /**
     * 取消任务
     * DELETE /api/v1/tasks/{taskId}
     */
    @DeleteMapping("/{taskId}")
    public ResponseEntity<Void> cancelTask(@PathVariable String taskId) {
        boolean cancelled = taskService.cancelTask(taskId);
        if (cancelled) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.status(HttpStatus.CONFLICT).build();
    }
}
```

### 3.2 请求/响应 DTO

```java
public record TaskSubmitRequest(
    @NotBlank String taskType,
    @NotNull Map<String, Object> payload,
    String dedupKey,  // 可选，不填则按 payload hash 去重
    Integer priority  // 可选，优先级
) {}

public record TaskSubmitResponse(
    String taskId,
    TaskStatus status,
    boolean duplicate,
    String message
) {}

public record TaskStatusResponse(
    String taskId,
    TaskStatus status,
    int progress,
    LocalDateTime createdAt,
    LocalDateTime startedAt,
    LocalDateTime completedAt,
    String errorMessage
) {}

public record TaskResultResponse(
    String taskId,
    TaskStatus status,
    Map<String, Object> result,
    boolean expired
) {}
```

---

## 四、核心服务实现

### 4.1 任务提交服务

```java
@Service
@Transactional
public class AsyncTaskService {

    private final AsyncTaskRepository taskRepository;
    private final TaskQueueProducer queueProducer;
    private final RedisTemplate<String, String> redisTemplate;

    private static final Duration DEDUP_WINDOW = Duration.ofMinutes(5);

    public TaskSubmitResponse submitTask(TaskSubmitRequest request) {
        // 1. 生成去重键
        String dedupKey = resolveDedupKey(request);

        // 2. 检查去重（Redis + DB 双重检查）
        if (dedupKey != null) {
            // Redis 快速检查
            String existingTaskId = redisTemplate.opsForValue()
                .get("task:dedup:" + dedupKey);
            if (existingTaskId != null) {
                return new TaskSubmitResponse(
                    existingTaskId,
                    TaskStatus.DUPLICATE,
                    true,
                    "Duplicate task found: " + existingTaskId
                );
            }

            // DB 检查（防止 Redis 数据丢失）
            taskRepository.findRecentByDedupKey(dedupKey, LocalDateTime.now().minusMinutes(5))
                .ifPresent(existing -> {
                    throw new DuplicateTaskException(existing.getTaskId());
                });
        }

        // 3. 创建任务
        AsyncTask task = new AsyncTask();
        task.setTaskId(UUID.randomUUID().toString());
        task.setTaskType(request.taskType());
        task.setDedupKey(dedupKey);
        task.setRequestPayload(request.payload());
        task.setStatus(TaskStatus.PENDING);
        taskRepository.save(task);

        // 4. 设置 Redis 去重标记
        if (dedupKey != null) {
            redisTemplate.opsForValue().set(
                "task:dedup:" + dedupKey,
                task.getTaskId(),
                DEDUP_WINDOW
            );
        }

        // 5. 投递到消息队列
        queueProducer.sendTaskMessage(task);

        return new TaskSubmitResponse(
            task.getTaskId(),
            TaskStatus.PENDING,
            false,
            "Task submitted successfully"
        );
    }

    private String resolveDedupKey(TaskSubmitRequest request) {
        if (request.dedupKey() != null) {
            return request.dedupKey();
        }
        // 按 payload 内容生成 hash 去重
        String payloadJson = JsonUtil.toJson(request.payload());
        return DigestUtils.sha256Hex(request.taskType() + ":" + payloadJson);
    }
}
```

### 4.2 任务执行器

```java
@Component
public class AsyncTaskExecutor {

    private final AsyncTaskRepository taskRepository;
    private final Map<String, TaskProcessor> processors;
    private final AsyncTaskProgressCallback progressCallback;

    public AsyncTaskExecutor(List<TaskProcessor> processorList) {
        this.processors = processorList.stream()
            .collect(Collectors.toUnmodifiableMap(
                TaskProcessor::taskType,
                Function.identity()
            ));
    }

    /**
     * 异步执行任务，由消息队列消费者调用
     */
    @Async("taskExecutor")
    public void execute(String taskId) {
        AsyncTask task = taskRepository.findByTaskId(taskId)
            .orElseThrow(() -> new TaskNotFoundException(taskId));

        // CAS 更新状态：PENDING → PROCESSING
        boolean started = taskRepository.casUpdateStatus(
            taskId, TaskStatus.PENDING, TaskStatus.PROCESSING);
        if (!started) {
            // 状态已经不是 PENDING，可能被取消或重复消费
            return;
        }

        try {
            TaskProcessor processor = processors.get(task.getTaskType());
            if (processor == null) {
                throw new UnsupportedTaskTypeException(task.getTaskType());
            }

            // 执行业务逻辑
            Map<String, Object> result = processor.process(
                task.getRequestPayload(),
                progress -> updateProgress(taskId, progress)  // 进度回调
            );

            // 更新为完成状态
            taskRepository.casUpdateStatusAndResult(
                taskId, TaskStatus.PROCESSING, TaskStatus.COMPLETED, result);

        } catch (Exception e) {
            taskRepository.updateStatusWithError(
                taskId, TaskStatus.FAILED, e.getMessage());
        }
    }

    private void updateProgress(String taskId, int progress) {
        taskRepository.updateProgress(taskId, progress);
        progressCallback.onProgress(taskId, progress);
    }
}
```

### 4.3 进度查询与 SSE 推送

除了轮询，还可以通过 SSE（Server-Sent Events）推送进度：

```java
@GetMapping(value = "/{taskId}/progress", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<ServerSentEvent<TaskProgressEvent>> streamProgress(
        @PathVariable String taskId) {

    return Flux.create(sink -> {
        // 先推送当前状态
        TaskStatusResponse current = taskService.getTaskStatus(taskId);
        sink.next(ServerSentEvent.builder(
            new TaskProgressEvent(taskId, current.status(), current.progress()))
            .build());

        // 订阅进度更新
        Disposable subscription = progressEventBus.subscribe(taskId, event -> {
            sink.next(ServerSentEvent.builder(event).build());
            if (event.status() == TaskStatus.COMPLETED
                || event.status() == TaskStatus.FAILED) {
                sink.complete();
            }
        });

        sink.onDispose(subscription::dispose);
    });
}
```

---

## 五、任务去重策略

### 5.1 去重键设计

去重键的选择直接影响去重效果：

| 场景 | 去重键策略 | 示例 |
|------|-----------|------|
| 用户主动提交 | 用户ID + 业务键 | `user:123:video:abc.mp4` |
| 相同内容请求 | payload hash | `sha256(taskType + payload)` |
| 限流去重 | 用户ID + 时间窗口 | `user:123:minute:202605191430` |

### 5.2 双重去重保证

```
客户端请求 → Redis 快速检查（毫秒级）
                ↓ miss
            数据库唯一约束检查（10ms 级）
                ↓ miss
            创建任务 + Redis 设置标记
```

Redis 作为第一道防线，速度快但可能丢数据；数据库唯一约束作为最终防线，保证数据一致性。

```java
// Redis Lua 脚本：原子性检查并设置
private static final String DEDUP_SCRIPT = """
    local key = KEYS[1]
    local taskId = ARGV[1]
    local ttl = tonumber(ARGV[2])
    local existing = redis.call('GET', key)
    if existing then
        return existing
    end
    redis.call('SETEX', key, ttl, taskId)
    return nil
    """;
```

---

## 六、结果自动清理

### 6.1 定时任务清理

```java
@Component
public class AsyncTaskCleanupJob {

    private final AsyncTaskRepository taskRepository;
    private final RedisTemplate<String, String> redisTemplate;

    /**
     * 每小时清理一次过期任务
     */
    @Scheduled(cron = "0 0 * * * *")
    @Transactional
    public void cleanupExpiredTasks() {
        LocalDateTime cutoff = LocalDateTime.now().minusHours(24);

        // 1. 批量查询过期任务
        List<AsyncTask> expiredTasks = taskRepository
            .findByStatusInAndCompletedAtBefore(
                List.of(TaskStatus.COMPLETED, TaskStatus.FAILED),
                cutoff
            );

        if (expiredTasks.isEmpty()) return;

        // 2. 分批处理，避免大事务
        Lists.partition(expiredTasks, 100).forEach(batch -> {
            batch.forEach(task -> {
                // 删除结果数据（保留任务记录用于审计）
                task.setResultPayload(null);
                task.setStatus(TaskStatus.EXPIRED);
            });
            taskRepository.saveAll(batch);
        });

        log.info("Cleaned up {} expired tasks", expiredTasks.size());
    }

    /**
     * 清理 Redis 中的过期去重键
     * Redis 会自动过期，这里只是清理可能残留的异常数据
     */
    @Scheduled(cron = "0 30 * * * *")
    public void cleanupExpiredDedupKeys() {
        // Redis 的 TTL 机制会自动清理，此处为兜底逻辑
        Set<String> keys = redisTemplate.keys("task:dedup:*");
        if (keys == null || keys.isEmpty()) return;

        int cleaned = 0;
        for (String key : keys) {
            String taskId = redisTemplate.opsForValue().get(key);
            if (taskId != null) {
                Optional<AsyncTask> task = taskRepository.findByTaskId(taskId);
                if (task.isEmpty() || task.get().isExpired()) {
                    redisTemplate.delete(key);
                    cleaned++;
                }
            }
        }
        log.info("Cleaned {} stale dedup keys from Redis", cleaned);
    }
}
```

### 6.2 大结果外部存储

当任务结果很大（如 AI 生成的长文本、视频分析数据）时，不应该直接存在数据库中：

```java
@Component
public class TaskResultStorage {

    private final S3Client s3Client;
    private final String resultBucket;

    /**
     * 存储大结果到 S3，数据库只保留引用
     */
    public String storeResult(String taskId, Map<String, Object> result) {
        String key = "task-results/" + taskId + ".json";
        String json = JsonUtil.toJson(result);

        s3Client.putObject(PutObjectRequest.builder()
            .bucket(resultBucket)
            .key(key)
            .contentType("application/json")
            .build(), RequestBody.fromString(json));

        return key;
    }

    /**
     * 获取结果（优先从 S3，降级从数据库）
     */
    public Map<String, Object> getResult(AsyncTask task) {
        if (task.getResultStorageKey() != null) {
            // 从 S3 获取
            ResponseInputStream<GetObjectResponse> response = s3Client.getObject(
                GetObjectRequest.builder()
                    .bucket(resultBucket)
                    .key(task.getResultStorageKey())
                    .build()
            );
            return JsonUtil.fromJson(response.readAllBytes(), Map.class);
        }
        // 降级：从数据库获取
        return task.getResultPayload();
    }
}
```

---

## 七、常见坑

**1. 任务状态更新的竞态条件**

多个消费者可能同时拉取到同一个任务。必须用 CAS（Compare-And-Swap）更新状态：

```sql
UPDATE async_task
SET status = 'PROCESSING', started_at = NOW(), version = version + 1
WHERE task_id = #{taskId} AND status = 'PENDING' AND version = #{version}
```

如果返回影响行数为 0，说明任务已经被其他消费者抢占。

**2. 去重窗口过长导致正常请求被误杀**

如果去重窗口设为 1 小时，用户修改了参数重新提交会被去重。应该将关键参数纳入去重键的计算。

**3. 消息队列消费失败的重试策略**

任务消费失败后不能无限重试，需要设置最大重试次数和指数退避：

```java
@Retryable(
    value = {TransientException.class},
    maxAttempts = 3,
    backoff = @Backoff(delay = 1000, multiplier = 2)
)
```

**4. 24 小时清理的时间精度**

如果任务在 23 小时 59 分完成，客户端在 24 小时 1 分查询，会得到 EXPIRED 状态。需要在响应中明确告知客户端结果的过期时间。

**5. 进度回调的频率控制**

AI 任务可能每秒回调多次进度。不要每次都写数据库，应该做节流（throttle）：

```java
// 每 5% 更新一次，或每 10 秒更新一次
if (progress - lastSavedProgress >= 5
    || Duration.between(lastSavedTime, now).getSeconds() >= 10) {
    taskRepository.updateProgress(taskId, progress);
}
```

---

## 八、上线 Checklist

- [ ] 任务状态机的每次转移都有 CAS 保护，不会出现并发状态混乱
- [ ] 去重键的设计覆盖了所有需要去重的场景（相同用户、相同内容、限流）
- [ ] 任务结果大小有上限（如 1MB），超大结果走外部存储
- [ ] 消息队列消费失败有重试策略，超过最大重试次数后标记为 FAILED
- [ ] 定时清理任务正常运行，不会误删正在处理的任务
- [ ] 客户端轮询有合理的间隔（推荐 3-5 秒），服务端通过 Retry-After Header 引导
- [ ] 任务提交和结果获取的 API 都有幂等保护
- [ ] 监控覆盖：任务成功率、平均耗时、队列积压量、过期清理数量

---

## 九、总结

异步任务 API 的设计核心是**三件事**：

1. **快速响应**：提交立即返回 taskId，不阻塞客户端
2. **状态可查**：通过 taskId 随时查询进度和结果
3. **生命周期完整**：从 PENDING 到 EXPIRED，每个状态都有明确的处理逻辑

去重用 Redis + 数据库双重保证，清理用定时任务 + 外部存储配合。整个方案从提交到清理，形成了一个完整的闭环。
