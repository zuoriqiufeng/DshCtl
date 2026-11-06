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

【反馈回流】用户纠正了 BKN 给出的答案（说错了/漏了/过时）→ 立即调用 capture_correction 工具，tool=被纠正的工具名、correction=引用用户原话

【常见错误码方向】(前 12 条；完整诊断 diagnose_error 工具)
