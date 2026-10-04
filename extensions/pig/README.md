# pig 侧 herdr 状态自报扩展

herdr 不识别 pig(`--kind` 无 `pig`、无屏检测),官方 pi 集成在 pig 下静默失效(见 mana#33),
所以 pig 侧必须自备状态上报:扩展挂 `session_start` / `agent_start` / `agent_settled` /
`session_shutdown` 四个事件,走 `herdr pane report-agent` / `release-agent` CLI 自报
`idle` / `working` 状态。走 CLI 而非裸 socket,是实测出来的做法——扩展子进程内直连
socket 对时序敏感,CLI 由 herdr 自己排队,稳。

## 安装

```bash
mkdir -p ~/.pig/agent/extensions && cp extensions/pig/herdr-agent-state.ts ~/.pig/agent/extensions/
```

pane 内 `HERDR_ENV=1` 时自动生效(herdr `pane run <pane> pig` 会注入环境变量)。

## 验证

以下为真机实测(herdr 0.9.0,pig 于测试 pane `w2J:p5` 内以 `pig -a` 启动):

1. 启动后约 20 秒,空闲自报生效:

   ```
   $ herdr agent get w2J:p5
   {"id":"cli:agent:get","result":{"agent":{"agent":"pig","agent_status":"idle","cwd":"/tmp",...,"pane_id":"w2J:p5","revision":1,"state_change_seq":2606,...},"type":"agent_info"}}
   ```text

   期望 `agent=pig` 且 `agent_status=idle`。

2. 投递任务(`pane send-text` + `send-keys enter`)后立即等待 working:

   ```
   $ herdr pane send-text w2J:p5 "只回复 PONG" && herdr pane send-keys w2J:p5 enter
   $ herdr agent wait w2J:p5 --until working --timeout 15000
   {"id":"cli:agent:wait","result":{"agent":{"agent":"pig","agent_status":"working",...,"state_change_seq":2607,...},"type":"agent_info"}}
   ```text

   期望返回 `agent_status=working`。注意要**立即** `wait`:`agent_start` 上报发生在
   回合开始,先 `sleep` 会错过 working 窗口。

3. 回合结束后等空闲(ctrl+d 释放前):

   ```
   $ herdr agent wait w2J:p5 --until done --timeout 15000
   {"id":"cli:agent:wait","result":{"agent":{"agent":"pig","agent_status":"done",...,"state_change_seq":2608,...},"type":"agent_info"}}
   ```text

   herdr 0.9.0 下用 `--until done`(见已知缺口第 4 条;`--until idle` 在完成一轮任务后
   不会命中)。

4. ctrl+d 正常退出,释放上报生效:

   ```
   $ herdr pane send-keys w2J:p5 ctrl+d && sleep 3
   $ herdr agent get w2J:p5
   {"error":{"code":"agent_not_found","message":"agent target w2J:p5 not found"},"id":"cli:agent:get"}
   ```text

   期望 `agent_not_found`(`release-agent` 已注销)。测完 `herdr pane close w2J:p5` 收尾。

## 已知缺口

1. pig 侧无法自报 `blocked` 状态:pig 扩展事件里没有「等待人工输入」的可靠信号,
   只报 `idle` / `working` 两态。
2. herdr 0.9.0 下 `agent_session` 不回填:`--agent-session-path` 已随每次上报携带,
   但 `herdr agent get` 不展示 session 路径。
3. pig 被 SIGKILL 时不释放:`session_shutdown` / `exit` 都不会触发,agent 残留,
   靠 `herdr pane close` 兜底注销。
4. herdr 0.9.0 显示语义:pig 空闲自报的 state 是 `idle`,但该 pane 一旦 working 过,
   回到空闲后 herdr 显示/等待为 `done`(`wait --until idle` 超时,`--until done`
   命中);从未 working 过的初始空闲仍显示 `idle`。上层等待逻辑请用 `--until done`
   表示「回合结束」。
