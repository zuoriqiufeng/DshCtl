【高频操作 → Skill 绑定】(具体命令一律由 Skill 提供)
- activate_node（激活工作节点）→ activate_node → Skill: i2stream-node-manager
- register_db（注册数据库节点）→ register_db → Skill: i2stream-db-manager
- create_rule（创建同步规则）→ create_sync_rule → Skill: i2stream-rule-manager
- start_rule（启动同步规则）→ start_sync_rule → Skill: i2stream-rule-manager
- stop_rule（停止同步规则）→ stop_sync_rule → Skill: i2stream-rule-manager
- delete_rule（删除同步规则）→ delete_sync_rule → Skill: i2stream-rule-manager
- compare_table（创建表比较任务）→ create_compare → Skill: i2stream-diff-op
- failover（执行灾备切换）→ failover → Skill: i2stream-failover

【症状 → 诊断方向】(详见 diagnostics/symptom-router.bkn 与 log-map.bkn)
- incremental_stuck: 增量同步卡住 / 规则状态变为 ABNORMAL → 优先排查源端日志可读性，其次检查网络连接，最后确认目标端写入是否阻塞 → Skill: i2stream-db-diagnostics、i2stream-log-analyzer
- data_mismatch: 源端与目标端数据不一致 → 先确认两端 schema/字典一致，再在一致的时间点或位点导出数据做对比，最后定位差异行… → Skill: i2stream-db-diagnostics
- crash_loop: 组件启动-崩溃-重启循环 → 日志优先 → Skill: i2stream-log-analyzer、i2stream-db-diagnostics
- connection_error: 数据库连接失败 → 从网络连通性、监听/端口、账号权限、防火墙四个方向排查 → Skill: i2stream-db-diagnostics
- performance_degradation: 同步性能下降 / 延迟增大 → 先区分是 i2Stream 内部队列延迟还是 DB 侧性能瓶颈 → Skill: i2stream-log-analyzer、i2stream-db-diagnostics

【常见错误码方向】(前 12 条；完整诊断 diagnose_error 工具)
- -4073: track 进程无法读取源端数据库日志
- -4016: 规则关联的工作节点与控制台失去通讯
- -4071: 对 RUNNING/FULLSYNC 状态的规则执行不兼容操作
- -4031: 规则处于 ABNORMAL 状态时执行 restart
- -4046: 目标端数据库装载异常
- 进程异常退出: 进程因资源不足、系统调用错误等非正常终止
- 脏数据无法装载: 源端和目标端字符集不匹配，或日志不完整
- 断点续传失败: 源库未开启归档日志，异常后无法断点续传
- -4002: Oracle REDO 日志解析位置异常，增量停止
- YAS-02276: YashanDB 源端增量同步（ystream）链路报错，apply position 停滞
- ORA-00942: 同步规则涉及的表在源端或目标端不存在，或数据库用户无该表访问权限
- ORA-24344: 源端或目标端的存储过程/函数/触发器编译失败，依赖该对象的同步或校验操作受影响
