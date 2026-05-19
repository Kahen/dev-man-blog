---
title: "字节跳动Java后端面试深度解析（六）：TaskManager 任务生命周期管理 — 状态变更的原子性与并发安全"
published: 2026-05-19
description: 设计一个TaskManager服务管理AI任务的生命周期，处理用户编辑Prompt后取消旧任务并启动新任务的场景，确保状态变更的原子性。
tags: [面试, Java, 状态机, 并发, 分布式锁, Spring Boot, Redis]
category: Architecture
lang: zh_CN
---

用户编辑了已经提交给 AI 处理的 Prompt，需要取消旧任务并启动新任务。听起来简单，但仔细一想：取消旧任务和启动新任务必须是原子的——如果取消成功但启动失败，用户就丢了任务；如果启动成功但取消失败，就会有重复任务在跑。

这篇文章从这个场景出发，设计一个生产级的 TaskManager 服务，管理任务的完整生命周期。

---

## 一、问题场景

### 1.1 用户操作流程

```
用户提交 Prompt "画一只猫" → 创建 Task-1 → AI 处理中
            ↓
用户编辑 Prompt 为 "画一只蓝色的猫"
            ↓
需要：取消 Task-1 + 创建 Task-2（原子操作）
```

### 1.2 并发风险

最简单的实现：

```java
// 危险代码：非原子操作
public String editPrompt(String taskId, String newPrompt) {
    cancelTask(taskId);           // 步骤1：取消旧任务
    return createTask(newPrompt); // 步骤2：创建新任务
}
```

问题：

1. **步骤1成功、步骤2失败**：旧任务取消了，新任务没创建，用户丢失了任务
2. **步骤1失败、步骤2成功**：旧任务还在跑，新任务也创建了，重复执行
3. **并发编辑**：用户快速编辑两次，可能产生三个任务（旧的 + 两个新的）

---

## 二、任务状态机设计

### 2.1 状态定义

```java
public enum TaskStatus {
    PENDING,       // 已创建，等待处理
    QUEUED,        // 已进入队列
    PROCESSING,    // AI 处理中
    COMPLETED,     // 已完成
    FAILED,        // 失败
    CANCELLED,     // 已取消
    EDITING        // 编辑中（临时状态，锁定任务防止并发修改）
}
```

### 2.2 状态流转规则

```java
public class TaskStateMachine {

    /**
     * 合法的状态转移映射
     * key: 当前状态, value: 允许转移到的目标状态集合
     */
    private static final Map<TaskStatus, Set<TaskStatus>> TRANSITIONS = Map.of(
        PENDING,    Set.of(QUEUED, CANCELLED, EDITING),
        QUEUED,     Set.of(PROCESSING, CANCELLED, EDITING),
        PROCESSING, Set.of(COMPLETED, FAILED, CANCELLED),
        COMPLETED,  Set.of(),          // 终态，不可转移
        FAILED,     Set.of(),          // 终态，不可转移
        CANCELLED,  Set.of(),          // 终态，不可转移
        EDITING,    Set.of(PENDING, CANCELLED)  // 编辑完成后回到 PENDING 或取消
    );

    /**
     * 校验状态转移是否合法
     */
    public static void validateTransition(TaskStatus from, TaskStatus to) {
        Set<TaskStatus> allowed = TRANSITIONS.getOrDefault(from, Set.of());
        if (!allowed.contains(to)) {
            throw new IllegalTaskStateException(
                String.format("Cannot transition from %s to %s", from, to));
        }
    }
}
```

状态流转图：

```
PENDING → QUEUED → PROCESSING → COMPLETED
  │         │          │
  │         │          └→ FAILED
  │         │
  │         └→ CANCELLED
  │
  └→ EDITING → PENDING（编辑后重新排队）
         │
         └→ CANCELLED（编辑后取消）
```

---

## 三、TaskManager 核心实现

### 3.1 任务实体

