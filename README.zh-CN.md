<div align="center">
  <img src="assets/icon.svg" alt="webOS IPTV Player 图标">
  <h1>webOS IPTV Player</h1>
  <p>一款专为 LG webOS 电视打造的 IPTV 播放器，支持 M3U 播放列表、Xtream Codes 账号、XMLTV 节目指南（EPG）、回看及直播时移。</p>
  <p><strong>更多 webOS 工具：</strong> <a href="https://github.com/lennylxx/lg-devmode-forever">DevMode Forever</a> · <a href="https://github.com/lennylxx/lg-geolock-bypass">GeoLock Bypass</a> · <a href="https://github.com/lennylxx/lg-ipk-download">IPK Download</a></p>
  <p><a href="README.md">English</a> | 简体中文</p>
  <p>
  <a href="#支持的-webos-版本"><img src="https://img.shields.io/badge/webOS-4%2B-e6007e?logo=webos&logoColor=white" alt="webOS 4+"></a>
  <a href="https://github.com/lennylxx/webos-iptv-player/releases/latest"><img src="https://img.shields.io/github/v/release/lennylxx/webos-iptv-player" alt="最新版本"></a>
  <a href="https://github.com/lennylxx/webos-iptv-player/releases"><img src="https://img.shields.io/github/downloads/lennylxx/webos-iptv-player/total" alt="GitHub 下载量"></a>
  <a href="https://lennylxx.github.io/webos-iptv-player/"><img src="https://img.shields.io/badge/Website-222?logo=github" alt="项目网站"></a>
  </p>
</div>

## 截图

