# SANZO · 数字人工作室

本机原型提供两种实时视频通话模式，使用所选人物的竖版头像和 Vidu 托管的阿里 RTC。

| 模式 | 链路 |
| --- | --- |
| 千问 + Vidu 组件版 | 千问理解麦克风语音并回复，Vidu 根据回复音频生成实时人物画面 |
| Vidu 完整实时版 | Vidu 接收麦克风音频，完成对话、语音输出和画面生成 |

## 启动

使用 Node.js 24 或更高版本。执行 `npm install` 后运行 `npm start`，也可双击 `启动原型.cmd`。打开 [人物大厅](http://127.0.0.1:3088/)，点选一位角色，再在竖屏对话页选择视频模式并点击「开始视频通话」。浏览器需要麦克风权限并能访问阿里 RTC Web SDK。

日夜主题、链路选择和角色设置保存在本机浏览器。组件版提供千问音色和对话节奏。完整版使用 Vidu 默认音色。通话控制区提供静音、停止回答、字幕和文字补充。

大厅包括魔兽世界老玩家阿勒和五位游戏 Coser。阿勒的两种模式均会从服务端读取 `lib/ale-knowledge.md`，把 WoW-Forever 资料摘要加入当前会话。

## 配置

把 `.env.example` 复制为 `.env.local`，在本机填入 `VIDU_API_KEY`。组合链路还需要 `TOKEN_PLAN_API_KEY`。创建 Vidu 会话时，本机服务按 `public/service-config.js` 中的人物目录读取所选头像并发送给 Vidu。浏览器只接收当前 RTC 会话的入房凭证。

Vidu 视频会话按用量计费，托管 RTC 依照官方说明不另外计费。原型只监听本机，一次接通一条视频链路，单次上限 20 分钟。 [组件版参数](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/component/parameters) · [完整实时版参数](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/realtime/parameters)

运行 `npm run check` 检查语法，运行 `npm test` 检查协议、打断和挂断逻辑。 [链路与生命周期说明](docs/实时语音方案.md)