```java
@Entity
@Table(name = "ai_task")
public class AiTask {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "task_id", unique = true, nullable = false)
    private String taskId;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "prompt", nullable = false, columnDefinition = "TEXT")
    private String prompt;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private TaskStatus status;

    @Column(name = "result_url")
    private String resultUrl;

    @Column(name = "error_message")
    private String errorMessage;

    @Column(name = "created_at")
    private LocalDateTime createdAt;

    @Column(name = "updated_at")
    private LocalDateTime updatedAt;

    @Version
    private int version;  // 乐观锁

    @Column(name = "edit_lock_until")
    private LocalDateTime editLockUntil;  // 编辑锁过期时间
}
```

### 3.2 CAS 状态更新

```java
@Repository
public interface AiTaskRepository extends JpaRepository<AiTask, Long> {

    Optional<AiTask> findByTaskId(String taskId);

    /**
     * CAS 更新状态：只有当前状态匹配时才更新
     * 返回影响行数，0 表示状态已被其他线程修改
     */
    @Modifying
    @Query("""
        UPDATE AiTask t
        SET t.status = :newStatus,
            t.updatedAt = :now,
            t.version = t.version + 1
        WHERE t.taskId = :taskId
          AND t.status = :currentStatus
          AND t.version = :version
        """)
    int casUpdateStatus(
        @Param("taskId") String taskId,
        @Param("currentStatus") TaskStatus currentStatus,
        @Param("newStatus") TaskStatus newStatus,
        @Param("version") int version,
        @Param("now") LocalDateTime now
    );
}
```

### 3.3 TaskManager 服务

