# 素材来源与授权范围（NOTICE）

本插件分两部分，授权范围不同：

| 范围 | 授权 |
|---|---|
| `index.js`、`client.js`、`cordis.patch.yml`、`package.json`、`locale/`、`icon.svg`、文档 | **MIT**（见 `LICENSE`） |
| `assets/alert.mp3`、`client.js` 内嵌的 SHD 白鹰图（data URI） | **不适用 MIT**：来自游戏《全境封锁》（Ubisoft），仅作同人致敬、随插件**原样提供**，不授予再许可 |

## 逐项说明

- **SHD 白鹰徽记**：从公开的表盘参考图里抠出、统一染色后以 data URI 内嵌在 `client.js` 里，运行时不依赖外部文件。它是 Ubisoft 的商标 / 美术资产。
- **`assets/alert.mp3`**：取自 B 站视频「[全境封锁] ISAC 语音 整理 翻译 合集」（BV1fm411q7fb）约 828.6 秒处的一句 ISAC 语音（"Warning, supplies heavily damaged"），裁剪为 1.7 秒并做了响度归一化。语音版权属于游戏发行方。

## 发布 / 再分发建议

如果要把这个插件公开分发，上面两项素材存在权利风险。两种处理方式：

1. **保持现状**：作为非商业同人作品发布，在 README 里注明素材出处与「仅作学习交流」。被权利方要求时立即替换或下架。
2. **发布「干净版」**：删掉 `assets/alert.mp3`、把 `client.js` 里的 `EAGLE_SRC` 换成自己画的图形（或空字符串）。缺少提醒音时插件会自动跳过播放，不会报错。

## 权利主张

如果你认为本仓库的素材侵犯了你的权利，请指出文件名与依据，核实后会立即替换或移除。

## 表盘提示音（本地补丁）

ssets/alert-balance|done|peak|valley.mp3 由本项目作者用 AI 语音生成，仅随插件在本机播放，不是第三方游戏原声，也不包含 ISAC /《全境封锁》的任何素材。