| 频道列表 | 直播预览 |
| --- | --- |
| ![频道列表](https://github.com/user-attachments/assets/adb1ff15-1da3-479f-8a2f-0486dca5b082) | ![直播预览](https://github.com/user-attachments/assets/a10915a7-cdea-4bfc-bb12-f6e3054b4b51) |

| 最近观看 | 节目指南 |
| --- | --- |
| ![最近观看](https://github.com/user-attachments/assets/ef7aa7a1-7c3e-4b59-8825-fe4a0a441a61) | ![节目指南](https://github.com/user-attachments/assets/63eb2cf3-af90-4e47-870c-51a913be2e74) |

| 回看续播 | 频道信息 |
| --- | --- |
| ![回看续播](https://github.com/user-attachments/assets/cd0ea029-4442-45d5-a2aa-5be8f8866d7a) | ![频道信息](https://github.com/user-attachments/assets/b6a469ff-8a57-4d8a-895f-48d44963c672) |

| 播放浮层 | 字幕 |
| --- | --- |
| ![播放浮层](https://github.com/user-attachments/assets/212bb843-fe74-4cd3-be2a-c91d797bd170) | ![字幕](https://github.com/user-attachments/assets/5d1fab57-1087-414b-9a20-f900589eac4a) |

| 字幕搜索 | 电影 |
| --- | --- |
| ![字幕搜索](https://github.com/user-attachments/assets/4ef9c97e-131b-4e4f-bf9a-c753d66f2956) | ![电影](https://github.com/user-attachments/assets/58292e7a-7c64-4eaa-bbb0-0ac4e0bb6486) |

| 电影详情 | 剧集详情 |
| --- | --- |
| ![电影详情](https://github.com/user-attachments/assets/87e7dbce-0e70-4619-af1b-62f512c907a0) | ![剧集详情](https://github.com/user-attachments/assets/d773b92d-26c0-4b37-893e-95810a146ea6) |

| 搜索 | 设置 |
| --- | --- |
| ![搜索](https://github.com/user-attachments/assets/0c6c54e2-6fb3-4fb2-a0da-7f6459815390) | ![设置](https://github.com/user-attachments/assets/b15ac979-37d9-4877-a50d-9f9c2e6d02d7) |

| 主题选择器 | 节目提醒 |
| --- | --- |
| ![主题选择器](https://github.com/user-attachments/assets/56629752-46dd-462e-9640-8cb6f6dd32ce) | ![节目提醒](https://github.com/user-attachments/assets/76ed121f-61eb-4c36-93a9-9aa6abdb0132) |

| 家长控制 | 局域网设置 |
| --- | --- |
| ![家长控制](https://github.com/user-attachments/assets/7f22d1c3-97bf-4118-a19f-3699bf2779ba) | ![局域网设置](https://github.com/user-attachments/assets/a618e22f-6dae-474d-870e-13aebc22bf63) |

## 功能

**播放列表和账号**

- **M3U 播放列表** — 支持加载多个 M3U/M3U8 播放列表并自动去重；播放源可临时停用，无需删除原有配置
- **Xtream Codes 账号** — 支持添加、临时停用账号，并可通过顶部栏头像快速切换；播放列表和 EPG 数据将根据账号凭据自动获取
- **局域网设置** — 扫描二维码后，即可通过同一局域网内的手机配置播放源和在线字幕，或上传 `.m3u` 文件（[局域网服务](docs/lan-service.md)）
- **定时刷新** — 频道列表、节目指南和 Xtream 电影/剧集目录可分别设置刷新周期，频道列表和节目指南也可关闭自动刷新；还可通过“刷新所有数据”随时手动重新加载

**直播与视频点播**

- **节目指南（EPG）** — 可选频道节目单或多频道时间轴，自动生成日期范围，支持按播放源校正节目时间；数据经缓存后可快速再次打开
- **频道健康检查** — 检测直播流状态，并将频道标记为正常、可疑或不可用
- **节目提醒** — 为即将播出的节目设置提醒；即使应用已经关闭，也能在开播时收到通知并直接切换至对应频道
- **最近观看** — 快速返回最近收看的直播频道，或从上次进度继续播放回看节目
- **播放列表中的电影文件** — 地址指向电影文件（`.mp4`、`.mkv` 等）的频道可以像点播一样拖动进度，并从上次位置继续播放
- **直播预览** — 浏览频道列表时在右侧持续播放，并提供节目信息和快捷控制
- **电影和剧集** — 浏览 Xtream 账号提供的视频点播（VOD）内容，并按账号分别维护“继续观看”和“稍后观看”列表
- **片库排序** — 电影和剧集可按名称、加入日期、评分或年份升序或降序排列，两个分区分别记住各自的排序方式
- **分类筛选、已看和隐藏** — 可按类型筛选分类，或在分类中搜索；电影或分集播放到结尾后自动标记为已观看，也可以手动标记电影、整部剧、整季或单集（绿色键）；电影和剧集可从浏览中隐藏，在“显示：已隐藏”中找回
- **管理“继续观看”和“稍后观看”** — 可逐个移除影片、清空整个列表，或在电影详情页清除观看进度
- **视频点播自动连播队列** — 自动接续播放后续剧集或“稍后观看”中的电影，并在播放完成后将其移出列表；“即将播放”卡片会倒计时进入下一部，播放器菜单还可直接切换到上一集或下一集
- **回看与直播时移** — 播放已播出的节目；观看直播时可暂停、回退或一键返回直播点；M3U 回看支持 `default`、`append`、`shift`、`archive`、`timeshift`、`vod`（XMLTV `catchup-id`）、Flussonic 及 Xtream（`xc`）格式（[详情](docs/catchup-formats.md)）
- **进度条预览** — 按下或按住左/右键移动跳转目标，按住越久步长越大，停止操作后一次性跳转；服务器提供缩略图时，气泡中会显示预览画面（支持 OTT Navigator `seek_preview`、Flussonic、Nimble 及 HLS/DASH 图像轨道）（[详情](docs/seek-preview.md)）
- **家长控制** — 使用 PIN 锁定直播分组、电影和剧集分类或单个节目，并建议锁定疑似成人内容的分组；锁定的内容可带锁显示或隐藏，并可设置何时再次要求输入 PIN

**播放**

- **原生 HDR 与 Dolby 直通** — 视频流直接交由电视的原生解码器处理，完整保留 HDR10、HLG、Dolby Vision® 和 Dolby Atmos® — **[为何选择原生播放而非 hls.js？查看真机对比](docs/native-vs-hls.js.md)**
- **MPEG-DASH 播放** — 明文和 PlayReady `.mpd` 频道使用 webOS 原生媒体管线，Widevine/ClearKey 频道按需启用 Shaka MSE/EME；支持 MPD 轨道元数据、直播时移和字幕（[详情](docs/mpeg-dash.md)）
- **原生 PlayReady DRM** — 在兼容的 webOS 电视上，通过 LG DRM 服务和原生硬件媒体管线播放受保护的 MPEG-DASH 频道，并从 Kodi 风格的 M3U 属性读取授权设置（[详情](docs/mpeg-dash.md)）
- **Widevine / ClearKey DRM** — 按需加载 Shaka DASH-only 引擎，支持 Kodi 风格的授权地址、请求头和经过校验的 ClearKey 内联密钥（[详情](docs/mpeg-dash.md)）
- **频道 HTTP 请求头** — M3U 中设置了 Referer、User-Agent、Cookie 或 Authorization 的频道，会携带这些请求头通过电视的媒体服务播放，也可选择通过本地代理播放（[详情](docs/http-header-playback.md)）
- **音轨与字幕轨道** — 可从播放器菜单中选择，并按频道或点播项目分别记忆。直播字幕支持 HLS 清单内的 WebVTT 和 CEA-608/708；点播字幕支持内封字幕及外挂 SRT、WebVTT、ASS。还可通过 SubDL、OpenSubtitles 和 Assrt 在线搜索，或手动输入片名；即使媒体自带字幕，在线搜索仍然可用，并支持播放期间实时调整字幕同步
- **播放速度** — 电影和剧集可选择 0.5×–2×，适用于 MP4、MKV 等文件格式；直播、回看及 HLS/DASH 流始终以正常速度播放，因为 webOS 原生播放管线会忽略这些内容的变速请求
- **画面比例** — 可在播放器菜单中选择自动、16:9、4:3 或缩放，并按频道、电影或剧集分别记忆；在电视上会直接设置电视为本应用保存的画面比例，更细致的调整仍可在电视自带的画面比例菜单中完成
- **画质** — 可在设置中选择默认画质（自动、最高画质、最高 4K、最高 1080p、最高 720p 或最低画质），也可在播放器菜单中为频道、电影或剧集单独指定一档；适用于所有播放路径下的 HLS 和 DASH，包括需要 HTTP 请求头的频道和 DRM 加密流
- **OSD（屏幕显示）** — 显示节目名称、播放进度及码流信息，包括分辨率、HDR、帧率、编解码器和音频声道；控制栏自动隐藏时间和频道号码输入超时均可调整
- **自动播放故障恢复** — 检测无法开始播放或播放卡住的流，自动重新加载临时故障；达到可设置的重连次数后，自动切换至下一个直播频道
- **音视频重新同步**（🔄）— 长时间播放回看或点播内容后若出现音画不同步，可通过播放控制栏一键重新同步

**导航**

- **全局搜索** — 同时搜索频道、EPG 节目、电影和剧集，每类列出最匹配的 100 项，并可从搜索结果直接观看直播、播放回看或设置提醒；搜索框下方会列出最近搜索，一键即可再次搜索；搜索索引会在后台预先构建并缓存，打开搜索几乎无需等待
- **频道侧边栏** — 无需离开播放画面即可按分组切换频道，并查看当前节目信息
- **频道自定义** — 支持调整顺序、隐藏、重命名、重新分组和管理收藏，还可修正各频道的 EPG 匹配及时间偏差
- **自动播放与类型分组图标** — 让内容浏览更加快捷
- **数字键选台** — 在频道列表或播放界面按遥控器数字键输入频道号直接切换，并在屏幕上显示输入中的数字
- **全面支持 LG 遥控器与动感遥控器** — 所有界面均支持方向键空间导航和指针操作
- **动感遥控器边缘滚动** — 将指针停在片库或搜索结果横排、标签栏或节目指南日期栏的边缘即可自动滚动，停留越久滚动越快
- **多款配色主题** — 可实时预览并选择全局浅色或深色主题，播放器浮层另有深色和毛玻璃样式可选；所有选择均会自动保存
- **自定义主题** — 可基于任一主题创建最多 3 个自定义主题，调整强调色、背景色、层次感、文字对比度、焦点颜色与光晕、圆角、字体、播放器浮层不透明度与模糊，以及节目指南颜色；实时预览，并自动保证所有颜色清晰可读
- **文字大小可调** — 在不改变控件尺寸的前提下，可将文字缩放至 80%–150%
- **动画模式** — “基础”在较旧的电视上关闭高开销的动态效果，“均衡”保留视觉效果但立即滚动到焦点项，“完整”在单次导航时平滑滚动
- **多语言界面** — 支持 English、Deutsch、Español、Français、Italiano、Polski、Português (Brasil)、Русский、Türkçe、Українська 和简体中文；默认跟随电视的系统语言，也可在设置中手动指定

**开发**

- **桌面预览** — 使用 HLS.js、mpegts.js 和 Shaka 在浏览器中预览播放效果

## 不支持的功能与限制

部分功能受 webOS 平台限制或出于设计考虑而未提供，详见[完整列表](docs/unsupported-features.md)。

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
https://raw.githubusercontent.com/lennylxx/webos-homebrew/main/repository.json
```

如果电脑已配置 `ares-cli`，可运行以下命令预填仓库地址：

```bash
ares-launch --device tv org.webosbrew.hbchannel -p '{"launchMode":"addRepository","url":"https://raw.githubusercontent.com/lennylxx/webos-homebrew/main/repository.json"}'
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

Windows 请使用 WSL 2；不支持原生 Windows 环境。

`scripts/tv.sh` 会自动读取 `ares-setup-device` 中默认设备的连接信息，
无需在命令中手动填写密钥或密码短语。

```bash
scripts/tv.sh logs --app com.lennylxx.iptv       # 实时查看应用的 DevTools 控制台
scripts/tv.sh eval 'document.visibilityState'    # 在应用页面中执行 JavaScript
scripts/tv.sh perf --duration 30                 # 采样 CPU、堆、DOM 和布局
scripts/tv.sh diag                               # 生成经过脱敏的诊断报告
scripts/tv.sh capt screenshot screen.png         # 截取电视画面和应用 OSD
scripts/tv.sh capt record screen.mp4             # 录制 10 秒电视画面，约 5 fps，无音频
scripts/tv.sh input key down ok red              # 按遥控器按键
scripts/tv.sh input click 700 450                # 移动 Magic Remote 指针并点击
scripts/tv.sh input wheel 3                      # 在指针处向下滚动滚轮 3 格
scripts/tv.sh input key power                    # 关闭电视
scripts/tv.sh input wake                         # 开启电视（Wake-on-LAN）
scripts/tv.sh run 'uname -a'                     # 通过 SSH 在电视上执行命令
scripts/tv.sh push ./file.txt /tmp/file.txt      # 将本地文件复制到电视
scripts/tv.sh pull /tmp/file.txt ./file.txt      # 将电视文件复制到本地
scripts/tv.sh shell                              # 打开交互式 SSH 会话
scripts/tv.sh reboot                             # 通过 Luna 重启电视
TV_DEVICE=tv2 scripts/tv.sh logs                 # 选择非默认的已配置电视
```

运行 `scripts/tv.sh logs --help`（`eval`、`perf`、`diag`、`capt`、`input`
同理）可查看相关选项。

### 在浏览器中预览

```bash
npm run preview
```

预览服务将在 http://localhost:3000 打开。桌面端分别通过 HLS.js、
mpegts.js 和 Shaka 播放相应格式的视频。

## 设置

按遥控器上的**蓝色键**，或选择顶部栏中的**设置**标签页即可进入设置。
各项功能如下：

- **语言** — 默认跟随电视的系统语言，也可手动指定界面语言。
- **使用手机或电脑设置** — 扫描二维码后通过手机配置应用，或在电脑上打开页面并输入配对码。
- **家长控制** — 设置 PIN；锁定直播分组、电影和剧集分类或单个节目；锁定的内容可带锁显示或隐藏，并可设置何时再次要求输入 PIN。
- **Xtream 账号** — 添加、编辑、删除或临时停用账号；检查登录信息、连接占用和到期时间；为直播流选择 TS、HLS 或自动格式；还可在**直播分类**中只加载选中的分类，并可选择自动显示新分类。保存后，应用会根据账号信息自动获取播放列表和 EPG。
- **播放列表** — 添加、编辑、删除或临时停用 M3U 播放列表地址；更改将在保存后生效。
- **上传播放列表** — 显示通过“使用手机或电脑设置”上传的播放列表，并可临时停用或删除。新的上传会通过 Luna 消息自动同步到列表中。
- **频道** — 检查直播流健康状态；调整频道顺序，隐藏、重命名或重新分组频道；手动匹配 XMLTV 频道，或校正单个频道的 EPG 时间；还可显示隐藏频道或重置所有自定义设置。
- **手动 XMLTV 源** — 可添加多个节目指南地址，按从上到下的顺序确定优先级，并为每个源选择适用于所有播放列表或指定播放列表。应用也会自动读取 M3U 播放列表中的 `url-tvg`、`x-tvg-url` 或 `tvg-url`。
- **节目指南布局** — **频道节目单**显示一个频道全天的节目；**时间轴**同时显示多个频道在同一时段的节目。
- **节目指南时区** — 选择以电视的**设备**时区或节目指南的**节目源**时区显示节目时间。
- **EPG 时间校正** — 以 15 分钟为步长，分别校正各播放源的节目时间。
- **节目提醒** — 打开按日期分组的节目提醒管理器，查看或移除尚未播出的提醒。
- **外观** — 实时预览应用配色主题，创建自定义主题，选择深色或毛玻璃播放器浮层，并在 80%–150% 范围内调整文字大小。
- **播放** — 控制启动时自动播放和直播预览，并选择频道上/下键是在全局频道列表中
  切换，还是限制在当前分组、收藏或播放列表内。
- **在线字幕** — 选择首选字幕语言，并配置 SubDL、OpenSubtitles 和 Assrt 的在线搜索凭据。
- **高级设置** — 自定义高级界面、播放和后台刷新行为。
- **数据管理** — 刷新数据、清除缓存或观看记录，以及重置应用。
- **保存更改**会应用当前设置；播放源发生变化时，还会重新加载播放列表和节目指南。选择**取消**则放弃本次修改。

## 遥控器按键映射

| 按键 | 播放器 | 频道列表 | EPG |
| --- | --- | --- | --- |
| 上/下 | 切换至上一个/下一个频道 | 移动焦点 | 在当前栏内移动焦点 |
| 左 | 打开侧边栏并进入分组；支持时后退 30 秒 | 移至分组栏 | 切换至上一栏或前一天 |
| 右 | 打开菜单；支持时前进 30 秒 | 移至频道栏 | 切换至下一栏、后一天或节目提醒 |
| 确定/Enter | 显示或隐藏 OSD；暂停或继续播放；操作浮层控件 | 播放所选频道 | 播放频道或节目，或打开节目提醒 |
| 返回 | 逐级关闭侧边栏或菜单，再隐藏暂停时的 OSD；停止播放并返回 | 连按两次退出应用 | 关闭节目指南 |
| 红色键 | 打开 EPG | 打开 EPG | 回到现在 |
| 蓝色键 | 打开设置 | 打开设置 | 打开设置 |
| 黄色键 | 显示 OSD | 编辑频道列表 | 搜索节目 |
| 绿色键 | 收藏或取消收藏（侧边栏/菜单中） | 收藏或取消收藏当前频道 | — |
| 播放/暂停 | 暂停/继续播放 | — | — |
| 快退/快进 | 跳至最早可播放位置/返回直播（直播 DVR） | — | — |
| 频道 +/- | 切换至上一个/下一个频道 | 切换至上一个/下一个频道 | 每次跳转 10 个频道或节目 |
| 0–9 | 输入频道号直接跳转 | 输入频道号直接跳转 | — |

在时间轴布局的节目指南中，上下键切换频道并停留在同一时间，左右键在节目之间移动并按半小时翻页，频道 +/- 整页翻动频道，翻离当前时间后，按红色键或点击时间刻度上的**回到现在**即可跳回。黄色键与频道节目单布局一样搜索节目，按名称筛选时间轴中的频道。

电影、剧集、搜索、设置和节目提醒界面均使用标准方向键导航；
按**返回**键可返回上一级界面。

## 技术文档

以下文档面向项目贡献者，深入介绍部分功能的实现方式及 webOS
平台特有行为：

- [`docs/native-vs-hls.js.md`](docs/native-vs-hls.js.md) — 真机为何使用原生 `<video>` 媒体管线而非 hls.js，以及 HDR 和 Dolby 直通的实现原理
- [`docs/audio-track-selection.md`](docs/audio-track-selection.md) — 原生 webOS 播放器的音轨切换机制
- [`docs/hls-subtitles.md`](docs/hls-subtitles.md) — webOS 上的直播 HLS 字幕处理方式，包括清单内字幕格式及其渲染路径
- [`docs/mpeg-dash.md`](docs/mpeg-dash.md) — DASH 格式检测、原生播放、字幕和直播 DVR 的实现
- [`docs/http-header-playback.md`](docs/http-header-playback.md) — 需要 Referer、User-Agent、Cookie 或 Authorization 的频道如何通过电视的媒体服务或本地代理播放
- [`docs/catchup-formats.md`](docs/catchup-formats.md) — M3U 回看的属性和格式，以及各格式如何生成回看地址
- [`docs/seek-preview.md`](docs/seek-preview.md) — 跳转目标及其加速机制的实现，以及支持哪些服务器的预览缩略图
- [`docs/vod-subtitles.md`](docs/vod-subtitles.md) — Xtream 电影与剧集的字幕实现，包括容器内字幕、外挂 SRT/WebVTT/ASS 字幕，以及 SubDL、OpenSubtitles 和 Assrt 在线搜索
- [`docs/storage-and-data.md`](docs/storage-and-data.md) — 应用的数据存储范围与位置，以及用户数据和临时缓存的隔离方式
- [`docs/lan-service.md`](docs/lan-service.md) — 通过内置局域网服务完成手机端设置和 M3U 文件上传
- [`docs/unsupported-features.md`](docs/unsupported-features.md) — webOS 不允许或有意不提供的功能，以及替代方案

## 许可证与第三方声明

本项目使用 [Apache-2.0](LICENSE) 许可证。第三方软件与图标保留各自的许可证，
详见[来源与署名清单](THIRD_PARTY_NOTICES.txt)。每次构建都会将 `LICENSE`、
`THIRD_PARTY_NOTICES.txt` 和 `licenses/` 目录放入 `dist/`，随安装包一起分发。
此清单仅覆盖正式安装包，不包含仅供本地开发的桌面预览播放库。