```java
@Service
@Transactional
public class TaskManager {

    private final AiTaskRepository taskRepository;
    private final RedisTemplate<String, String> redisTemplate;
    private final TaskQueueProducer queueProducer;
    private final ApplicationEventPublisher eventPublisher;

    private static final Duration EDIT_LOCK_TTL = Duration.ofSeconds(30);
    private static final Duration TASK_LOCK_TTL = Duration.ofSeconds(10);

    /**
     * 创建新任务
     */
    public AiTask createTask(String userId, String prompt) {
        AiTask task = new AiTask();
        task.setTaskId(UUID.randomUUID().toString());
        task.setUserId(userId);
        task.setPrompt(prompt);
        task.setStatus(TaskStatus.PENDING);
        task.setCreatedAt(LocalDateTime.now());
        task.setUpdatedAt(LocalDateTime.now());

        taskRepository.save(task);

        // 投递到队列
        queueProducer.enqueue(task.getTaskId());

        return task;
    }

    /**
     * 编辑 Prompt 并重启任务（原子操作）
     *
     * 核心流程：
     * 1. 获取分布式锁（防止并发编辑）
     * 2. CAS 将旧任务标记为 EDITING（锁定）
     * 3. 尝试取消旧任务的 AI 处理
     * 4. 创建新任务
     * 5. CAS 将旧任务标记为 CANCELLED
     * 6. 释放锁
     */
    public AiTask editAndRestart(String userId, String oldTaskId, String newPrompt) {
        String lockKey = "task:edit:lock:" + oldTaskId;

        // 1. 获取分布式锁
        Boolean locked = redisTemplate.opsForValue()
            .setIfAbsent(lockKey, userId, TASK_LOCK_TTL);
        if (!Boolean.TRUE.equals(locked)) {
            throw new TaskLockedException("Task is being edited by another request");
        }

        try {
            // 2. 查询旧任务
            AiTask oldTask = taskRepository.findByTaskId(oldTaskId)
                .orElseThrow(() -> new TaskNotFoundException(oldTaskId));

            // 校验所有权
            if (!oldTask.getUserId().equals(userId)) {
                throw new AccessDeniedException("Not your task");
            }

            // 3. CAS 将旧任务标记为 EDITING
            int updated = taskRepository.casUpdateStatus(
                oldTaskId,
                oldTask.getStatus(),
                TaskStatus.EDITING,
                oldTask.getVersion(),
                LocalDateTime.now()
            );
            if (updated == 0) {
                throw new ConcurrentModificationException(
                    "Task status changed during edit, please retry");
            }

            // 4. 尝试取消旧任务的 AI 处理（尽力而为）
            tryCancelAiProcessing(oldTaskId);

            // 5. 创建新任务
            AiTask newTask = createTask(userId, newPrompt);

            // 6. CAS 将旧任务标记为 CANCELLED
            // 重新查询获取最新的 version
            AiTask editingTask = taskRepository.findByTaskId(oldTaskId).orElseThrow();
            taskRepository.casUpdateStatus(
                oldTaskId,
                TaskStatus.EDITING,
                TaskStatus.CANCELLED,
                editingTask.getVersion(),
                LocalDateTime.now()
            );

            // 7. 发布取消事件
            eventPublisher.publishEvent(new TaskCancelledEvent(
                oldTaskId, "User edited prompt", LocalDateTime.now()));

            return newTask;

        } finally {
            redisTemplate.delete(lockKey);
        }
    }

    /**
     * 取消任务
     */
    public void cancelTask(String userId, String taskId) {
        String lockKey = "task:cancel:lock:" + taskId;

        Boolean locked = redisTemplate.opsForValue()
            .setIfAbsent(lockKey, userId, TASK_LOCK_TTL);
        if (!Boolean.TRUE.equals(locked)) {
            throw new TaskLockedException("Task is being modified");
        }

        try {
            AiTask task = taskRepository.findByTaskId(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));

            if (!task.getUserId().equals(userId)) {
                throw new AccessDeniedException("Not your task");
            }

            // CAS 更新为 CANCELLED
            int updated = taskRepository.casUpdateStatus(
                taskId,
                task.getStatus(),
                TaskStatus.CANCELLED,
                task.getVersion(),
                LocalDateTime.now()
            );
            if (updated == 0) {
                throw new ConcurrentModificationException(
                    "Task status changed, please retry");
            }

            // 取消 AI 处理
            tryCancelAiProcessing(taskId);

            eventPublisher.publishEvent(new TaskCancelledEvent(
                taskId, "User cancelled", LocalDateTime.now()));

        } finally {
            redisTemplate.delete(lockKey);
        }
    }

    /**
     * 尝试取消 AI 处理（尽力而为）
     * 如果 AI 任务已经在处理中，可能无法取消
     */
    private void tryCancelAiProcessing(String taskId) {
        try {
            queueProducer.cancel(taskId);
        } catch (Exception e) {
            // 记录日志但不抛异常，因为任务状态已经在 DB 中标记为 CANCELLED
            // AI 处理完成后回调时会检查状态，发现已取消则忽略结果
            log.warn("Failed to cancel AI processing for task {}: {}",
                taskId, e.getMessage());
        }
    }
}
```

---

## 四、并发安全的多层保障

### 4.1 保障层次

```
第一层：分布式锁（Redis）    — 防止同一任务的并发编辑
第二层：CAS 更新（数据库）   — 防止状态更新的竞态条件
第三层：乐观锁（version）    — 防止并发写覆盖
第四层：状态机校验           — 防止非法状态转移
```

### 4.2 分布式锁的实现细节

