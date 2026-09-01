<div align="center">
  <img src="assets/icon.svg" alt="webOS IPTV Player 图标">
  <h1>webOS IPTV Player</h1>
  <p>一款专为 LG webOS 电视打造的 IPTV 播放器，支持 M3U 播放列表、Xtream Codes 账号、XMLTV 节目指南（EPG）、回看及直播时移。</p>
  <p><a href="README.md">English</a> | 简体中文</p>
  <p>
  <a href="#支持的-webos-版本"><img src="https://img.shields.io/badge/webOS-4%2B-e6007e?logo=webos&logoColor=white" alt="webOS 4+"></a>
  <a href="https://github.com/lennylxx/webos-iptv-player/releases/latest"><img src="https://img.shields.io/github/v/release/lennylxx/webos-iptv-player" alt="最新版本"></a>
  <a href="https://github.com/lennylxx/webos-iptv-player/releases"><img src="https://img.shields.io/github/downloads/lennylxx/webos-iptv-player/total" alt="GitHub 下载量"></a>
  <a href="https://lennylxx.github.io/webos-iptv-player/"><img src="https://img.shields.io/badge/Website-222?logo=github" alt="项目网站"></a>
  </p>
</div>

## 截图

| 频道列表 | 最近观看 |
| --- | --- |
| ![频道列表](https://github.com/user-attachments/assets/ec5dab43-3b1e-4b90-a20f-71514b8a605b) | ![最近观看](https://github.com/user-attachments/assets/529c23e4-5fe4-4fbf-bae8-f62ce6008e33) |

| 节目指南 | 回看续播 |
| --- | --- |
| ![节目指南](https://github.com/user-attachments/assets/9928c342-c2fa-46b8-92f1-b5e815f24f19) | ![回看续播](https://github.com/user-attachments/assets/9a49fa89-b3ae-4b27-bcd6-b93de2c3e1e1) |

| 频道信息 | 播放浮层 |
| --- | --- |
| ![频道信息](https://github.com/user-attachments/assets/e0dd4fbf-b6b4-46f6-a8e8-7235c66d9512) | ![播放浮层](https://github.com/user-attachments/assets/1a2a3fe7-55ca-4a7c-ac05-a38c4f578e41) |

| 字幕 | 字幕搜索 |
| --- | --- |
| ![字幕](https://github.com/user-attachments/assets/5d1fab57-1087-414b-9a20-f900589eac4a) | ![字幕搜索](https://github.com/user-attachments/assets/4ef9c97e-131b-4e4f-bf9a-c753d66f2956) |

| 电影 | 电影详情 |
| --- | --- |
| ![电影](https://github.com/user-attachments/assets/a6b09baf-0342-4e02-9d7e-5cf7677d1ecf) | ![电影详情](https://github.com/user-attachments/assets/1380b0b2-680f-49bb-a470-336c9e14a54a) |

| 剧集详情 | 搜索 |
| --- | --- |
| ![剧集详情](https://github.com/user-attachments/assets/e7bf3b55-3464-4c7a-966d-34ee432795e3) | ![搜索](https://github.com/user-attachments/assets/8677ff38-b32d-44af-991b-ce40a7157e61) |

| 设置 | 主题选择器 |
| --- | --- |
| ![设置](https://github.com/user-attachments/assets/0813b5a4-41ce-4a13-b398-8e7bb213de64) | ![主题选择器](https://github.com/user-attachments/assets/90ecc674-1421-42a5-8c10-248697cce305) |

| 节目提醒 | 局域网设置 |
| --- | --- |
| ![节目提醒](https://github.com/user-attachments/assets/f48116a3-9553-4d22-b0b1-ebd09a477a5b) | ![局域网设置](https://github.com/user-attachments/assets/fda1f741-bf92-45fd-b7c5-e2ed555cdc92) |

## 功能

**播放列表和账号**

- **M3U 播放列表** — 支持加载多个 M3U/M3U8 播放列表并自动去重；播放源可临时停用，无需删除原有配置
- **Xtream Codes 账号** — 支持添加、临时停用账号，并可通过顶部栏头像快速切换；播放列表和 EPG 数据将根据账号凭据自动获取
- **局域网设置** — 扫描二维码后，即可通过同一局域网内的手机配置播放源和在线字幕，或上传 `.m3u` 文件（[局域网服务](docs/lan-service.md)）

**直播与视频点播**

- **节目指南（EPG）** — 采用三栏布局，自动生成日期范围，支持按播放源校正节目时间；数据经缓存后可快速再次打开
- **频道健康检查** — 检测直播流状态，并将频道标记为正常、可疑或不可用
- **节目提醒** — 为即将播出的节目设置提醒；即使应用已经关闭，也能在开播时收到通知并直接切换至对应频道
- **最近观看** — 快速返回最近收看的直播频道，或从上次进度继续播放回看节目
- **电影和剧集** — 浏览 Xtream 账号提供的视频点播（VOD）内容，并按账号分别维护“继续观看”和“稍后观看”列表
- **视频点播自动连播队列** — 自动接续播放后续剧集或“稍后观看”中的电影，并在播放完成后将其移出列表
- **回看与直播时移** — 播放已播出的节目；观看直播时可暂停、回退或一键返回直播点

**播放**

- **原生 HDR 与 Dolby 直通** — 视频流直接交由电视的原生解码器处理，完整保留 HDR10、HLG、Dolby Vision® 和 Dolby Atmos® — **[为何选择原生播放而非 hls.js？查看真机对比](docs/native-vs-hls.js.md)**
- **MPEG-DASH 播放** — `.mpd` 频道在 webOS 上使用原生媒体管线播放，在桌面预览中使用 dash.js；支持 MPD 轨道元数据、直播时移、自渲染原始 WebVTT 字幕，以及原生 IMSC/`stpp` 和 `wvtt` 字幕（[详情](docs/mpeg-dash.md)）
- **原生 PlayReady DRM** — 在兼容的 webOS 电视上，通过 LG DRM 服务和原生硬件媒体管线播放受保护的 MPEG-DASH 频道，并从 Kodi 风格的 M3U 属性读取授权设置（[详情](docs/mpeg-dash.md)）
- **音轨与字幕轨道** — 可从播放器菜单中选择，并按频道或点播项目分别记忆。直播字幕支持 HLS 清单内的 WebVTT 和 CEA-608/708；点播字幕支持内封字幕及外挂 SRT、WebVTT、ASS。还可通过 SubDL、OpenSubtitles 和 Assrt 在线搜索，或手动输入片名；即使媒体自带字幕，在线搜索仍然可用，并支持播放期间实时调整字幕同步
- **OSD（屏幕显示）** — 显示节目名称、播放进度及码流信息，包括分辨率、HDR、帧率、编解码器和音频声道
- **自动播放故障恢复** — 检测无法开始播放或播放卡住的流，自动重新加载临时故障；若多次恢复失败，则切换至下一个直播频道
- **音视频重新同步**（🔄）— 长时间播放回看或点播内容后若出现音画不同步，可通过播放控制栏一键重新同步

**导航**

- **全局搜索** — 同时搜索频道、EPG 节目、电影和剧集，并可从搜索结果直接观看直播、播放回看或设置提醒
- **频道侧边栏** — 无需离开播放画面即可按分组切换频道，并查看当前节目信息
- **频道自定义** — 支持调整顺序、隐藏、重命名、重新分组和管理收藏，还可修正各频道的 EPG 匹配及时间偏差
- **自动播放与类型分组图标** — 让内容浏览更加快捷
- **全面支持 LG 遥控器与动感遥控器** — 所有界面均支持方向键空间导航和指针操作
- **多款配色主题** — 可实时预览并选择全局浅色或深色主题，播放器浮层另有深色和毛玻璃样式可选；所有选择均会自动保存
- **文字大小可调** — 在不改变控件尺寸的前提下，可将文字缩放至 80%–150%
- **多语言界面** — 支持 English、Deutsch、Español、Français、Italiano、Português (Brasil)、Русский、Українська 和简体中文；默认跟随电视的系统语言，也可在设置中手动指定

**开发**

- **桌面预览** — 使用 HLS.js、mpegts.js 和 dash.js 在浏览器中预览和调试播放效果

## 支持的 webOS 版本

本应用支持 **webOS 4.0（2018 年）及以上版本**，最低兼容基线为 webOS 4
所搭载的 Chromium 53。后续 webOS 版本均采用更新的 Chromium 内核，因此
可保持向前兼容。对于 flex `gap`、`backdrop-filter` 等仅由较新内核原生
支持的特性，应用会通过特性检测在旧版系统上启用兼容方案。

| webOS 版本 | 发布年份 | Chromium 引擎 | 内置服务 Node.js | 支持状态 |
| --- | --- | --- | --- | --- |
| webOS 4.x | 2018–2019 | 53 | 0.12.2 | ✅（最低版本） |
| webOS 5.0 | 2020 | 68 | 8.12.0 | ✅ |
| webOS 6.0 | 2021 | 79 | 8.12.0 | ✅ |
| webOS 22 | 2022 | 87 | 12.21.0 | ✅ |
| webOS 23 | 2023 | 94 | 12.22.2 | ✅ |
| webOS 24 | 2024 | 108 | 16.19.1 | ✅ |
| webOS 25 | 2025 | 120 | 16.20.2 | ✅ |
| webOS 26 | 2026 | 132 | 20.12.2 | ✅ |

不支持 webOS 3.x 及更早版本（Chromium 38 及更早版本）。

## 前置要求

通过命令行安装应用或在本地构建项目，需要
[Node.js](https://nodejs.org/)（v22 或更高版本）以及
[webOS CLI 工具](https://webostv.developer.lge.com/develop/tools/cli-installation)：

```bash
npm install -g @webos-tools/cli
```

仅通过 Homebrew Channel 添加软件源并安装应用时，无需准备上述工具。

## 安装到电视

### Homebrew Channel

首先安装社区维护的
[webOS Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel)，
然后打开 **Settings → Add repository** 并输入：

```text
https://raw.githubusercontent.com/lennylxx/webos-iptv-player/main/homebrew-repository.json
```

如果电脑已配置 `ares-cli`，可运行以下命令预填仓库地址：

```bash
ares-launch --device tv org.webosbrew.hbchannel -p '{"launchMode":"addRepository","url":"https://raw.githubusercontent.com/lennylxx/webos-iptv-player/main/homebrew-repository.json"}'
```

在电视上确认 **Add repository**。添加完成后，即可通过 Homebrew Channel
安装本应用，并在 GitHub 发布新版本后自动检测更新。

### 开发者模式

1. **下载应用安装包。** 在电脑上打开
   [Releases 页面](https://github.com/lennylxx/webos-iptv-player/releases/latest)，
   下载最新的 `.ipk` 文件。

2. **在电视上开启开发者模式。**
   - 在 [LG webOS Developer 网站](https://webostv.developer.lge.com/)免费注册账号。
   - 在电视上打开 **LG Content Store**，搜索并安装 **Developer Mode** 应用。
   - 使用 LG 开发者账号登录，将 **Dev Mode Status** 切换为 **ON**。
     电视随后会重启。请记下应用中显示的 **IP 地址**和**密码短语**。

3. **注册电视设备。** 将电视添加为名为 `tv` 的设备
   （请将示例 IP 替换为电视的实际地址）：

   ```bash
   ares-setup-device --add tv -i "username=prisoner" -i "host=127.0.0.1" -i "port=9922"
   ```

   然后获取设备密钥，并在提示时输入 Developer Mode 应用中显示的
   **密码短语**：

   ```bash
   ares-novacom --device tv --getkey
   ```

4. **安装应用。**

   ```bash
   ares-install --device tv ./com.lennylxx.iptv_<version>_all.ipk
   ```

## 开发

### 安装依赖

```bash
npm install
```

### 构建

```bash
./build.sh
```

### 构建并安装到电视

```bash
./build.sh --install [device-name]
```

如未指定设备名称，脚本将使用 `ares-setup-device` 中配置的默认设备。

### 在电视上调试

`scripts/tv.sh` 会自动读取 `ares-setup-device` 中默认设备的连接信息，
无需在命令中手动填写密钥或密码短语。

```bash
scripts/tv.sh logs --app com.lennylxx.iptv       # 实时查看应用的 DevTools 控制台
scripts/tv.sh eval 'document.visibilityState'    # 在应用页面中执行 JavaScript
scripts/tv.sh perf --duration 30                 # 采样 CPU、堆、DOM 和布局
scripts/tv.sh diag                               # 生成经过脱敏的诊断报告
scripts/tv.sh run 'uname -a'                     # 通过 SSH 在电视上执行命令
scripts/tv.sh push ./file.txt /tmp/file.txt      # 将本地文件复制到电视
scripts/tv.sh shell                              # 打开交互式 SSH 会话
TV_DEVICE=tv2 scripts/tv.sh logs                 # 选择非默认的已配置电视
```

运行 `scripts/tv.sh perf --help` 或 `scripts/tv.sh diag --help`
可查看数据采集和输出选项。

### 在浏览器中预览

```bash
npm run preview
```

预览服务将在 http://localhost:3000 打开。桌面端分别通过 HLS.js、
mpegts.js 和 dash.js 播放相应格式的视频。

## 设置

按遥控器上的**蓝色键**，或选择顶部栏中的**设置**标签页即可进入设置。
各项功能如下：

- **语言** — 默认跟随电视的系统语言，也可手动指定界面语言。
- **使用手机或电脑设置** — 扫描二维码后通过手机配置应用，或在电脑上打开页面并输入配对码。
- **Xtream 账号** — 添加、编辑、删除或临时停用账号；检查登录信息、连接占用和到期时间；为直播流选择 TS、HLS 或自动格式。保存后，应用会根据账号信息自动获取播放列表和 EPG。
- **播放列表** — 添加、编辑、删除或临时停用 M3U 播放列表地址；更改将在保存后生效。
- **上传播放列表** — 显示通过“设备设置”页面上传的播放列表，并可临时停用或删除。新的上传会通过 Luna 消息自动同步到列表中。
- **频道** — 检查直播流健康状态；调整频道顺序，隐藏、重命名或重新分组频道；手动匹配 XMLTV 频道，或校正单个频道的 EPG 时间；还可显示隐藏频道或重置所有自定义设置。
- **XMLTV 网址** — 设置节目指南地址；应用也会自动读取 M3U 播放列表中的 `url-tvg`、`x-tvg-url` 或 `tvg-url`。
- **节目指南时区** — 选择以电视的**设备**时区或节目指南的**节目源**时区显示节目时间。
- **EPG 时间校正** — 以 15 分钟为步长，分别校正各播放源的节目时间。
- **节目提醒** — 打开按日期分组的节目提醒管理器，查看或移除尚未播出的提醒。
- **外观** — 实时预览应用配色主题，选择深色或毛玻璃播放器浮层，并在 80%–150% 范围内调整文字大小。
- **播放** — 控制是否在应用启动后自动播放上次观看的频道。
- **在线字幕** — 选择首选字幕语言，并配置 SubDL、OpenSubtitles 和 Assrt 的在线搜索凭据。
- **数据管理** — 刷新数据、清除缓存或观看记录，以及重置应用。
- **保存更改**会应用当前设置；播放源发生变化时，还会重新加载播放列表和节目指南。选择**取消**则放弃本次修改。

## 遥控器按键映射

| 按键 | 播放器 | 频道列表 | EPG |
| --- | --- | --- | --- |
| 上/下 | 切换至上一个/下一个频道 | 移动焦点 | 在当前栏内移动焦点 |
| 左 | 打开侧边栏并进入分组；支持时后退 30 秒 | 移至分组栏 | 切换至上一栏或前一天 |
| 右 | 打开菜单；支持时前进 30 秒 | 移至频道栏 | 切换至下一栏、后一天或节目提醒 |
| 确定/Enter | 显示或隐藏 OSD；暂停或继续播放；操作浮层控件 | 播放所选频道 | 播放频道或节目，或打开节目提醒 |
| 返回 | 逐级关闭侧边栏或菜单；停止播放并返回 | 连按两次退出应用 | 关闭节目指南 |
| 红色键 | 打开 EPG | 打开 EPG | — |
| 蓝色键 | 打开设置 | 打开设置 | 打开设置 |
| 黄色键 | 显示 OSD | 编辑频道列表 | 搜索节目 |
| 绿色键 | 收藏或取消收藏（侧边栏/菜单中） | 收藏或取消收藏当前频道 | 跳转至今天 |
| 播放/暂停 | 暂停/继续播放 | — | — |
| 快退/快进 | 跳至最早可播放位置/返回直播（直播 DVR） | — | — |
| 频道 +/- | 切换至上一个/下一个频道 | 切换至上一个/下一个频道 | 每次跳转 10 个频道或节目 |
| 0–9 | 输入频道号直接跳转 | 输入频道号直接跳转 | — |

电影、剧集、搜索、设置和节目提醒界面均使用标准方向键导航；
按**返回**键可返回上一级界面。

## 技术文档

以下文档面向项目贡献者，深入介绍部分功能的实现方式及 webOS
平台特有行为：

- [`docs/native-vs-hls.js.md`](docs/native-vs-hls.js.md) — 真机为何使用原生 `<video>` 媒体管线而非 hls.js，以及 HDR 和 Dolby 直通的实现原理
- [`docs/audio-track-selection.md`](docs/audio-track-selection.md) — 原生 webOS 播放器的音轨切换机制
- [`docs/hls-subtitles.md`](docs/hls-subtitles.md) — webOS 上的直播 HLS 字幕处理方式，包括清单内字幕格式及其渲染路径
- [`docs/mpeg-dash.md`](docs/mpeg-dash.md) — DASH 格式检测、原生播放、字幕和直播 DVR 的实现
- [`docs/vod-subtitles.md`](docs/vod-subtitles.md) — Xtream 电影与剧集的字幕实现，包括容器内字幕、外挂 SRT/WebVTT/ASS 字幕，以及 SubDL、OpenSubtitles 和 Assrt 在线搜索
- [`docs/storage-and-data.md`](docs/storage-and-data.md) — 应用的数据存储范围与位置，以及用户数据和临时缓存的隔离方式
- [`docs/lan-service.md`](docs/lan-service.md) — 通过内置局域网服务完成手机端设置和 M3U 文件上传
