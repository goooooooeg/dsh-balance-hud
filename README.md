# dsh-balance-hud

全境封锁（The Division）SHD 风格的 DeepSeek Harness 余额表盘：常驻表盘 + 点击投影四层光环，显示余额 / 今日已用 / 峰谷倒计时，带余额提醒与语音。

本仓库由 [@LeeRolling](https://github.com/LeeRolling) 基于原始表盘项目派生，经原作者同意后移交 [@goooooooeg](https://github.com/goooooooeg) 维护。

## 相对原始版本的修改

1. **数据接入**：改为通过 DSH 的 `deepseekAccount` 服务读取账号余额，不自己拼 HTTP、不保存凭据。
2. **视觉**：鲸鱼图标替换默认白鹰；使用 Titillium Web 字体；新增日期块；上/下圈文字可自定义；表盘尺寸可调；峰值倒计时居中显示；充值/赠金行可隐藏。
3. **交互**：点击表盘投影四层同心环；自动贴边、拖拽位置记忆；外圈呼吸与危险态红环。
4. **声音**：4 个场景的 AI 语音提醒（余额不足 / 到账 / 峰时 / 谷时），5 种音效可叠加，支持试听与音量调节；提示语音可关闭。
5. **跨窗口提醒**：宿主监听 DSH 会话 `turn/end`，即使切到别的窗口/会话，任务完成也会响；新增宿主路由 `/dsh-balance-hud/turn-state`。
6. **性能**：移除 SVG `feGaussianBlur` 泛光（每帧重算极贵），改为静态 CSS 阴影层；减少常驻动画；轮询改为 5 秒、页面隐藏时暂停；避免整盘每帧重绘。
7. **兼容性修复**：适配 DSH 0.2.1-rc.5 的插件加载与设置面板；补充错误提示与恢复逻辑。

## 安装

```bash
dsh plugin --profile <profile> add link:<本目录>
```

或在 DSH 插件面板里「从文件安装」打包好的 tgz。

安装后界面右侧出现挂件；插件列表里名为「余额环 HUD / Balance Ring HUD」。

## 素材与授权

- 代码：MIT（见 `LICENSE`）。
- `assets/alert.mp3`、内嵌 SHD 白鹰徽记：来自游戏《全境封锁》（Ubisoft），仅作同人致敬，随插件原样提供，不再许可；详见 `NOTICE.md`。
- `assets/alert-balance|done|peak|valley.mp3`：由本项目作者用 AI 语音生成。