```java
/**
 * 更健壮的分布式锁实现（Redisson 风格）
 */
@Component
public class DistributedTaskLock {

    private final RedisTemplate<String, String> redisTemplate;

    private static final String LOCK_PREFIX = "task:lock:";
    private static final String UNLOCK_SCRIPT = """
        if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('del', KEYS[1])
        else
            return 0
        end
        """;

    /**
     * 获取锁（带重试）
     */
    public TaskLock acquire(String taskId, String ownerId, Duration timeout) {
        String lockKey = LOCK_PREFIX + taskId;
        long maxRetries = 3;
        long retryDelayMs = 100;

        for (int i = 0; i < maxRetries; i++) {
            Boolean acquired = redisTemplate.opsForValue()
                .setIfAbsent(lockKey, ownerId, timeout);
            if (Boolean.TRUE.equals(acquired)) {
                return new TaskLock(lockKey, ownerId, this);
            }

            // 短暂等待后重试
            try {
                Thread.sleep(retryDelayMs * (i + 1));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new LockAcquisitionException("Interrupted while acquiring lock");
            }
        }

        throw new LockAcquisitionException(
            "Failed to acquire lock for task: " + taskId);
    }

    /**
     * 释放锁（Lua 脚本保证原子性）
     */
    public void release(String lockKey, String ownerId) {
        Long result = redisTemplate.execute(
            new DefaultRedisScript<>(UNLOCK_SCRIPT, Long.class),
            List.of(lockKey),
            ownerId
        );
        if (result == null || result == 0) {
            log.warn("Lock already released or owned by another process: {}", lockKey);
        }
    }
}

/**
 * 锁对象（实现 AutoCloseable，支持 try-with-resources）
 */
public class TaskLock implements AutoCloseable {
    private final String lockKey;
    private final String ownerId;
    private final DistributedTaskLock lockManager;
    private boolean released = false;

    @Override
    public void close() {
        if (!released) {
            lockManager.release(lockKey, ownerId);
            released = true;
        }
    }
}
```

### 4.3 使用 try-with-resources 管理锁

```java
public AiTask editAndRestart(String userId, String oldTaskId, String newPrompt) {
    // try-with-resources 自动释放锁
    try (TaskLock lock = lockManager.acquire(oldTaskId, userId, Duration.ofSeconds(10))) {
        // ... 业务逻辑 ...
    }
}
```

---

## 五、AI 回调时的状态校验

AI 处理完成后回调时，必须检查任务是否已被取消：

```java
@Service
public class AiCallbackHandler {

    @Transactional
    public void onAiCompleted(String taskId, String resultUrl) {
        AiTask task = taskRepository.findByTaskId(taskId)
            .orElseThrow(() -> new TaskNotFoundException(taskId));

        // 关键：检查任务是否已被取消
        if (task.getStatus() == TaskStatus.CANCELLED) {
            log.info("Task {} was cancelled, ignoring AI result", taskId);
            return;  // 丢弃结果
        }

        if (task.getStatus() == TaskStatus.EDITING) {
            log.info("Task {} is being edited, ignoring AI result", taskId);
            return;
        }

        // CAS 更新为 COMPLETED
        int updated = taskRepository.casUpdateStatus(
            taskId,
            TaskStatus.PROCESSING,
            TaskStatus.COMPLETED,
            task.getVersion(),
            LocalDateTime.now()
        );

        if (updated == 0) {
            log.warn("Task {} status changed during callback, result may be lost", taskId);
            return;
        }

        // 保存结果
        task.setResultUrl(resultUrl);
        taskRepository.save(task);
    }
}
```

---

## 六、补偿机制与最终一致性

### 6.1 问题：取消成功但新任务创建失败

即使在同一个事务中，也可能因为外层异常导致部分操作回滚。需要补偿机制：

```java
@Component
public class TaskCompensationJob {

    /**
     * 每 5 分钟扫描 EDITING 状态超过 1 分钟的任务
     * 这些任务可能是编辑操作中途失败遗留的
     */
    @Scheduled(fixedRate = 300_000)
    @Transactional
    public void compensateStuckEditingTasks() {
        LocalDateTime cutoff = LocalDateTime.now().minusMinutes(1);
        List<AiTask> stuckTasks = taskRepository
            .findByStatusAndUpdatedAtBefore(TaskStatus.EDITING, cutoff);

        for (AiTask task : stuckTasks) {
            log.warn("Found stuck EDITING task: {}, reverting to PENDING",
                task.getTaskId());
            taskRepository.casUpdateStatus(
                task.getTaskId(),
                TaskStatus.EDITING,
                TaskStatus.PENDING,
                task.getVersion(),
                LocalDateTime.now()
            );
            // 重新投递到队列
            queueProducer.enqueue(task.getTaskId());
        }
    }

    /**
     * 每小时清理超过 24 小时的 CANCELLED 任务
     */
    @Scheduled(cron = "0 0 * * * *")
    @Transactional
    public void cleanupCancelledTasks() {
        LocalDateTime cutoff = LocalDateTime.now().minusHours(24);
        List<AiTask> expired = taskRepository
            .findByStatusAndUpdatedAtBefore(TaskStatus.CANCELLED, cutoff);

        if (!expired.isEmpty()) {
            taskRepository.deleteAll(expired);
            log.info("Cleaned up {} cancelled tasks", expired.size());
        }
    }
}
```

### 6.2 事件驱动的补偿

如果取消旧任务成功但创建新任务失败，可以通过事件驱动补偿：

```java
@EventListener
public void onTaskCancelled(TaskCancelledEvent event) {
    // 检查是否有对应的"编辑补偿"标记
    String pendingEdit = redisTemplate.opsForValue()
        .get("task:pending_edit:" + event.taskId());

    if (pendingEdit != null) {
        // 有待补偿的编辑操作
        EditContext ctx = JsonUtil.fromJson(pendingEdit, EditContext.class);
        try {
            taskManager.createTask(ctx.userId(), ctx.newPrompt());
            redisTemplate.delete("task:pending_edit:" + event.taskId());
        } catch (Exception e) {
            log.error("Failed to compensate edit for task {}", event.taskId(), e);
        }
    }
}
```

---

## 七、常见坑

**1. 分布式锁的过期时间不够**

如果业务逻辑执行时间超过了锁的过期时间，锁会自动释放，其他线程可能获取到锁并进入临界区。解决方案：

- 锁的过期时间要大于业务逻辑的最大执行时间
- 使用锁续期（watchdog）机制，如 Redisson 的 `tryLock(waitTime, leaseTime)`

**2. CAS 更新返回 0 时没有正确处理**

CAS 更新返回 0 意味着状态已被其他线程修改。应该抛出异常或重试，而不是静默忽略：

```java
int updated = taskRepository.casUpdateStatus(...);
if (updated == 0) {
    throw new ConcurrentModificationException("Task was modified by another request");
}
```

**3. 取消操作和完成回调的竞态**

任务可能在取消的瞬间刚好完成。必须在回调时再次检查状态：

```java
// 回调时必须检查当前状态
if (task.getStatus() == TaskStatus.CANCELLED) {
    return;  // 任务已取消，丢弃结果
}
```

**4. EDITING 状态的任务被 AI 回调更新**

AI 不知道任务正在编辑中，回调可能会把 EDITING 状态覆盖为 COMPLETED。解决方案：在 CAS 更新中，回调只能从 PROCESSING 转到 COMPLETED，不能从 EDITING 转。

**5. Redis 锁被误删**

如果锁过期后被其他线程获取，原线程执行完后可能误删新线程的锁。必须用 Lua 脚本保证"只有自己才能释放自己的锁"。

---

## 八、上线 Checklist

- [ ] 所有状态更新都使用 CAS，没有直接 UPDATE 的语句
- [ ] 分布式锁的获取和释放都有异常保护（finally / try-with-resources）
- [ ] 锁的过期时间大于业务逻辑最大执行时间
- [ ] AI 回调时检查任务状态，不会覆盖已取消/编辑中的任务
- [ ] EDITING 状态有超时补偿，不会无限期锁定
- [ ] 并发编辑同一任务时有明确的错误提示（而非静默失败）
- [ ] 取消操作是幂等的，重复取消不会报错
- [ ] 监控覆盖：CAS 失败率、锁获取失败率、EDITING 超时任务数

---

## 九、总结

任务生命周期管理的核心是**状态变更的原子性**：

1. **状态机**定义了合法的状态转移，任何非法转移都会被拒绝
2. **CAS 更新**保证了数据库层面的原子性，避免并发写覆盖
3. **分布式锁**保证了操作层面的原子性，防止同一任务的并发编辑
4. **补偿机制**处理了中途失败的场景，保证最终一致性

> 一个任务从创建到完成，可能经历多次状态变更。每一次变更都必须是原子的、可追溯的、可回滚的。这就是状态机 + CAS + 分布式锁的组合威力。
